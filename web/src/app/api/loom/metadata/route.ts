/**
 * GET /api/loom/metadata?url={loomShareUrl}
 * Fetches public metadata for a Loom video via the oEmbed API.
 * No Loom credentials required — oEmbed is public for share links.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";

export interface LoomMetadata {
  title: string;
  authorName: string;
  description: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  videoId: string | null;
  width: number | null;
  height: number | null;
}

async function handler(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url query param required" }, { status: 400 });
  }

  // Validate it looks like a Loom URL
  if (!/loom\.com\/(share|v)\//i.test(url)) {
    return NextResponse.json({ error: "Not a recognised Loom share URL" }, { status: 400 });
  }

  // Extract video ID for use in the response
  const idMatch = url.match(/loom\.com\/(?:share|v)\/([a-f0-9]+)/i);
  const videoId = idMatch?.[1] ?? null;

  const oembedUrl = `https://www.loom.com/v1/oembed?url=${encodeURIComponent(url)}`;

  let oembed: Record<string, unknown>;
  try {
    const res = await fetch(oembedUrl, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Loom oEmbed error (${res.status}) — the video may be private or deleted` },
        { status: 502 },
      );
    }
    oembed = await res.json();
  } catch (err) {
    return NextResponse.json({ error: `Loom fetch failed: ${String(err)}` }, { status: 502 });
  }

  const metadata: LoomMetadata = {
    title: (oembed.title as string) ?? "",
    authorName: (oembed.author_name as string) ?? "",
    description: (oembed.description as string) || null,
    thumbnailUrl: (oembed.thumbnail_url as string) ?? null,
    durationSeconds: typeof oembed.duration === "number" ? oembed.duration : null,
    videoId,
    width: typeof oembed.width === "number" ? oembed.width : null,
    height: typeof oembed.height === "number" ? oembed.height : null,
  };

  return NextResponse.json(metadata);
}

export const GET = withRequestLogging("api:loom/metadata", handler);
