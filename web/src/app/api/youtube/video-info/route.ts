/**
 * GET /api/youtube/video-info?videoId=VIDEO_ID
 * Fetches public metadata for a YouTube video via the Data API v3 videos.list.
 * No user OAuth required for public videos — uses server-side API key.
 * ADR-027: YouTube Source Ingestion
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";

export interface YouTubeVideoInfo {
  videoId: string;
  title: string;
  description: string | null;
  channelTitle: string;
  publishedAt: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  privacyStatus: string;
  liveBroadcastContent: string;
}

function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
}

async function handler(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId");
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Valid 11-character videoId required" }, { status: 400 });
  }

  const apiKey =
    req.nextUrl.searchParams.get("apiKey") ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "No Google API key configured. Add one in Connections → YouTube → Google API Key, or set GOOGLE_API_KEY on the server." },
      { status: 500 },
    );
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,contentDetails,status");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", apiKey);

  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    return NextResponse.json({ error: `YouTube API request failed: ${String(err)}` }, { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `YouTube API error (${res.status}): ${text.slice(0, 300)}` },
      { status: 502 },
    );
  }

  const data = await res.json();
  const item = data.items?.[0];
  if (!item) {
    return NextResponse.json(
      { error: "Video not found. It may be private, deleted, or the ID is incorrect." },
      { status: 404 },
    );
  }

  const snippet = item.snippet ?? {};
  const contentDetails = item.contentDetails ?? {};
  const status = item.status ?? {};

  const thumbnails = snippet.thumbnails ?? {};
  const thumbnailUrl: string | null =
    thumbnails.maxres?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null;

  const info: YouTubeVideoInfo = {
    videoId,
    title: snippet.title ?? "",
    description: snippet.description || null,
    channelTitle: snippet.channelTitle ?? "",
    publishedAt: snippet.publishedAt ?? new Date().toISOString(),
    durationSeconds: parseDuration(contentDetails.duration ?? ""),
    thumbnailUrl,
    privacyStatus: status.privacyStatus ?? "unknown",
    liveBroadcastContent: snippet.liveBroadcastContent ?? "none",
  };

  return NextResponse.json(info);
}

export const GET = withRequestLogging("api:youtube/video-info", handler);
