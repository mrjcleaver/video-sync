import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

/**
 * ADR-055 follow-up — push a locally-aligned title back to the
 * actual YouTube video via videos.update.
 *
 * Requires the youtube.force-ssl scope (added for the ADR-029 CTA
 * autopost; tokens issued before then will 403). Both title and
 * categoryId are required by YouTube's snippet part — we read the
 * current categoryId first so we don't clobber it. Description /
 * tags are left untouched.
 */
async function handler(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const { videoId, title, refreshToken, clientId, clientSecret } = body as {
    videoId?: string;
    title?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
  };

  if (!videoId || !title || !refreshToken || !clientId || !clientSecret) {
    return NextResponse.json(
      { error: "videoId, title, refreshToken, clientId, clientSecret required" },
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
    const txt = await tokenRes.text().catch(() => "");
    serverLog("error", "yt:update-title", "token-refresh-failed", { videoId, status: tokenRes.status, body: txt.slice(0, 300) });
    return NextResponse.json({ error: `Token refresh failed (${tokenRes.status})` }, { status: 502 });
  }
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

  // Read current snippet so we can preserve categoryId (required by
  // videos.update) and detect no-op updates.
  const readRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!readRes.ok) {
    const txt = await readRes.text().catch(() => "");
    return NextResponse.json({ error: `videos.list failed (${readRes.status}): ${txt.slice(0, 200)}` }, { status: 502 });
  }
  const readData = (await readRes.json()) as {
    items?: Array<{ snippet?: { title?: string; categoryId?: string; description?: string; tags?: string[] } }>;
  };
  const currentSnippet = readData.items?.[0]?.snippet;
  if (!currentSnippet) {
    return NextResponse.json({ error: `video ${videoId} not found on YouTube` }, { status: 404 });
  }
  if (currentSnippet.title === title) {
    // Idempotent no-op — telling the caller so it can log accordingly.
    return NextResponse.json({ updated: false, reason: "already-matches", currentTitle: currentSnippet.title });
  }

  const updateRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: videoId,
        snippet: {
          title,
          // categoryId is required — YouTube 400s without it. We
          // just echo the current value.
          categoryId: currentSnippet.categoryId ?? "22",
          description: currentSnippet.description,
          tags: currentSnippet.tags,
        },
      }),
    },
  );

  if (!updateRes.ok) {
    const txt = await updateRes.text().catch(() => "");
    const missingScope = updateRes.status === 403 && /scope|permission/i.test(txt);
    serverLog("error", "yt:update-title", "update-failed", { videoId, status: updateRes.status, missingScope, body: txt.slice(0, 400) });
    return NextResponse.json(
      {
        error: missingScope
          ? "youtube.force-ssl scope missing — re-authorise YouTube in Connections"
          : `videos.update failed (${updateRes.status}): ${txt.slice(0, 200)}`,
        missingScope,
      },
      { status: updateRes.status === 403 ? 403 : 502 },
    );
  }

  serverLog("info", "yt:update-title", "update-ok", { videoId, oldTitle: currentSnippet.title, newTitle: title });
  return NextResponse.json({ updated: true, oldTitle: currentSnippet.title, newTitle: title });
}

export const PUT = withRequestLogging("api:youtube/update-title", handler);
export const POST = withRequestLogging("api:youtube/update-title", handler);
