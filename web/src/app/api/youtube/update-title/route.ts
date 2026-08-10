import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { captureBackup } from "../../../../lib/descriptionBackups";
import { getActor } from "../../../../lib/auth";
import { setArtifact } from "../../../../lib/driveArtifactStore";
import { readCatalog } from "../../catalog/route";
import { generateAndStoreReference } from "../../../../lib/referenceRenderer";
import type { VideoRecordJSON } from "../../../../lib/wasm";

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
  const { videoId, title, description, refreshToken, clientId, clientSecret, record_id } = body as {
    videoId?: string;
    title?: string;
    description?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    /** Optional — catalog record id for backup attribution. */
    record_id?: string;
  };
  // Best-effort: know the actor doing the write (for backup provenance).
  let actorEmail = "unknown";
  try { const actor = await getActor(req); actorEmail = actor.email; }
  catch { /* keep "unknown" */ }

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
  // Determine what actually changed. Title change is required for a
  // no-op check; description is opt-in (only push when the caller
  // sent it AND it differs from current). This keeps the endpoint
  // safe when only-title callers don't want description touched.
  const wantDescriptionUpdate = typeof description === "string" && description !== (currentSnippet.description ?? "");
  const titleChanged = currentSnippet.title !== title;
  if (!titleChanged && !wantDescriptionUpdate) {
    return NextResponse.json({
      updated: false,
      reason: "already-matches",
      currentTitle: currentSnippet.title,
      currentDescriptionLength: (currentSnippet.description ?? "").length,
    });
  }

  // Snapshot the CURRENT title + description BEFORE we overwrite —
  // powers Maintain → Restore. Best-effort; a backup-write failure
  // doesn't block the primary update.
  try {
    await captureBackup({
      record_id: record_id ?? "",
      yt_video_id: videoId,
      taken_by: actorEmail,
      prior_title: currentSnippet.title ?? "",
      prior_description: currentSnippet.description ?? "",
      new_title: title,
      new_description: wantDescriptionUpdate ? (description as string) : undefined,
    });
  } catch (err) {
    serverLog("warn", "yt:update-title", "backup-capture-failed", { videoId, error: String(err) });
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
          description: wantDescriptionUpdate ? description : currentSnippet.description,
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

  serverLog("info", "yt:update-title", "update-ok", {
    videoId,
    oldTitle: currentSnippet.title,
    newTitle: title,
    titleChanged,
    descriptionChanged: wantDescriptionUpdate,
    descriptionLength: wantDescriptionUpdate ? (description as string).length : undefined,
  });

  // ADR-074 §1 — capture the exact snippet we just pushed as
  // `youtube-snippet.json` in the record's Drive folder. Best-effort;
  // failure never affects the client-visible update result.
  if (record_id) {
    void captureYoutubeSnippetArtifact(record_id, videoId, {
      title,
      description: wantDescriptionUpdate ? (description as string) : currentSnippet.description ?? "",
      categoryId: currentSnippet.categoryId ?? "22",
      tags: currentSnippet.tags ?? [],
    }).catch((err) => {
      serverLog("warn", "yt:update-title", "snippet-artifact-failed", {
        videoId, record_id, error: String(err),
      });
    });
  }

  return NextResponse.json({
    updated: true,
    oldTitle: currentSnippet.title,
    newTitle: title,
    titleChanged,
    descriptionChanged: wantDescriptionUpdate,
  });
}

/**
 * ADR-074 §1 — persist the exact snippet body we PUT to YouTube as
 * `youtube-snippet.json` on the record's Drive folder. Looks up the
 * record's title / source metadata from the server-side catalog
 * (readCatalog) so callers don't need to send RecordContext inline.
 */
async function captureYoutubeSnippetArtifact(
  recordId: string,
  ytVideoId: string,
  snippet: { title: string; description: string; categoryId: string; tags: string[] },
): Promise<void> {
  const store = await readCatalog();
  const raw = store.records[recordId];
  if (!raw) return;   // record no longer in catalog — nothing to attach to
  const rec = JSON.parse(raw) as VideoRecordJSON;
  await setArtifact(
    {
      record_id: rec.id,
      title: rec.title,
      source_platform: rec.source_platform,
      source_id: rec.source_id,
      recorded_at: rec.recorded_at ?? rec.indexed_at ?? new Date().toISOString(),
    },
    "youtube-snippet",
    JSON.stringify(
      {
        yt_video_id: ytVideoId,
        pushed_at: new Date().toISOString(),
        snippet,
      },
      null, 2,
    ),
  );
  // ADR-074 §3 — the pushed snippet is a reference-material input.
  // Regenerate reference.md now (no debouncing needed server-side —
  // the YouTube push itself is already the debounced culmination).
  await generateAndStoreReference(rec).catch((err: unknown) => {
    serverLog("warn", "yt:update-title", "reference-regen-failed", {
      record_id: rec.id, error: err instanceof Error ? err.message : String(err),
    });
  });
}

export const PUT = withRequestLogging("api:youtube/update-title", handler);
export const POST = withRequestLogging("api:youtube/update-title", handler);
