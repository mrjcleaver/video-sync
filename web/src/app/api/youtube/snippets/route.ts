/**
 * POST /api/youtube/snippets
 *
 * Batch-fetch current title + description from YouTube for many
 * video ids at once (videos.list accepts up to 50 per call). Body:
 *   { videoIds: string[], refreshToken, clientId, clientSecret }
 *
 * Response: { snippets: [{ id, title, description }, ...] }
 *
 * Powers the Maintain "Compare descriptions with YouTube" bulk card
 * (ADR-064-adjacent). The main service already has YouTube OAuth
 * plumbing — this endpoint just reuses the same token-refresh path
 * that /api/youtube/status uses.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch { return null; }
}

async function handler(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const videoIds = Array.isArray(body.videoIds) ? (body.videoIds as unknown[]).filter(x => typeof x === "string") as string[] : [];
  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : undefined;
  const clientId = typeof body.clientId === "string" ? body.clientId : undefined;
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : undefined;

  if (videoIds.length === 0) return NextResponse.json({ snippets: [] });
  if (!refreshToken || !clientId || !clientSecret) {
    return NextResponse.json({ error: "refreshToken, clientId, clientSecret required" }, { status: 400 });
  }
  const accessToken = await refreshAccessToken(refreshToken, clientId, clientSecret);
  if (!accessToken) return NextResponse.json({ error: "OAuth refresh failed" }, { status: 502 });

  const snippets: Array<{ id: string; title: string; description: string }> = [];
  // videos.list caps at 50 ids per call.
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${chunk.map(encodeURIComponent).join(",")}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return NextResponse.json({ error: `videos.list HTTP ${res.status}: ${txt.slice(0, 200)}` }, { status: 502 });
    }
    const data = await res.json() as { items?: Array<{ id?: string; snippet?: { title?: string; description?: string } }> };
    for (const it of data.items ?? []) {
      if (!it.id) continue;
      snippets.push({
        id: it.id,
        title: it.snippet?.title ?? "",
        description: it.snippet?.description ?? "",
      });
    }
  }
  return NextResponse.json({ snippets });
}

export const POST = withRequestLogging("api:youtube/snippets", handler);
