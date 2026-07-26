/**
 * Repair-from-Opus: reconcile OpusClip catalog rows against the
 * clips that actually exist inside Opus Clip for a given set of
 * projectIds.
 *
 * Opus's OpenAPI has no "list all my projects" endpoint (I checked
 * — help.opus.pro/api-reference/openapi.json only exposes create +
 * get-by-id), so the operator pastes projectIds from their Opus
 * dashboard URLs and we fan out one GET-project-and-clips call per
 * ID via /api/shorts/status. Each returned clip is deduped against
 * the catalog and inserted via indexShortClips so the ClipOf
 * upstream link is written the same way as the ingest path.
 *
 * Complementary to [[orphanClipsRepair]]: that module patches
 * existing catalog rows missing a link; this one back-fills the
 * catalog with rows that never existed in the first place.
 */

import { videoStore } from "./store";
import type { VideoRecordJSON } from "./wasm";
import { actorCommand } from "./useCurrentActor";

const CONNECTIONS_KEY = "video-sync:connections";

export interface DiscoverProjectResult {
  projectId: string;
  outcome:
    | "ok"
    | "still-processing"
    | "no-parent"
    | "no-clips"
    | "error";
  stage?: string;
  clipsFound: number;
  clipsIndexed: number;
  clipsSkipped: number;
  parent?: { id: string; title: string };
  sourceUri?: string;
  error?: string;
}

export interface DiscoverProgressEvent {
  type: "started" | "item_done" | "complete";
  index?: number;
  total: number;
  projectId?: string;
  result?: DiscoverProjectResult;
  totals?: { discovered: number; indexed: number; skipped: number; errors: number };
}

export function getOpusApiKey(): string | null {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return null;
    const conns = JSON.parse(raw) as Record<string, { credentials?: Record<string, string> }>;
    return conns["OpusClip"]?.credentials?.apiKey?.trim() || null;
  } catch { return null; }
}

/**
 * Split a paste blob (newlines / commas / whitespace) into a
 * deduped list of Opus projectIds. Accepts either bare IDs
 * ("P30726134uS0") or full clip.opus.pro URLs — the last URL
 * segment is taken.
 */
