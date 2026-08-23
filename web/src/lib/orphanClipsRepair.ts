/**
 * ADR-058 follow-up — repair OpusClip records that lack a first-class
 * ClipOf upstream_link.
 *
 * Every clip created by ADR-055's implementation writes a ClipOf link
 * to its parent (indexShortClips → maybeWriteClipOfLink). But clips
 * created BEFORE ADR-055 landed only carry the parent relationship in
 * metadata_extra.parent_video_id — that's a breadcrumb, not a
 * provenance edge, so BackfillOverview / ProvenanceGraph don't nest
 * them under their parent.
 *
 * This module walks the catalog, finds OpusClip source rows without a
 * ClipOf link, and writes the missing link using
 * metadata_extra.parent_video_id as the pointer. Pure discovery +
 * imperative repair — no LLM cost, no network.
 */

import type { ActorState } from "./useCurrentActor";
import { videoStore } from "./store";
import type { VideoRecordJSON } from "./wasm";
import { actorCommand } from "./useCurrentActor";
import type { Role } from "./types/actor";

export interface OrphanClip {
  clip: VideoRecordJSON;
  parent: VideoRecordJSON;
  /** Why the linker thinks these two belong together. */
  source: "metadata_extra.parent_video_id" | "metadata_extra.parent_source_id";
}

/**
 * Pure scanner — every OpusClip-source record whose upstream_links
 * don't already include a ClipOf entry AND whose metadata_extra
 * points at a resolvable parent record. Returned in stable catalog
 * order.
 */
export function findOrphanClips(allRecords: VideoRecordJSON[]): OrphanClip[] {
  const byId = new Map(allRecords.map(v => [v.id, v]));
  const bySourceId = new Map<string, VideoRecordJSON>();
  for (const v of allRecords) bySourceId.set(v.source_id, v);

  const out: OrphanClip[] = [];
  for (const clip of allRecords) {
    if (clip.source_platform !== "OpusClip") continue;
    // Already correctly linked — skip.
    const hasClipOf = (clip.upstream_links ?? []).some(l => l.relation === "ClipOf");
    if (hasClipOf) continue;

    const meta = (clip.metadata_extra ?? {}) as Record<string, unknown>;
    const parentVideoId = meta.parent_video_id as string | undefined;
    const parentSourceId = meta.parent_source_id as string | undefined;

    if (parentVideoId) {
      const parent = byId.get(parentVideoId);
      if (parent) {
        out.push({ clip, parent, source: "metadata_extra.parent_video_id" });
        continue;
      }
    }
    if (parentSourceId) {
      const parent = bySourceId.get(parentSourceId);
      if (parent) {
        out.push({ clip, parent, source: "metadata_extra.parent_source_id" });
      }
    }
  }
  return out;
}

/**
 * Write the missing ClipOf link for one specific orphan. Used by
 * both the per-clip "Repair link" button in ShortsPanel and by the
 * bulk backfill driver below.
 */
export interface OrphanRepairResult { ok: boolean; error?: string }

export function repairOneOrphanClip(
  orphan: OrphanClip,
  actorState: Parameters<typeof actorCommand>[0],
): OrphanRepairResult {
  try {
    videoStore.mutate(orphan.clip.id, (r) =>
      r.link_upstream(actorCommand(actorState, {
        platform: orphan.parent.source_platform,
        external_id: orphan.parent.source_id,
        video_id: orphan.parent.id,
        relation: "ClipOf",
        linked_by: "Auto",
      })),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface OrphanRepairProgressEvent {
  type: "started" | "item_done" | "complete";
  index?: number;
  total: number;
  clipTitle?: string;
  outcome?: { kind: "repaired"; clipId: string; parentId: string } | { kind: "error"; error: string };
  totals?: { repaired: number; errors: number };
}

/**
 * Bulk repair driver — one loop over the whole orphan list.
 * Progress-eventing shape mirrors the other Catch-Up backfills so
 * CatchUpPanel can render it with the same UX vocabulary.
 */
export async function runOrphanClipsRepair(
  // Was declared structurally narrower than what it forwards to
  // repairOneOrphanClip, which needs the full ActorState. The only caller
  // (CatchUpPanel) already passes one.
  actorState: ActorState,
  onEvent: (ev: OrphanRepairProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<{ repaired: number; errors: number }> {
  const all = videoStore.getAll();
  const work = findOrphanClips(all);
  onEvent({ type: "started", total: work.length });
  log?.(`Orphan-clip repair started — ${work.length} clip${work.length === 1 ? "" : "s"} to link`);

  let repaired = 0;
  let errors = 0;
  for (let i = 0; i < work.length; i++) {
    const orphan = work[i];
    const result = repairOneOrphanClip(orphan, actorState);
    if (result.ok) {
      repaired++;
      log?.(`Linked clip ${orphan.clip.id} → parent ${orphan.parent.id} (via ${orphan.source})`, { video_id: orphan.clip.id });
      onEvent({
        type: "item_done",
        index: i + 1,
        total: work.length,
        clipTitle: orphan.clip.title,
        outcome: { kind: "repaired", clipId: orphan.clip.id, parentId: orphan.parent.id },
      });
    } else {
      errors++;
      log?.(`Orphan-clip repair failed for "${orphan.clip.title}" (clip=${orphan.clip.id}, parent=${orphan.parent.id}): ${result.error}`, { video_id: orphan.clip.id });
      onEvent({
        type: "item_done",
        index: i + 1,
        total: work.length,
        clipTitle: orphan.clip.title,
        outcome: { kind: "error", error: result.error ?? "unknown" },
      });
    }
  }

  const totals = { repaired, errors };
  onEvent({ type: "complete", total: work.length, totals });
  log?.(`Orphan-clip repair complete — ${repaired} linked, ${errors} error(s)`);
  return totals;
}
