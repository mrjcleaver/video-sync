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
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { setArtifact } from "../../../../lib/driveArtifactStore";
import { readCatalog } from "../../../../lib/catalogStore";
import type { VideoRecordJSON } from "../../../../lib/wasm";

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
  // ADR-074 §Follow-ups — when true, capture the fetched live snippet
  // as youtube-snippet.json for the matching catalog record, closing
  // the "someone edited in YT Studio and we don't know" drift gap.
  // Off by default so scan-only workflows don't touch Drive.
  const captureAsArtifact = body.capture_as_artifact === true;
  // Optional yt_video_id → record_id map. When absent, the endpoint
  // looks up records by their YouTube location or source_id.
  const recordIdMap = (typeof body.record_id_by_yt_id === "object" && body.record_id_by_yt_id !== null)
    ? body.record_id_by_yt_id as Record<string, string>
    : {};

  if (videoIds.length === 0) return NextResponse.json({ snippets: [] });
  if (!refreshToken || !clientId || !clientSecret) {
    return NextResponse.json({ error: "refreshToken, clientId, clientSecret required" }, { status: 400 });
  }
  const accessToken = await refreshAccessToken(refreshToken, clientId, clientSecret);
  if (!accessToken) return NextResponse.json({ error: "OAuth refresh failed" }, { status: 502 });

  const snippets: Array<{ id: string; title: string; description: string; categoryId?: string; tags?: string[] }> = [];
  // videos.list caps at 50 ids per call.
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    // Request categoryId + tags too so the captured artifact carries
    // the full snippet body (matches what a videos.update PUT needs).
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${chunk.map(encodeURIComponent).join(",")}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return NextResponse.json({ error: `videos.list HTTP ${res.status}: ${txt.slice(0, 200)}` }, { status: 502 });
    }
    const data = await res.json() as { items?: Array<{ id?: string; snippet?: { title?: string; description?: string; categoryId?: string; tags?: string[] } }> };
    for (const it of data.items ?? []) {
      if (!it.id) continue;
      snippets.push({
        id: it.id,
        title: it.snippet?.title ?? "",
        description: it.snippet?.description ?? "",
        categoryId: it.snippet?.categoryId,
        tags: it.snippet?.tags,
      });
    }
  }

  // ADR-074 §Follow-ups — best-effort artifact capture. Never blocks
  // the response; any Drive write failure just logs.
  if (captureAsArtifact && snippets.length > 0) {
    void captureSnippetsAsArtifacts(snippets, recordIdMap).catch((err) => {
      serverLog("warn", "yt:snippets", "artifact-capture-failed", { error: String(err) });
    });
  }

  return NextResponse.json({ snippets });
}

async function captureSnippetsAsArtifacts(
  snippets: Array<{ id: string; title: string; description: string; categoryId?: string; tags?: string[] }>,
  recordIdMap: Record<string, string>,
): Promise<void> {
  const store = await readCatalog();
  // Build yt_video_id → record lookup. Client-supplied map (from the
  // catalog snapshot that fetched these ids) is fastest and wins;
  // fall back to walking every record's locations for any yt_id the
  // client didn't map (e.g. the client's map got out of sync).
  const byYtId = new Map<string, VideoRecordJSON>();
  for (const [ytId, recordId] of Object.entries(recordIdMap)) {
    const raw = store.records[recordId];
    if (!raw) continue;
    try { byYtId.set(ytId, JSON.parse(raw) as VideoRecordJSON); } catch { /* skip */ }
  }
  const unmappedYtIds = snippets.filter(s => !byYtId.has(s.id)).map(s => s.id);
  if (unmappedYtIds.length > 0) {
    const wanted = new Set(unmappedYtIds);
    for (const raw of Object.values(store.records)) {
      if (wanted.size === 0) break;
      try {
        const rec = JSON.parse(raw) as VideoRecordJSON;
        for (const loc of rec.locations ?? []) {
          if (loc.platform === "YouTube" && loc.external_id) {
            const bare = loc.external_id.replace(/^youtube-/, "");
            if (wanted.has(bare)) { byYtId.set(bare, rec); wanted.delete(bare); }
          }
        }
        if (rec.source_platform === "YouTube") {
          const bare = rec.source_id.replace(/^youtube-/, "");
          if (wanted.has(bare)) { byYtId.set(bare, rec); wanted.delete(bare); }
        }
      } catch { /* skip */ }
    }
  }

  await Promise.all(snippets.map(async (s) => {
    const rec = byYtId.get(s.id);
    if (!rec) return;
    try {
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
            yt_video_id: s.id,
            fetched_at: new Date().toISOString(),
            fetched_from: "youtube.videos.list",
            snippet: {
              title: s.title,
              description: s.description,
              categoryId: s.categoryId ?? null,
              tags: s.tags ?? [],
            },
          },
          null, 2,
        ),
      );
    } catch (err) {
      serverLog("warn", "yt:snippets", "artifact-write-failed", {
        record_id: rec.id, yt_video_id: s.id, error: String(err),
      });
    }
  }));
}

export const POST = withRequestLogging("api:youtube/snippets", handler);
