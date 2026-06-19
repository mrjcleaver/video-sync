/**
 * GET /api/youtube/live-broadcasts
 *
 * Lists live broadcasts on the authorised channel — past, currently-live,
 * and upcoming. These are the entries the operator sees in YouTube
 * Studio's "Live" tab; the streaming-software (OBS / Streamyard /
 * Wirecast / vMix) workflow that ingests via YouTube Live's RTMP
 * endpoint produces VOD entries with `liveStreamingDetails` populated.
 *
 * Strategy: enumerate the channel's uploads playlist (cheap), then batch
 * videos.list with part=liveStreamingDetails,snippet,status,contentDetails
 * (50 per call) and filter to entries where liveStreamingDetails exists.
 *
 * We avoid liveBroadcasts.list because it requires the broader
 * youtube scope; this approach works with the readonly scope the app
 * already holds.
 *
 * Quota: ~5–10 units per 50 videos in the channel.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

export const dynamic = "force-dynamic";

interface BroadcastEntry {
  id: string;
  title: string;
  description: string | null;
  publishedAt: string;
  privacyStatus?: string;
  thumbnail_url: string | null;
  duration_seconds: number;
  // From liveStreamingDetails — the timestamps that distinguish a broadcast
  scheduledStartTime?: string;
  actualStartTime?: string;
  actualEndTime?: string;
  // "live" | "upcoming" | "completed" | "none" (none filtered out)
  liveBroadcastContent: "live" | "upcoming" | "completed" | "none";
  channel_title?: string;
}

function parseISO8601Duration(d: string | undefined): number {
  if (!d) return 0;
  const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

async function handler(req: NextRequest) {
  const url = new URL(req.url);
  const fromIso = url.searchParams.get("from"); // YYYY-MM-DD
  const toIso = url.searchParams.get("to");

  const refreshToken = req.headers.get("x-youtube-refresh-token") || process.env.YOUTUBE_REFRESH_TOKEN;
  const clientId = req.headers.get("x-youtube-client-id") || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = req.headers.get("x-youtube-client-secret") || process.env.YOUTUBE_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) {
    return NextResponse.json({ error: "YouTube credentials required" }, { status: 400 });
  }
  const rid = req.headers.get("x-request-id") ?? "n/a";

  // Refresh access token
  let accessToken: string;
  try {
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokRes.ok) {
      const text = await tokRes.text();
      return NextResponse.json({ error: `Token refresh (${tokRes.status}): ${text}` }, { status: 502 });
    }
    accessToken = (await tokRes.json()).access_token;
  } catch (err) {
    return NextResponse.json({ error: `Token refresh: ${String(err)}` }, { status: 502 });
  }

  const auth = { Authorization: `Bearer ${accessToken}` };

  // 1. channel → uploads playlist
  let uploadsPlaylistId: string;
  let channelId = "";
  let channelTitle = "";
  try {
    const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&mine=true", { headers: auth });
    if (!res.ok) {
      return NextResponse.json({ error: `channels.list (${res.status}): ${await res.text()}` }, { status: 502 });
    }
    const data = await res.json();
    const ch = data.items?.[0];
    if (!ch) return NextResponse.json({ error: "No channel for this account" }, { status: 404 });
    uploadsPlaylistId = ch.contentDetails.relatedPlaylists.uploads;
    channelId = ch.id;
    channelTitle = ch.snippet?.title ?? "";
  } catch (err) {
    return NextResponse.json({ error: `channels.list: ${String(err)}` }, { status: 502 });
  }

  // 2. enumerate uploads (paginated)
  const allIds: Array<{ id: string; publishedAt: string }> = [];
  let pageToken: string | undefined = undefined;
  try {
    while (true) {
      const u: string = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploadsPlaylistId)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const res: Response = await fetch(u, { headers: auth });
      if (!res.ok) {
        return NextResponse.json({ error: `playlistItems.list (${res.status}): ${await res.text()}` }, { status: 502 });
      }
      const data: { items?: Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string } }>; nextPageToken?: string } = await res.json();
      for (const it of data.items ?? []) {
        const id = it.contentDetails?.videoId;
        if (id) allIds.push({ id, publishedAt: it.contentDetails?.videoPublishedAt ?? "" });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
  } catch (err) {
    return NextResponse.json({ error: `playlistItems: ${String(err)}` }, { status: 502 });
  }

  // 3. videos.list with liveStreamingDetails — filter to broadcasts only
  const broadcasts: BroadcastEntry[] = [];
  try {
    for (let i = 0; i < allIds.length; i += 50) {
      const chunk = allIds.slice(i, i + 50);
      const ids = chunk.map(x => x.id).join(",");
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,liveStreamingDetails,contentDetails&id=${encodeURIComponent(ids)}`,
        { headers: auth },
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of data.items ?? []) {
        const lsd = item.liveStreamingDetails;
        const lbc = item.snippet?.liveBroadcastContent ?? "none";
        // A broadcast is anything with liveStreamingDetails OR liveBroadcastContent != none.
        if (!lsd && lbc === "none") continue;
        const thumbs = item.snippet?.thumbnails ?? {};
        broadcasts.push({
          id: item.id,
          title: item.snippet?.title ?? "",
          description: item.snippet?.description ?? null,
          publishedAt: item.snippet?.publishedAt ?? "",
          privacyStatus: item.status?.privacyStatus,
          thumbnail_url: thumbs.medium?.url ?? thumbs.default?.url ?? null,
          duration_seconds: parseISO8601Duration(item.contentDetails?.duration),
          scheduledStartTime: lsd?.scheduledStartTime,
          actualStartTime: lsd?.actualStartTime,
          actualEndTime: lsd?.actualEndTime,
          liveBroadcastContent: lbc,
          channel_title: channelTitle,
        });
      }
    }
  } catch (err) {
    return NextResponse.json({ error: `videos.list: ${String(err)}` }, { status: 502 });
  }

  // 4. optional date filter on actualStartTime || publishedAt
  const filtered = broadcasts.filter(b => {
    const when = (b.actualStartTime || b.publishedAt || "").slice(0, 10);
    if (fromIso && when && when < fromIso) return false;
    if (toIso && when && when > toIso) return false;
    return true;
  });

  serverLog("info", "ext:yt-live-broadcasts", "done", {
    total_uploads: allIds.length,
    broadcasts: broadcasts.length,
    after_date_filter: filtered.length,
    rid,
  });
  return NextResponse.json({ channelId, channelTitle, broadcasts: filtered, total: filtered.length });
}

export const GET = withRequestLogging("api:youtube/live-broadcasts", handler);
