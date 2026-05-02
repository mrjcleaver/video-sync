/**
 * GET /api/loom/metadata?url={loomShareUrl}
 *
 * Fetches public metadata for a Loom video. Two sources, merged:
 *   1. Loom's oEmbed endpoint                — title, description, duration,
 *                                              thumbnail, dimensions
 *   2. Loom share-page __APOLLO_STATE__      — createdAt, transcript text,
 *                                              owner (name/email), language,
 *                                              chapters/markers
 *
 * The Apollo scrape is best-effort: if the page format changes or the
 * blob is missing we still return the oEmbed fields. No Loom credentials
 * required — both endpoints are public for share links.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

export interface LoomChapter {
  time: number;        // seconds
  title: string;
}

export interface LoomMetadata {
  title: string;
  authorName: string;
  description: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  videoId: string | null;
  width: number | null;
  height: number | null;
  // Apollo-state extras (any may be null if scrape failed or field absent)
  createdAt: string | null;
  transcriptText: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  language: string | null;
  chapters: LoomChapter[] | null;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface ApolloScrape {
  createdAt: string | null;
  transcriptText: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  language: string | null;
  chapters: LoomChapter[] | null;
}

const EMPTY_SCRAPE: ApolloScrape = {
  createdAt: null,
  transcriptText: null,
  ownerName: null,
  ownerEmail: null,
  language: null,
  chapters: null,
};

/**
 * Scrape the Loom share page's Apollo cache for metadata not exposed via
 * oEmbed. Defensive: every field falls back to null on any failure.
 */
async function scrapeLoomApolloState(shareUrl: string): Promise<ApolloScrape> {
  try {
    const pageRes = await fetch(shareUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!pageRes.ok) return EMPTY_SCRAPE;
    const html = await pageRes.text();
    const m = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]+?\});?\s*<\/script>/);
    if (!m) return EMPTY_SCRAPE;

    const cache = JSON.parse(m[1]) as Record<string, unknown>;
    const deref = (v: unknown): unknown => {
      if (!v || typeof v !== "object") return v;
      const obj = v as Record<string, unknown>;
      if (typeof obj.__ref === "string") return cache[obj.__ref];
      return v;
    };

    // Find the Video entity. Apollo keys it as `Video:<id>` typically;
    // some Loom pages use `RegularClipStory:` or similar. Match either
    // by key prefix or by an embedded createdAt + duration shape.
    let video: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(cache)) {
      if (!v || typeof v !== "object") continue;
      const val = v as Record<string, unknown>;
      if (k.startsWith("Video:") || k.startsWith("RegularClipStory:")) {
        video = val;
        break;
      }
      if (val.__typename === "Video" && typeof val.createdAt === "string") {
        video = val;
        break;
      }
    }
    if (!video) return EMPTY_SCRAPE;

    // createdAt
    const createdAt = typeof video.createdAt === "string" ? video.createdAt : null;

    // Owner — usually a __ref to User:<id>; sometimes inlined
    const ownerRaw = deref(video.owner ?? video.creator) as Record<string, unknown> | undefined;
    const ownerName = typeof ownerRaw?.fullName === "string"
      ? ownerRaw.fullName
      : typeof ownerRaw?.name === "string"
        ? ownerRaw.name
        : typeof ownerRaw?.displayName === "string"
          ? ownerRaw.displayName
          : null;
    const ownerEmail = typeof ownerRaw?.email === "string" ? ownerRaw.email : null;

    // Language
    const language = typeof video.language === "string"
      ? video.language
      : typeof video.transcriptLanguage === "string"
        ? video.transcriptLanguage
        : null;

    // Transcript — may be inline text or a __ref to Transcript:<id>;
    // segments may live as `transcript.segments[]` with `startTime`/`text`,
    // or under `transcriptSegments`, or directly as a `transcript` string.
    let transcriptText: string | null = null;
    const transcriptRaw = deref(video.transcript ?? video.transcriptText);
    if (typeof transcriptRaw === "string") {
      transcriptText = transcriptRaw;
    } else if (transcriptRaw && typeof transcriptRaw === "object") {
      const t = transcriptRaw as Record<string, unknown>;
      if (typeof t.text === "string") transcriptText = t.text;
      else if (Array.isArray(t.segments)) {
        const parts = t.segments
          .map((s) => deref(s))
          .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
          .map((s) => {
            const ts = typeof s.startTime === "number"
              ? formatTs(s.startTime)
              : typeof s.start === "number"
                ? formatTs(s.start)
                : "";
            const speaker = typeof s.speaker === "string" ? `${s.speaker}: ` : "";
            const text = typeof s.text === "string" ? s.text : "";
            return ts ? `[${ts}] ${speaker}${text}` : `${speaker}${text}`;
          })
          .filter(Boolean);
        if (parts.length > 0) transcriptText = parts.join("\n");
      }
    } else if (Array.isArray(video.transcriptSegments)) {
      const parts = video.transcriptSegments
        .map((s) => deref(s))
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => {
          const ts = typeof s.startTime === "number" ? formatTs(s.startTime) : "";
          const text = typeof s.text === "string" ? s.text : "";
          return ts ? `[${ts}] ${text}` : text;
        })
        .filter(Boolean);
      if (parts.length > 0) transcriptText = parts.join("\n");
    }

    // Chapters / markers — try a few shapes Loom has used.
    let chapters: LoomChapter[] | null = null;
    const candidateLists = [video.chapters, video.markers, video.bookmarks, video.timestamps];
    for (const list of candidateLists) {
      if (!Array.isArray(list)) continue;
      const items = list
        .map((entry) => deref(entry))
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .map((entry) => {
          const time = typeof entry.time === "number"
            ? entry.time
            : typeof entry.startTime === "number"
              ? entry.startTime
              : typeof entry.timestamp === "number"
                ? entry.timestamp
                : 0;
          const title = String(
            entry.title ?? entry.name ?? entry.label ?? entry.text ?? "",
          ).trim();
          return { time, title };
        })
        .filter((c) => c.title.length > 0);
      if (items.length > 0) {
        chapters = items;
        break;
      }
    }

    return { createdAt, transcriptText, ownerName, ownerEmail, language, chapters };
  } catch (err) {
    serverLog("warn", "ext:loom-apollo", "scrape failed", {
      error: String(err).slice(0, 200),
    });
    return EMPTY_SCRAPE;
  }
}

