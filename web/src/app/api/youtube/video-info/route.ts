/**
 * GET /api/youtube/video-info?videoId=VIDEO_ID
 * Fetches public metadata for a YouTube video via the Data API v3 videos.list.
 * No user OAuth required for public videos — uses server-side API key.
 * ADR-027: YouTube Source Ingestion
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";

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

  // ADR-054 fallback chain — per-operator query-param key wins, then
  // the org-wide shared default (Secret Manager), then the legacy
  // env-var path. The shared default is what Admin sets via
  // Connections → YouTube → "Set as shared default".
  const sharedYouTube = await getSharedCredential("youtube").catch(() => null);
  const apiKey =
    req.nextUrl.searchParams.get("apiKey") ||
    (sharedYouTube as { googleApiKey?: string } | null)?.googleApiKey ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "No Google API key configured. Ask an Admin to set the shared default in Connections → YouTube → Set as shared default, or add a personal override in Connections → YouTube → Override locally → Google API Key." },
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
