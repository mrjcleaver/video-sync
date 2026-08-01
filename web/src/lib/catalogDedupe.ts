/**
 * Catalog dedupe — walks the catalog looking for records that
 * share a (source_platform, source_id) and consolidates each
 * cluster to a single canonical row. Losers are Abandoned (via
 * the WASM state machine's abandon transition), preserving the
 * event log so a rollback is possible from persistence.
 *
 * Discovered during the 2026-08-01 catalog audit that revealed
 * ~12 extra rows across 9 sources — mostly Fireflies/Zoom that
 * were re-imported without an existing-record guard on the
 * importer side. The ingest guards have been closed by matching
 * commits; this maintenance card cleans up the historical mess.
 *
 * Pure discovery is in `findDuplicateClusters`; the mutation
 * driver `runCatalogDedupe` walks the clusters and abandons the
 * losers, respecting the state-machine's `can_abandon` predicate
 * — records in Approved / Publishing / ToRetry can't be abandoned
 * directly and are reported as needing manual attention.
 */

import { videoStore } from "./store";
import type { VideoRecordJSON } from "./wasm";
import { actorCommand } from "./useCurrentActor";
import type { ActorState } from "./useCurrentActor";

/** Higher = more likely to be the canonical winner. Matches the
 *  audit's preferred order. */
const CANONICAL_STATUS_PRIORITY: Record<string, number> = {
  "Published": 10,
  "Publishing": 9,
  "Approved": 8,
  "InScope": 7,
  "Discovered": 6,
  "ToRetry": 5,
  "Failed": 4,
  "Skipped": 3,
  "Abandoned": 0,
};

/** Losers with these statuses can be `abandon()`'d directly. */
const CAN_ABANDON: ReadonlySet<string> = new Set(["Failed", "InScope", "Discovered", "Skipped", "Published"]);

export interface DuplicateCluster {
  source_platform: string;
  source_id: string;
  winner: VideoRecordJSON;
  losers: VideoRecordJSON[];
}

/**
 * Cluster records by (source_platform, source_id). OpusClip is
 * excluded — clips share source_id prefixes intentionally (one
 * job produces N clips) and can't be treated as duplicates by
 * this rule.
 */
export function findDuplicateClusters(allRecords: VideoRecordJSON[]): DuplicateCluster[] {
  const byKey = new Map<string, VideoRecordJSON[]>();
  for (const r of allRecords) {
    if (r.source_platform === "OpusClip") continue;
    const key = `${r.source_platform}::${r.source_id}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push(r);
    byKey.set(key, bucket);
  }
  const clusters: DuplicateCluster[] = [];
  for (const [key, rs] of byKey) {
    if (rs.length < 2) continue;
    const sorted = [...rs].sort(compareCanonical);
    const [winner, ...losers] = sorted;
    const [source_platform, source_id] = key.split("::");
    clusters.push({ source_platform, source_id, winner, losers });
  }
  return clusters;
}

/** Comparator so `sort()` puts the canonical winner first. */
function compareCanonical(a: VideoRecordJSON, b: VideoRecordJSON): number {
  // Priority: status rank (higher wins), then more Destination
  // locations, then more upstream_links, then oldest indexed_at.
  const pa = CANONICAL_STATUS_PRIORITY[a.status] ?? -1;
  const pb = CANONICAL_STATUS_PRIORITY[b.status] ?? -1;
  if (pa !== pb) return pb - pa;
  const da = (a.locations ?? []).filter(l => l.role === "Destination").length;
  const db = (b.locations ?? []).filter(l => l.role === "Destination").length;
  if (da !== db) return db - da;
  const la = (a.upstream_links ?? []).length;
  const lb = (b.upstream_links ?? []).length;
  if (la !== lb) return lb - la;
  const ta = new Date(a.indexed_at ?? 0).getTime();
  const tb = new Date(b.indexed_at ?? 0).getTime();
  return ta - tb; // oldest wins ties
}

export interface DedupeProgressEvent {
  type: "started" | "cluster_done" | "complete";
  index?: number;
  total: number;
  clusterKey?: string;
  outcome?:
    | { kind: "abandoned"; count: number }
    | { kind: "manual_needed"; count: number; statuses: string[] }
    | { kind: "error"; error: string };
  totals?: {
    clusters_processed: number;
    losers_abandoned: number;
    losers_manual: number;
    errors: number;
  };
}

/**
 * Walk each duplicate cluster and abandon the losers where the
 * state machine permits it. Losers in states that can't be
 * abandoned directly (Approved / Publishing / ToRetry) are
 * reported so the operator can handle them manually — they need
 * a state walk (e.g. Publishing → mark_failed → abandon) that
 * this card intentionally doesn't automate to avoid clobbering
 * genuinely in-flight publishes.
 */
export async function runCatalogDedupe(
  actorState: ActorState,
  onEvent: (ev: DedupeProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<{ clusters_processed: number; losers_abandoned: number; losers_manual: number; errors: number }> {
  const clusters = findDuplicateClusters(videoStore.getAll());
  onEvent({ type: "started", total: clusters.length });
  log?.(`Catalog dedupe started — ${clusters.length} cluster${clusters.length === 1 ? "" : "s"} to consolidate`);

  let losers_abandoned = 0;
  let losers_manual = 0;
  let errors = 0;

  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const key = `${c.source_platform}:${c.source_id}`;
    let abandonedNow = 0;
    let manualNow = 0;
    const manualStatuses: string[] = [];
    for (const loser of c.losers) {
      if (!CAN_ABANDON.has(loser.status)) {
        manualNow++;
        manualStatuses.push(loser.status);
        log?.(
          `Dedupe [${key}] — loser ${loser.id.slice(0, 8)} status=${loser.status} needs manual walk-back before abandon`,
          { video_id: loser.id },
        );
        continue;
      }
      try {
        videoStore.mutate(loser.id, (r) => r.abandon(actorCommand(actorState)));
        abandonedNow++;
        log?.(
          `Dedupe [${key}] — abandoned loser ${loser.id.slice(0, 8)} (was ${loser.status}); winner ${c.winner.id.slice(0, 8)} kept as ${c.winner.status}`,
          { video_id: loser.id },
        );
      } catch (err) {
        errors++;
        log?.(
          `Dedupe [${key}] — abandon failed for ${loser.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
          { video_id: loser.id },
        );
      }
    }
    losers_abandoned += abandonedNow;
    losers_manual += manualNow;
    onEvent({
      type: "cluster_done",
      index: i + 1,
      total: clusters.length,
      clusterKey: key,
      outcome: manualNow > 0
        ? { kind: "manual_needed", count: manualNow, statuses: manualStatuses }
        : { kind: "abandoned", count: abandonedNow },
    });
  }

  const totals = { clusters_processed: clusters.length, losers_abandoned, losers_manual, errors };
  onEvent({ type: "complete", total: clusters.length, totals });
  log?.(
    `Catalog dedupe complete — ${losers_abandoned} loser${losers_abandoned === 1 ? "" : "s"} abandoned across ${clusters.length} cluster${clusters.length === 1 ? "" : "s"}, ${losers_manual} need manual walk-back, ${errors} error(s)`,
  );
  return totals;
}
