import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

/**
 * ADR-029 CTA autopost — inserts a top-level comment on a freshly
 * published Short so viewers see the "Watch the full recording"
 * link above the collapsed description.
 *
 * NB: YouTube Data API v3 does NOT expose comment pinning. The
 * comment we insert here shows the channel owner's ❤️ badge and
 * typically bubbles near the top of the comment list, but to lock
 * it at position 1 the operator has to pin it in YouTube Studio
 * (Comments → ⋮ → Pin). We do everything the API allows; the
 * caller surfaces the manual-pin hint in its success message.
 *
 * Requires the youtube.force-ssl scope. If the operator authorised
 * before this route existed, commentThreads.insert returns 403
 * ("Insufficient authentication scopes"). We forward that verbatim
 * so ShortsPanel can prompt for re-auth without guessing.
 */
async function handler(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const { videoId, text, refreshToken, clientId, clientSecret } = body as {
    videoId?: string;
    text?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
  };

  if (!videoId || !text || !refreshToken || !clientId || !clientSecret) {
    return NextResponse.json(
      { error: "videoId, text, refreshToken, clientId, clientSecret required" },
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
    serverLog("error", "yt:post-comment", "token-refresh-failed", { videoId, status: tokenRes.status, body: txt.slice(0, 300) });
    return NextResponse.json({ error: `Token refresh failed (${tokenRes.status})` }, { status: 502 });
  }
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

  const insertRes = await fetch("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      snippet: {
        videoId,
        topLevelComment: { snippet: { textOriginal: text } },
      },
    }),
  });

  if (!insertRes.ok) {
    const bodyText = await insertRes.text().catch(() => "");
    // 403 with "insufficientScopes" → the operator's YouTube auth
    // predates ADR-029's scope widening. Surface the well-known
    // sentinel so ShortsPanel can suggest re-auth instead of a
    // generic upload error.
    const missingScope = insertRes.status === 403 && /scope|permission/i.test(bodyText);
    serverLog("error", "yt:post-comment", "insert-failed", { videoId, status: insertRes.status, missingScope, body: bodyText.slice(0, 400) });
    return NextResponse.json(
      {
        error: missingScope
          ? "youtube.force-ssl scope missing — re-authorise YouTube in Connections to enable CTA-comment autopost"
          : `commentThreads.insert failed (${insertRes.status}): ${bodyText.slice(0, 200)}`,
        missingScope,
      },
      { status: insertRes.status === 403 ? 403 : 502 },
    );
  }

  const data = (await insertRes.json()) as { id?: string };
  serverLog("info", "yt:post-comment", "insert-ok", { videoId, commentThreadId: data.id });
  return NextResponse.json({ commentThreadId: data.id ?? null });
}

export const POST = withRequestLogging("api:youtube/post-comment", handler);