function formatTs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

async function handler(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url query param required" }, { status: 400 });
  }
  if (!/loom\.com\/(share|v)\//i.test(url)) {
    return NextResponse.json({ error: "Not a recognised Loom share URL" }, { status: 400 });
  }
  const idMatch = url.match(/loom\.com\/(?:share|v)\/([a-f0-9]+)/i);
  const videoId = idMatch?.[1] ?? null;

  // Fire oEmbed + Apollo scrape in parallel — both are independent.
  const oembedUrl = `https://www.loom.com/v1/oembed?url=${encodeURIComponent(url)}`;
  const [oembedResult, apolloResult] = await Promise.allSettled([
    fetch(oembedUrl, { headers: { Accept: "application/json" } }).then(async (r) => {
      if (!r.ok) throw new Error(`oEmbed ${r.status}`);
      return (await r.json()) as Record<string, unknown>;
    }),
    scrapeLoomApolloState(url),
  ]);

  if (oembedResult.status === "rejected") {
    return NextResponse.json(
      { error: `Loom oEmbed error — the video may be private or deleted (${oembedResult.reason})` },
      { status: 502 },
    );
  }
  const oembed = oembedResult.value;
  const apollo = apolloResult.status === "fulfilled" ? apolloResult.value : EMPTY_SCRAPE;

  const metadata: LoomMetadata = {
    title: (oembed.title as string) ?? "",
    authorName: (oembed.author_name as string) ?? "",
    description: (oembed.description as string) || null,
    thumbnailUrl: (oembed.thumbnail_url as string) ?? null,
    durationSeconds: typeof oembed.duration === "number" ? oembed.duration : null,
    videoId,
    width: typeof oembed.width === "number" ? oembed.width : null,
    height: typeof oembed.height === "number" ? oembed.height : null,
    createdAt: apollo.createdAt,
    transcriptText: apollo.transcriptText,
    ownerName: apollo.ownerName,
    ownerEmail: apollo.ownerEmail,
    language: apollo.language,
    chapters: apollo.chapters,
  };

  return NextResponse.json(metadata);
}

export const GET = withRequestLogging("api:loom/metadata", handler);
