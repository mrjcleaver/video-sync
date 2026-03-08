/**
 * POST /api/youtube/stats
 * Fetches view and like counts for up to 50 YouTube video IDs in one API call.
 * Used by the import list to show destination stats alongside published video links.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";

interface StatsRequest {
  videoIds: string[];
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

export interface VideoStats {
  viewCount: number;
  likeCount: number;
}

async function handler(req: NextRequest) {
  let body: StatsRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { videoIds, refreshToken, clientId, clientSecret } = body;

  if (!videoIds?.length || !refreshToken || !clientId || !clientSecret) {
    return NextResponse.json(
      { error: "videoIds, refreshToken, clientId, clientSecret required" },
      { status: 400 },
    );
  }

  // Refresh access token
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
    return NextResponse.json(
      { error: `Token refresh failed (${tokenRes.status}): ${text}` },
      { status: 502 },
    );
  }

  const { access_token: accessToken } = await tokenRes.json();

  // Fetch statistics for all IDs in one request (YouTube allows up to 50)
  const ids = videoIds.slice(0, 50).join(",");
  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(ids)}`;
  const statsRes = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!statsRes.ok) {
    const text = await statsRes.text();
    return NextResponse.json(
      { error: `YouTube API error (${statsRes.status}): ${text}` },
      { status: 502 },
    );
  }

  const data = await statsRes.json();
  const stats: Record<string, VideoStats> = {};

  for (const item of data.items ?? []) {
    stats[item.id] = {
      viewCount: parseInt(item.statistics?.viewCount ?? "0", 10),
      likeCount: parseInt(item.statistics?.likeCount ?? "0", 10),
    };
  }

  return NextResponse.json({ stats });
}

export const POST = withRequestLogging("api:youtube/stats", handler);
