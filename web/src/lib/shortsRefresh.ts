/**
 * On-demand Opus metadata refresh for OpusClip catalog rows.
 * Groups clips by opus_clip_job_id, fires a single
 * /api/shorts/status call per unique project, matches returned
 * clips by opus_clip_id (preferred) or shorts-<jobId>-<index>,
 * and writes back virality_score / keywords / virality_breakdown
 * via update_metadata (the ADR-058 shallow-merge path).
 *
 * Called on:
 *   - ShortsPanel mount (bulk refresh of everything visible).
 *   - Individual clip play / preview open (single-clip refresh).
 *
 * Never throws; failures land in the event log.
 */

import { videoStore } from "./store";
import type { VideoRecordJSON } from "./wasm";
import { actorCommand } from "./useCurrentActor";
import type { ActorState } from "./useCurrentActor";

const CONNECTIONS_KEY = "video-sync:connections";

function getOpusApiKey(): string | null {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return null;
    const conns = JSON.parse(raw) as Record<string, { credentials?: Record<string, string> }>;
    return conns["OpusClip"]?.credentials?.apiKey?.trim() || null;
  } catch { return null; }
}

interface Ctx {
  actorState: ActorState;
  onEvent: (msg: string, ctx?: { video_id?: string }) => void;
  onMutated?: () => void;
}

/**
 * Refresh a single clip's metadata from Opus. Cheap — one HTTP
 * call, one WASM update. Wire this to preview-open / play events
 * so metadata is always current when the operator engages with a
 * specific clip.
 */
export async function refreshOneShortFromOpus(clip: VideoRecordJSON, ctx: Ctx): Promise<void> {
  const key = getOpusApiKey();
  if (!key) return;
  const extra = (clip.metadata_extra ?? {}) as Record<string, unknown>;
  const jobId = typeof extra.opus_clip_job_id === "string" ? extra.opus_clip_job_id : null;
  if (!jobId) return;
  try {
    const res = await fetch(`/api/shorts/status?jobId=${encodeURIComponent(jobId)}&apiKey=${encodeURIComponent(key)}`);
    if (!res.ok) return;
    const data = await res.json() as {
      status: string;
      clips?: Array<{ index: number; viralityScore?: number; opusClipId?: string | null; keywords?: string[] }>;
    };
    if (!data.clips || data.clips.length === 0) return;
    const opusClipId = typeof extra.opus_clip_id === "string" ? extra.opus_clip_id : null;
    const suffixIdx = clip.source_id.startsWith(`shorts-${jobId}-`)
      ? Number(clip.source_id.slice(`shorts-${jobId}-`.length))
      : NaN;
    const match = data.clips.find(c =>
      (opusClipId && c.opusClipId === opusClipId)
      || (Number.isFinite(suffixIdx) && c.index === suffixIdx),
    );
    if (!match) return;
    applyOpusMetadataToRecord(clip, match, ctx);
  } catch {
    // Silent — refresh is best-effort.
  }
}

/**
 * Bulk refresh: one /api/shorts/status per unique jobId in the
 * clip set. Rate-limited by fetch concurrency, not by us — Opus
 * has its own throttle and the browser's ~6 concurrent fetches
 * per origin gate the fan-out.
 */
export async function refreshShortsFromOpus(clips: VideoRecordJSON[], ctx: Ctx): Promise<{ refreshed: number; jobs: number }> {
  const key = getOpusApiKey();
  if (!key || clips.length === 0) return { refreshed: 0, jobs: 0 };
  const byJob = new Map<string, VideoRecordJSON[]>();
  for (const c of clips) {
    if (c.source_platform !== "OpusClip") continue;
    const extra = (c.metadata_extra ?? {}) as Record<string, unknown>;
    const jobId = typeof extra.opus_clip_job_id === "string" ? extra.opus_clip_job_id : null;
    if (!jobId) continue;
    const bucket = byJob.get(jobId) ?? [];
    bucket.push(c);
    byJob.set(jobId, bucket);
  }
  const jobIds = [...byJob.keys()];
  let refreshed = 0;
  await Promise.all(jobIds.map(async jobId => {
    try {
      const res = await fetch(`/api/shorts/status?jobId=${encodeURIComponent(jobId)}&apiKey=${encodeURIComponent(key)}`);
      if (!res.ok) return;
      const data = await res.json() as {
        clips?: Array<{ index: number; viralityScore?: number; opusClipId?: string | null; keywords?: string[] }>;
      };
      if (!data.clips || data.clips.length === 0) return;
      const targets = byJob.get(jobId) ?? [];
      const byOpusId = new Map<string, typeof data.clips[number]>();
      const byIndex = new Map<number, typeof data.clips[number]>();
      for (const c of data.clips) {
        if (c.opusClipId) byOpusId.set(c.opusClipId, c);
        if (typeof c.index === "number") byIndex.set(c.index, c);
      }
      for (const row of targets) {
        const extra = (row.metadata_extra ?? {}) as Record<string, unknown>;
        const opusClipId = typeof extra.opus_clip_id === "string" ? extra.opus_clip_id : null;
        const suffixIdx = row.source_id.startsWith(`shorts-${jobId}-`)
          ? Number(row.source_id.slice(`shorts-${jobId}-`.length))
          : NaN;
        const match = (opusClipId ? byOpusId.get(opusClipId) : undefined)
                   ?? (Number.isFinite(suffixIdx) ? byIndex.get(suffixIdx) : undefined);
        if (!match) continue;
        if (applyOpusMetadataToRecord(row, match, ctx)) refreshed++;
      }
    } catch { /* per-job failures don't fail the batch */ }
  }));
  if (refreshed > 0) ctx.onMutated?.();
  return { refreshed, jobs: jobIds.length };
}

/**
 * Apply Opus's returned metadata to the record. Returns true if
 * anything actually changed (avoids no-op WASM mutations that
 * would still trigger a persist / notify cycle).
 */
function applyOpusMetadataToRecord(
  row: VideoRecordJSON,
  opus: { viralityScore?: number; keywords?: string[] },
  ctx: Ctx,
): boolean {
  const existing = (row.metadata_extra ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof opus.viralityScore === "number" && opus.viralityScore !== existing.virality_score) {
    patch.virality_score = opus.viralityScore;
  }
  if (Array.isArray(opus.keywords) && opus.keywords.length > 0) {
    const prev = Array.isArray(existing.keywords) ? existing.keywords as string[] : [];
    if (JSON.stringify(prev) !== JSON.stringify(opus.keywords)) {
      patch.keywords = opus.keywords;
    }
  }
  if (Object.keys(patch).length === 0) return false;
  try {
    videoStore.mutate(row.id, (r) =>
      r.update_metadata(actorCommand(ctx.actorState, {
        edits: { metadata_extra: patch },
      })),
    );
    return true;
  } catch {
    return false;
  }
}
