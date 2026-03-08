import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";

async function handler(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId");
  if (!videoId) {
    return NextResponse.json({ error: "videoId query param required" }, { status: 400 });
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
      return NextResponse.json(
        { error: `Token refresh failed (${tokenRes.status}): ${text}` },
        { status: 502 },
      );
    }

    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
  } catch (err) {
    return NextResponse.json(
      { error: `Token refresh error: ${String(err)}` },
      { status: 502 },
    );
  }

  // Query YouTube Data API for video status
  try {
    const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(videoId)}`;
    const res = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `YouTube API error (${res.status}): ${text}` },
        { status: 502 },
      );
    }

    const data = await res.json();
    const items = data.items ?? [];
    if (items.length === 0) {
      return NextResponse.json(
        { error: "Video not found on YouTube" },
        { status: 404 },
      );
    }

    const ytStatus = items[0].status;
    const uploadStatus: string = ytStatus?.uploadStatus ?? "unknown";
    const privacyStatus: string = ytStatus?.privacyStatus ?? "unknown";

    // Map uploadStatus to friendly name
    const statusMap: Record<string, string> = {
      processed: "Live",
      uploaded: "Processing",
      failed: "ProcessingFailed",
      rejected: "ProcessingFailed",
      deleted: "Removed",
    };
    const friendlyStatus = statusMap[uploadStatus] ?? uploadStatus;

    return NextResponse.json({
      status: friendlyStatus,
      uploadStatus,
      privacyStatus,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `YouTube status check error: ${String(err)}` },
      { status: 502 },
    );
  }
}

export const GET = withRequestLogging("api:youtube/status", handler);
