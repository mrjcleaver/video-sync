import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";

/**
 * Batch privacy status lookup for YouTube videos.
 *
 * POST body: { videoIds: string[] }
 * Response: { privacy: { [id]: "public"|"unlisted"|"private" }, missing: string[] }
 *
 * Batches into chunks of 50 IDs (YouTube Data API max for videos.list).
 * Each batch costs 1 quota unit.
 */

const BATCH_SIZE = 50;

async function handler(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const videoIds: string[] = Array.isArray(body?.videoIds) ? body.videoIds.filter((x: unknown) => typeof x === "string") : [];
  if (videoIds.length === 0) {
    return NextResponse.json({ privacy: {}, missing: [] });
  }

  const refreshToken = req.headers.get("x-youtube-refresh-token") || process.env.YOUTUBE_REFRESH_TOKEN;
  const clientId = req.headers.get("x-youtube-client-id") || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = req.headers.get("x-youtube-client-secret") || process.env.YOUTUBE_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    return NextResponse.json(
      { error: "YouTube credentials required via x-youtube-* headers" },
      { status: 400 },
    );
  }

  // Refresh access token
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return NextResponse.json({ error: `Token refresh failed (${tokenRes.status}): ${text}` }, { status: 502 });
    }
    accessToken = (await tokenRes.json()).access_token;
  } catch (err) {
    return NextResponse.json({ error: `Token refresh error: ${String(err)}` }, { status: 502 });
  }

  const privacy: Record<string, string> = {};
  const found = new Set<string>();

  for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
    const chunk = videoIds.slice(i, i + BATCH_SIZE);
    const idParam = chunk.join(",");
    try {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(idParam)}`;
      const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        const text = await res.text();
        return NextResponse.json({ error: `YouTube API error (${res.status}): ${text}` }, { status: 502 });
      }
      const data = await res.json();
      const items: Array<{ id: string; status?: { privacyStatus?: string } }> = data.items ?? [];
      for (const item of items) {
        if (item.id && item.status?.privacyStatus) {
          privacy[item.id] = item.status.privacyStatus;
          found.add(item.id);
        }
      }
    } catch (err) {
      return NextResponse.json({ error: `YouTube status batch error: ${String(err)}` }, { status: 502 });
    }
  }

  const missing = videoIds.filter(id => !found.has(id));
  return NextResponse.json({ privacy, missing });
}

export const POST = withRequestLogging("api:youtube/privacy-batch", handler);
