import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";

/**
 * Enumerate the authorized channel's uploads for Recover lookup.
 *
 * GET → { channelId, channelTitle, uploads: [{ id, title, publishedAt, privacyStatus }] }
 *
 * Quota: 1 unit (channels.list) + ~N/50 units (playlistItems.list) + ~N/50 units
 * (videos.list for privacy). ~40 units for a 1000-video channel.
 */

async function handler(req: NextRequest) {
  const refreshToken = req.headers.get("x-youtube-refresh-token") || process.env.YOUTUBE_REFRESH_TOKEN;
  const clientId = req.headers.get("x-youtube-client-id") || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = req.headers.get("x-youtube-client-secret") || process.env.YOUTUBE_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    return NextResponse.json({ error: "YouTube credentials required" }, { status: 400 });
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

  const authHeader = { Authorization: `Bearer ${accessToken}` };

  // 1. Get authorized channel + uploads playlist ID
  let uploadsPlaylistId: string;
  let channelId = "";
  let channelTitle = "";
  try {
    const res = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&mine=true",
      { headers: authHeader },
    );
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `channels.list failed (${res.status}): ${text}` }, { status: 502 });
    }
    const data = await res.json();
    const ch = data.items?.[0];
    if (!ch) return NextResponse.json({ error: "No channel found for this account" }, { status: 404 });
    uploadsPlaylistId = ch.contentDetails.relatedPlaylists.uploads;
    channelId = ch.id;
    channelTitle = ch.snippet?.title ?? "";
  } catch (err) {
    return NextResponse.json({ error: `channels.list error: ${String(err)}` }, { status: 502 });
  }

  // 2. Paginate playlistItems to collect all video IDs + snippets
  const uploads: Array<{ id: string; title: string; publishedAt: string; privacyStatus?: string }> = [];
  let pageToken: string | undefined = undefined;
  try {
    while (true) {
      const url: string = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploadsPlaylistId)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const res: Response = await fetch(url, { headers: authHeader });
      if (!res.ok) {
        const text = await res.text();
        return NextResponse.json({ error: `playlistItems.list failed (${res.status}): ${text}` }, { status: 502 });
      }
      const data: { items?: Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string }; snippet?: { title?: string; publishedAt?: string } }>; nextPageToken?: string } = await res.json();
      for (const item of data.items ?? []) {
        const vid = item.contentDetails?.videoId;
        if (!vid) continue;
        uploads.push({
          id: vid,
          title: item.snippet?.title ?? "",
          publishedAt: item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? "",
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
  } catch (err) {
    return NextResponse.json({ error: `playlistItems error: ${String(err)}` }, { status: 502 });
  }

  // 3. Batch videos.list for privacy status (50 per call)
  try {
    for (let i = 0; i < uploads.length; i += 50) {
      const chunk = uploads.slice(i, i + 50);
      const ids = chunk.map(u => u.id).join(",");
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(ids)}`,
        { headers: authHeader },
      );
      if (!res.ok) continue; // non-fatal: privacy just stays undefined
      const data = await res.json();
      const statusById: Record<string, string> = {};
      for (const item of data.items ?? []) {
        if (item.id && item.status?.privacyStatus) statusById[item.id] = item.status.privacyStatus;
      }
      for (const u of chunk) {
        if (statusById[u.id]) u.privacyStatus = statusById[u.id];
      }
    }
  } catch {
    // non-fatal: return what we have
  }

  return NextResponse.json({ channelId, channelTitle, uploads });
}

export const GET = withRequestLogging("api:youtube/channel-uploads", handler);