export function parseProjectIds(blob: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of blob.split(/[\s,]+/)) {
    let token = raw.trim();
    if (!token) continue;
    if (token.startsWith("http")) {
      // https://clip.opus.pro/clip/<projectId>  or /editor-ux/<projectId>.<clipId>
      const m = token.match(/\/clip\/([^/?#.]+)/) ?? token.match(/\/editor-ux\/([^/?#.]+)/);
      if (!m) continue;
      token = m[1];
    }
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Extract a YouTube video ID. Opus's ClipProjectRepresentation can
 * carry the ID in either field depending on how the project was
 * created — `sourceUri` for watch URLs, `sourceId` (bare 11-char
 * ID) for projects created through the "YouTube link" fast path.
 * We probe both.
 */
function extractYouTubeId(sourceUri: string | undefined, sourceId?: string | undefined): string | null {
  if (sourceUri) {
    const m = sourceUri.match(/[?&]v=([A-Za-z0-9_-]{11})/)
          ?? sourceUri.match(/youtu\.be\/([A-Za-z0-9_-]{11})/)
          ?? sourceUri.match(/\/embed\/([A-Za-z0-9_-]{11})/)
          ?? sourceUri.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  // sourceId for YouTube projects is either the bare 11-char ID
  // OR the same ID prefixed with `YT_` (confirmed in the wild —
  // Opus namespaces per-platform when the source pipeline needs
  // to disambiguate; e.g. `YT_PMaYBXnn_kQ`). Accept both.
  if (sourceId) {
    if (/^[A-Za-z0-9_-]{11}$/.test(sourceId)) return sourceId;
    const m = sourceId.match(/^YT_([A-Za-z0-9_-]{11})$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Given Opus's echoed sourceUri, find the parent catalog record.
 * Order: source_id exact-match → any YouTube location's external_id
 * → metadata_extra.youtube_url substring match. Returns null when
 * no candidate is confident enough to link against.
 */
function findParentByYouTubeId(records: VideoRecordJSON[], ytId: string): VideoRecordJSON | null {
  const target = ytId.toLowerCase();

  // 1. Direct source_id match — YouTube-source records store the
  //    plain ID as source_id (with or without a "youtube-" prefix
  //    depending on the ingest path).
  const bySource = records.find(r =>
    r.source_platform === "YouTube" &&
    (r.source_id.toLowerCase() === target || r.source_id.toLowerCase() === `youtube-${target}`),
  );
  if (bySource) return bySource;

  // 2. Any record with a YouTube location whose external_id matches.
  for (const r of records) {
    for (const loc of (r.locations ?? [])) {
      if (loc.platform === "YouTube" && loc.external_id?.toLowerCase() === target) {
        return r;
      }
    }
  }

  // 3. metadata_extra.youtube_url substring — covers YouTubeLive
  //    ingest that stores the full watch URL there.
  for (const r of records) {
    const url = (r.metadata_extra as { youtube_url?: string } | null)?.youtube_url;
    if (url && url.toLowerCase().includes(`v=${target}`)) return r;
  }
  return null;
}

/**
 * Reconcile a single Opus project against the catalog. Never
 * throws — all failure modes end up in the returned outcome so the
 * bulk driver can log per-project.
 */
export async function discoverOneProject(
  projectId: string,
  apiKey: string,
  actorState: Parameters<typeof actorCommand>[0],
): Promise<DiscoverProjectResult> {
  const res = await fetch(
    `/api/shorts/status?jobId=${encodeURIComponent(projectId)}&apiKey=${encodeURIComponent(apiKey)}`,
  );
  if (!res.ok) {
    return {
      projectId,
      outcome: "error",
      clipsFound: 0,
      clipsIndexed: 0,
      clipsSkipped: 0,
      error: `status HTTP ${res.status}`,
    };
  }
  const data = await res.json() as {
    status: "processing" | "completed" | "failed";
    clips: Array<{
      index: number;
      title: string;
      viralityScore: number;
      startSeconds: number;
      endSeconds: number;
      clipUrl: string;
      thumbnailUrl: string | null;
      opusClipId?: string | null;
      opusEditUrl?: string | null;
    }>;
    stage?: string;
    error?: string;
    sourceUri?: string;
    sourcePlatform?: string;
    sourceId?: string;
  };

  const sourceUri = data.sourceUri;
  const sourceId = data.sourceId;
  const ytId = extractYouTubeId(sourceUri, sourceId);
  const parent = ytId ? findParentByYouTubeId(videoStore.getAll(), ytId) : null;

  if (!parent) {
    // Include the raw source triple in the error so the operator (and
    // the event log) can see exactly what Opus reported when the
    // match fails — the reason is usually one of these:
    //   • Opus reports YOUTUBE but sourceUri is empty AND sourceId is
    //     not the 11-char bare ID (e.g. it's an internal Opus token).
    //   • The referenced YouTube video isn't in this catalog at all
    //     (never imported / imported under a different variant).
    const rawSummary = `platform=${data.sourcePlatform ?? "?"} id=${sourceId ?? "?"} uri=${sourceUri ?? "?"}`;
    return {
      projectId,
      outcome: "no-parent",
      stage: data.stage,
      clipsFound: data.clips?.length ?? 0,
      clipsIndexed: 0,
      clipsSkipped: 0,
      sourceUri,
      error: ytId
        ? `no catalog row matches YouTube ID ${ytId} (${rawSummary})`
        : `couldn't extract a YouTube ID from Opus's source (${rawSummary})`,
    };
  }

  if (data.status !== "completed") {
    return {
      projectId,
      outcome: "still-processing",
      stage: data.stage,
      clipsFound: 0,
      clipsIndexed: 0,
      clipsSkipped: 0,
      parent: { id: parent.id, title: parent.title },
      sourceUri,
    };
  }

  const clips = data.clips ?? [];
  if (clips.length === 0) {
    return {
      projectId,
      outcome: "no-clips",
      stage: data.stage,
      clipsFound: 0,
      clipsIndexed: 0,
      clipsSkipped: 0,
      parent: { id: parent.id, title: parent.title },
      sourceUri,
    };
  }

  const beforeIds = new Set(videoStore.getAll().map(v => v.source_id));
  // Dynamic import — indexShortClips lives inside the ShortsPanel
  // React component module. Not importing statically keeps the
  // lib layer free of React deps.
  const { indexShortClips } = await import("../components/ShortsPanel");
  const indexed = indexShortClips({
    parentVideoId: parent.id,
    parentSourceId: parent.source_id,
    parentYouTubeId: ytId,
    jobId: projectId,
    clips,
    actorState,
  });
  // Skipped = returned by Opus but already in catalog. Compute by
  // diffing pre/post source_ids for this project's shorts- prefix.
  const afterIds = new Set(videoStore.getAll().map(v => v.source_id));
  const netNew = [...afterIds].filter(id => !beforeIds.has(id)).filter(id => id.startsWith(`shorts-${projectId}-`)).length;
  const skipped = Math.max(0, clips.length - netNew);

  return {
    projectId,
    outcome: "ok",
    stage: data.stage,
    clipsFound: clips.length,
    clipsIndexed: indexed,
    clipsSkipped: skipped,
    parent: { id: parent.id, title: parent.title },
    sourceUri,
  };
}

export async function discoverOpusProjects(
  projectIds: string[],
  apiKey: string,
  actorState: Parameters<typeof actorCommand>[0],
  onEvent: (ev: DiscoverProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<{ discovered: number; indexed: number; skipped: number; errors: number }> {
  onEvent({ type: "started", total: projectIds.length });
  log?.(`Opus discovery started — ${projectIds.length} project${projectIds.length === 1 ? "" : "s"} to reconcile`);

  let discovered = 0;
  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < projectIds.length; i++) {
    const pid = projectIds[i];
    const result = await discoverOneProject(pid, apiKey, actorState);
    if (result.outcome === "ok") {
      discovered++;
      indexed += result.clipsIndexed;
      skipped += result.clipsSkipped;
      log?.(`Opus ${pid} → indexed ${result.clipsIndexed} new clip(s) under "${result.parent?.title}" (${result.clipsSkipped} already present)`);
    } else if (result.outcome === "error") {
      errors++;
      log?.(`Opus ${pid} — ${result.error}`);
    } else if (result.outcome === "no-parent") {
      errors++;
      log?.(`Opus ${pid} — no matching parent (${result.error})`);
    } else if (result.outcome === "still-processing") {
      log?.(`Opus ${pid} — still processing (stage ${result.stage ?? "?"}); parent "${result.parent?.title}" matched`);
    } else if (result.outcome === "no-clips") {
      log?.(`Opus ${pid} — complete but 0 clips returned; parent "${result.parent?.title}" matched`);
    }
    onEvent({ type: "item_done", index: i + 1, total: projectIds.length, projectId: pid, result });
  }

  const totals = { discovered, indexed, skipped, errors };
  onEvent({ type: "complete", total: projectIds.length, totals });
  log?.(`Opus discovery complete — ${indexed} clip(s) indexed across ${discovered} project(s), ${skipped} already present, ${errors} error(s)`);
  return totals;
}
