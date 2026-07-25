/**
 * ADR-055 — Retrospective backfill driver for YouTube title alignment.
 *
 * Walks the catalog, finds YouTube-source records whose titles would
 * be aligned by the resolver (Strategy 1 paired-canonical or
 * Strategy 2 series-registry), and applies the rewrite via WASM
 * update_metadata.
 *
 * Parallel structure to summaryBadgeBackfill (ADR-052).
 *
 * Original-title preservation caveat: for records created before
 * ADR-055 shipped, metadata_extra.youtube_original_title is empty;
 * this retrospective rewrite emits the original via the event log
 * only (per-video log filterable at retrieval time). New records
 * created via ADR-055-aware ingest carry the original in
 * metadata_extra directly.
 */

import type { VideoRecordJSON } from "./wasm";
import { videoStore } from "./store";
import { resolveAlignedTitle, type AlignedTitle, type SeriesRegistryEntry } from "./youtubeTitleAlign";
import { getSeriesRegistry } from "./seriesRegistryClient";
import type { actorCommand } from "./useCurrentActor";
import { actorCommand as buildActorCommand } from "./useCurrentActor";

export interface TitleAlignmentCandidate {
  record: VideoRecordJSON;
  alignment: AlignedTitle;
}

/**
 * Pure scanner — every YouTube-source record for which the resolver
 * would produce a rewrite. Returned in stable catalog order.
 */
export function findRecordsNeedingTitleAlignment(
  allRecords: VideoRecordJSON[],
  registry: SeriesRegistryEntry[],
): TitleAlignmentCandidate[] {
  const out: TitleAlignmentCandidate[] = [];
  for (const rec of allRecords) {
    if (rec.source_platform !== "YouTube") continue;
    const alignment = resolveAlignedTitle(rec, allRecords, registry);
    if (alignment) out.push({ record: rec, alignment });
  }
  return out;
}

export interface TitleAlignmentProgressEvent {
  type: "started" | "item_done" | "complete";
  index?: number;
  total: number;
  recordTitle?: string;
  outcome?:
    | { kind: "renamed"; recordId: string; new_title: string; source: AlignedTitle["source"]; original_title: string }
    | { kind: "skipped"; reason: string }
    | { kind: "error"; error: string };
  totals?: {
    renamed_via_pair: number;
    renamed_via_registry: number;
    skipped: number;
    errors: number;
  };
}

const DEFAULT_DELAY_MS = 100;

/**
 * Sequential driver. Applies title rewrites via WASM update_metadata.
 * Reads the registry once per run.
 */
export async function runYouTubeTitleAlignBackfill(
  actorState: Parameters<typeof actorCommand>[0],
  onEvent: (ev: TitleAlignmentProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
  opts?: { delayMs?: number; signal?: AbortSignal },
): Promise<{ renamed_via_pair: number; renamed_via_registry: number; skipped: number; errors: number }> {
  const delayMs = opts?.delayMs ?? DEFAULT_DELAY_MS;
  const signal = opts?.signal ?? new AbortController().signal;

  const registry = await getSeriesRegistry();
  const allRecords = videoStore.getAll();
  const work = findRecordsNeedingTitleAlignment(allRecords, registry);

  onEvent({ type: "started", total: work.length });
  log?.(`YouTube title alignment backfill started — ${work.length} record${work.length === 1 ? "" : "s"} eligible`);

  let renamed_via_pair = 0;
  let renamed_via_registry = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < work.length; i++) {
    if (signal.aborted) break;
    const { record, alignment } = work[i];

    let outcome: TitleAlignmentProgressEvent["outcome"];
    try {
      const cmdJson = buildActorCommand(actorState, {
        edits: { title: alignment.new_title },
      });
      videoStore.mutate(record.id, (r) => r.update_metadata(cmdJson));
      if (alignment.source === "paired_canonical") renamed_via_pair++;
      else renamed_via_registry++;
      outcome = {
        kind: "renamed",
        recordId: record.id,
        new_title: alignment.new_title,
        source: alignment.source,
        original_title: alignment.original_title,
      };
      log?.(
        `Retitled ${record.id} via ${alignment.source} — "${alignment.original_title}" → "${alignment.new_title}"`,
        { video_id: record.id },
      );
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      outcome = { kind: "error", error: msg };
      log?.(`Retitle error on ${record.id} ("${record.title}"): ${msg}`, { video_id: record.id });
    }

    onEvent({
      type: "item_done",
      index: i + 1,
      total: work.length,
      recordTitle: alignment.original_title,
      outcome,
    });

    if (i < work.length - 1 && delayMs > 0) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  const totals = { renamed_via_pair, renamed_via_registry, skipped, errors };
  onEvent({ type: "complete", total: work.length, totals });
  log?.(
    `YouTube title alignment complete — ${renamed_via_pair} via pair, ${renamed_via_registry} via registry, ${errors} error(s)`,
  );
  return totals;
}
