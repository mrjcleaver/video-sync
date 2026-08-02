/**
 * GET /api/youtube/transcript?videoId=<videoId>
 *
 * Progressive-reach YouTube transcript fetcher used when a catalog
 * record has a YouTube location but no local `transcript_text` (own
 * or borrowed via ADR-053). Returns caption cues rendered as
 * `[HH:MM:SS] line` — the same shape ADR-046 / ADR-059 expect.
 *
 * Reach order (falls through on failure of the previous):
 *   1. Official YouTube Data API — captions.list + captions.download.
 *      Requires the OAuth-authorised account to own the video. Cheap
 *      and reliable for our own uploads.
 *   2. Public timedtext scrape — the same endpoint the YouTube web
 *      player uses to render captions. Works for any video whose
 *      creator enabled captions (manual or auto). Slightly fragile;
 *      YouTube can change the response shape unannounced.
 *   3. yt-dlp --write-auto-subs shell-out — battle-tested last
 *      resort. Slower and pulls the sub file to /tmp.
 *
 * Response: { text, source: "captions_api" | "timedtext" | "yt_dlp",
 *             language, format } on success; { error, code, tried } on
 *             failure so the client can surface which fallbacks were
 *             attempted.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { captionsToTranscript } from "../../../../lib/srtConverter";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// yt-dlp needs a real browser identity to survive the "Sign in to confirm
// you're not a bot" gate that YouTube throws at cloud-IP requests. The UA
// alone isn't enough; we also rotate through non-web player clients whose
// caption tracks are still fetchable without a PoToken.
const YT_DLP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const YT_DLP_CLIENT_STRATEGIES: Array<{ label: string; args: string[] }> = [
  { label: "android", args: ["--extractor-args", "youtube:player_client=android"] },
  { label: "ios",     args: ["--extractor-args", "youtube:player_client=ios"] },
  { label: "tv",      args: ["--extractor-args", "youtube:player_client=tv_embedded,tv"] },
  { label: "web+ua",  args: ["--user-agent", YT_DLP_UA] },
];

interface Tried {
  step: "captions_api" | "timedtext" | "yt_dlp";
  ok: boolean;
  reason?: string;
}

async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch { return null; }
}

interface CaptionTrack { id: string; language: string; trackKind?: string; }

async function tryCaptionsApi(videoId: string, accessToken: string): Promise<
  { ok: true; text: string; language: string; format: string }
  | { ok: false; reason: string }
> {
  const listUrl = `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!listRes.ok) {
    return { ok: false, reason: `captions.list HTTP ${listRes.status}` };
  }
  const listData = await listRes.json() as { items?: Array<{ id?: string; snippet?: { language?: string; trackKind?: string } }> };
  const tracks: CaptionTrack[] = (listData.items ?? [])
    .map(it => ({ id: it.id ?? "", language: it.snippet?.language ?? "", trackKind: it.snippet?.trackKind }))
    .filter(t => t.id);
  if (tracks.length === 0) return { ok: false, reason: "no caption tracks" };
  // Prefer English standard track > any standard track > any track.
  const pick = tracks.find(t => t.language.startsWith("en") && t.trackKind !== "ASR")
             ?? tracks.find(t => t.trackKind !== "ASR")
             ?? tracks[0];
  const dlUrl = `https://www.googleapis.com/youtube/v3/captions/${encodeURIComponent(pick.id)}?tfmt=vtt`;
  const dlRes = await fetch(dlUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!dlRes.ok) {
    return { ok: false, reason: `captions.download HTTP ${dlRes.status} (needs channel-owner auth)` };
  }
  const raw = await dlRes.text();
  const text = captionsToTranscript(raw);
  if (!text || text.length < 50) return { ok: false, reason: "empty caption body" };
  return { ok: true, text, language: pick.language || "unknown", format: "vtt" };
}

async function tryTimedtext(videoId: string): Promise<
  { ok: true; text: string; language: string; format: string }
  | { ok: false; reason: string }
> {
  // YouTube's unauthenticated `type=list` endpoint has been silently
  // returning empty bodies for cloud-IP requests since late 2024. The
  // only surface that still gives up caption baseUrls without a browser
  // is the InnerTube player endpoint — the same one the YouTube web
  // player calls internally. We hit it with the ANDROID client, which
  // still tolerates unauthenticated calls at time of writing (2026-08).
  const INNERTUBE_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w"; // public ANDROID client key
  const playerUrl = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`;
  const body = {
    videoId,
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "19.09.37",
        androidSdkVersion: 30,
        hl: "en",
        gl: "US",
      },
    },
  };
  let playerRes: Response;
  try {
    playerRes = await fetch(playerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, reason: `innertube fetch error: ${String(err).slice(0, 120)}` };
  }
  if (!playerRes.ok) return { ok: false, reason: `innertube HTTP ${playerRes.status}` };
  interface InnertubeCaptionTrack { baseUrl?: string; languageCode?: string; kind?: string; }
  interface InnertubeResponse {
    playabilityStatus?: { status?: string; reason?: string };
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: InnertubeCaptionTrack[];
      };
    };
  }
  let data: InnertubeResponse;
  try {
    data = await playerRes.json() as InnertubeResponse;
  } catch (err) {
    return { ok: false, reason: `innertube json parse: ${String(err).slice(0, 120)}` };
  }
  if (data.playabilityStatus?.status && data.playabilityStatus.status !== "OK") {
    const reason = data.playabilityStatus.reason ?? data.playabilityStatus.status;
    return { ok: false, reason: `innertube playability ${data.playabilityStatus.status}: ${reason}` };
  }
  const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) return { ok: false, reason: "innertube returned no caption tracks" };
  // Prefer manual English > any English > first available.
  const pick = tracks.find(t => (t.languageCode ?? "").startsWith("en") && t.kind !== "asr")
             ?? tracks.find(t => (t.languageCode ?? "").startsWith("en"))
             ?? tracks[0];
  if (!pick.baseUrl) return { ok: false, reason: "innertube track had no baseUrl" };
  // InnerTube gives XML by default; append &fmt=vtt for the format
  // captionsToTranscript understands directly.
  const capUrl = pick.baseUrl.includes("fmt=") ? pick.baseUrl : `${pick.baseUrl}&fmt=vtt`;
  let capRes: Response;
  try {
    capRes = await fetch(capUrl, {
      headers: { "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip" },
    });
  } catch (err) {
    return { ok: false, reason: `caption body fetch: ${String(err).slice(0, 120)}` };
  }
  if (!capRes.ok) return { ok: false, reason: `caption body HTTP ${capRes.status}` };
  const raw = await capRes.text();
  if (!raw || raw.length < 50) return { ok: false, reason: "empty caption body" };
  const text = captionsToTranscript(raw);
  if (!text || text.length < 50) return { ok: false, reason: "caption parsed empty" };
  return { ok: true, text, language: pick.languageCode ?? "unknown", format: "vtt" };
}

async function runYtDlpStrategy(videoId: string, tmp: string, extraArgs: string[]): Promise<
  { ok: true; vtt: string } | { ok: false; reason: string }
> {
  const args = [
    "--write-auto-subs",
    "--write-subs",
    "--sub-lang", "en.*,en",
    "--sub-format", "vtt/best",
    "--skip-download",
    "--no-warnings",
    "--no-progress",
    "-o", path.join(tmp, "%(id)s.%(ext)s"),
    ...extraArgs,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  // Honour an operator-provided cookies.txt (e.g. mounted via Cloud Run
  // secret volume). Lets Cloud Run survive the LOGIN_REQUIRED gate by
  // presenting a signed-in Google session to YouTube.
  const cookiesFile = process.env.YOUTUBE_COOKIES_FILE;
  if (cookiesFile) args.splice(args.length - 1, 0, "--cookies", cookiesFile);

  let stderr = "";
  const code = await new Promise<number>((resolve) => {
    const p = spawn("yt-dlp", args, { stdio: ["ignore", "ignore", "pipe"] });
    p.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    p.on("error", () => resolve(-1));
    p.on("exit", (c) => resolve(c ?? -1));
  });

  // Clean up any old vtt files from a prior strategy so we don't
  // false-succeed by reading an earlier attempt's output.
  const files = (await fs.readdir(tmp).catch(() => [] as string[]));
  const vtt = files.find(f => f.endsWith(".vtt"));
  if (code !== 0) {
    const tail = stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 240);
    return { ok: false, reason: `exit ${code}${tail ? `: ${tail}` : ""}` };
  }
  if (!vtt) return { ok: false, reason: "no vtt file produced" };
  return { ok: true, vtt: path.join(tmp, vtt) };
}

async function tryYtDlp(videoId: string): Promise<
  { ok: true; text: string; language: string; format: string }
  | { ok: false; reason: string }
> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "yt-transcript-"));
  const failures: string[] = [];
  try {
    for (const strat of YT_DLP_CLIENT_STRATEGIES) {
      const r = await runYtDlpStrategy(videoId, tmp, strat.args);
      if (r.ok) {
        const raw = await fs.readFile(r.vtt, "utf8");
        if (!raw || raw.length < 50) {
          failures.push(`${strat.label}: empty vtt`);
          await fs.rm(r.vtt).catch(() => {});
          continue;
        }
        const text = captionsToTranscript(raw);
        if (!text || text.length < 50) {
          failures.push(`${strat.label}: vtt parsed empty`);
          await fs.rm(r.vtt).catch(() => {});
          continue;
        }
        return { ok: true, text, language: "en", format: `vtt (via ${strat.label})` };
      }
      failures.push(`${strat.label}: ${r.reason}`);
    }
    return { ok: false, reason: `all yt-dlp clients failed — ${failures.join(" · ")}` };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function handler(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("videoId");
  if (!raw) {
    return NextResponse.json({ error: "videoId query param required" }, { status: 400 });
  }
  // Callers may pass the "youtube-<id>" source-id form; strip so the
  // downstream YouTube surfaces see a bare id like "H75x9DKqkOM".
  const videoId = raw.startsWith("youtube-") ? raw.slice("youtube-".length) : raw;

  const tried: Tried[] = [];

  // Reach 1 — official captions API. Only attempted when we have creds.
  const refreshToken = req.headers.get("x-youtube-refresh-token") || process.env.YOUTUBE_REFRESH_TOKEN;
  const clientId = req.headers.get("x-youtube-client-id") || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = req.headers.get("x-youtube-client-secret") || process.env.YOUTUBE_CLIENT_SECRET;
  if (refreshToken && clientId && clientSecret) {
    const accessToken = await refreshAccessToken(refreshToken, clientId, clientSecret);
    if (!accessToken) {
      tried.push({ step: "captions_api", ok: false, reason: "OAuth refresh failed" });
    } else {
      const r = await tryCaptionsApi(videoId, accessToken);
      if (r.ok) {
        serverLog("info", "yt:transcript", "captions_api ok", { videoId, len: r.text.length });
        return NextResponse.json({ text: r.text, source: "captions_api", language: r.language, format: r.format, tried: [...tried, { step: "captions_api", ok: true }] });
      }
      tried.push({ step: "captions_api", ok: false, reason: r.reason });
    }
  } else {
    tried.push({ step: "captions_api", ok: false, reason: "no OAuth headers" });
  }

  // Reach 2 — public timedtext.
  const t2 = await tryTimedtext(videoId);
  if (t2.ok) {
    serverLog("info", "yt:transcript", "timedtext ok", { videoId, len: t2.text.length });
    return NextResponse.json({ text: t2.text, source: "timedtext", language: t2.language, format: t2.format, tried: [...tried, { step: "timedtext", ok: true }] });
  }
  tried.push({ step: "timedtext", ok: false, reason: t2.reason });

  // Reach 3 — yt-dlp.
  const t3 = await tryYtDlp(videoId);
  if (t3.ok) {
    serverLog("info", "yt:transcript", "yt_dlp ok", { videoId, len: t3.text.length });
    return NextResponse.json({ text: t3.text, source: "yt_dlp", language: t3.language, format: t3.format, tried: [...tried, { step: "yt_dlp", ok: true }] });
  }
  tried.push({ step: "yt_dlp", ok: false, reason: t3.reason });

  serverLog("warn", "yt:transcript", "all reach steps failed", { videoId, tried });
  return NextResponse.json(
    { error: "No transcript could be fetched from YouTube (all fallbacks exhausted)", code: "no_transcript", tried },
    { status: 404 },
  );
}

export const GET = withRequestLogging("api:youtube/transcript", handler);
