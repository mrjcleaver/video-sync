/**
 * ADR-052 — Summary Badge Backfill driver.
 *
 * Walks the catalog and (re)generates summary badges for records that
 * need one. Three eligibility states the scanner distinguishes:
 *
 *   - "missing":  no summary_doc_id yet
 *   - "stale":    summary_prompt_version < current prompt version
 *   - (skip):     already current, fully populated
 *
 * Default skips locked records; `includeLocked` opts in to override.
 *
 * Leans on the ADR-053 transcript resolver so records without their
 * own transcript can be backfilled via a paired-record's transcript.
 * The actual generation reuses tryEnsureSummary from catchupOrchestrator
 * (which now respects ADR-053 + the override-lock flag).
 *
 * Cost cap: bounds the per-run spend so an accidental click against a
 * huge catalog doesn't blow through quota. Default $5.00 USD.
 */

import type { VideoRecordJSON } from "./wasm";
import { videoStore } from "./store";
import { tryEnsureSummary } from "./catchupOrchestrator";
import { estimatePerRecordCost } from "./llmCost";
import { getCurrentPromptVersion } from "./summaryPromptClient";
import { resolveTranscriptForOperation } from "./transcriptProvenance";
import type { actorCommand } from "./useCurrentActor";

export type BadgeReason = "missing" | "stale";

export interface SummaryBackfillCandidate {
  record: VideoRecordJSON;
  reason: BadgeReason;
  /** True iff this record needs a borrowed transcript (own is empty
   *  / too short). Used by the panel to show a count breakdown. */
  needsBorrowedTranscript: boolean;
}

/**
 * Pure scanner — returns every record eligible for badge backfill.
 *
 * Filtering rules:
 *   - Must have a usable transcript (own OR borrowable per ADR-053).
 *   - Skip locked records unless opts.includeLocked.
 *   - Status filter: include all non-terminal statuses. Specifically
 *     EXCLUDE Skipped / Abandoned (operator deliberately opted out)
 *     to avoid spending LLM money on records they don't care about.
 *
 * Returned in stable order (catalog order) so re-running produces
 * deterministic progress reporting.
 */
export function findRecordsNeedingSummaryBadge(
  allRecords: VideoRecordJSON[],
  currentPromptVersion: number | null,
  opts?: { includeLocked?: boolean },
): SummaryBackfillCandidate[] {
  const out: SummaryBackfillCandidate[] = [];
  const includeLocked = opts?.includeLocked ?? false;
  for (const rec of allRecords) {
    // Status guard — skip explicit operator-terminal states.
    if (rec.status === "Skipped" || rec.status === "Abandoned") continue;
    // Lock guard.
    if (rec.summary_locked && !includeLocked) continue;
    // Transcript availability (own or borrowed) — ADR-053.
    const resolved = resolveTranscriptForOperation(rec, allRecords);
    if (!resolved) continue;
    // Badge state classifier.
    if (!rec.summary_doc_id) {
      out.push({
        record: rec,
        reason: "missing",
        needsBorrowedTranscript: resolved.source.kind === "borrowed",
      });
      continue;
    }
    if (
      currentPromptVersion != null &&
      rec.summary_prompt_version != null &&
      rec.summary_prompt_version < currentPromptVersion
    ) {
      out.push({
        record: rec,
        reason: "stale",
        needsBorrowedTranscript: resolved.source.kind === "borrowed",
      });
      continue;
    }
    // Already current — no work.
  }
  return out;
}

export interface BackfillProgressEvent {
  type: "started" | "item_done" | "complete";
  index?: number;
  total: number;
  recordTitle?: string;
  outcome?:
    | { kind: "generated"; recordId: string; reason: BadgeReason; borrowed: boolean }
    | { kind: "skipped_locked" }
    | { kind: "skipped_current" }
    | { kind: "skipped_no_transcript" }
    | { kind: "stopped_cost_cap"; spent: number; cap: number }
    | { kind: "error"; error: string };
  totals?: {
    generated: number;
    skipped: number;
    errors: number;
    cost_spent_usd: number;
  };
}

const DEFAULT_COST_CAP_USD = 5.00;
const DEFAULT_DELAY_MS = 200;

/**
 * Sequential driver. Iterates eligibility from findRecordsNeedingSummaryBadge,
 * calls tryEnsureSummary per record, emits progress events. Halts when the
 * cost cap would be exceeded — caller can re-run to continue.
 */
const DEFAULT_CONCURRENCY = 4;

export async function runSummaryBadgeBackfill(
  actorState: Parameters<typeof actorCommand>[0],
  onEvent: (ev: BackfillProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
  opts?: {
    includeLocked?: boolean;
    costCapUsd?: number;
    delayMs?: number;
    signal?: AbortSignal;
    /** Max concurrent OpenRouter calls. Default 4 — each Show Notes
     *  gen takes ~30-180s server-side (Gemini 2.5 Pro) and OpenRouter
     *  tolerates several parallel calls. Set to 1 to force sequential
     *  when troubleshooting rate-limit issues. */
    concurrency?: number;
  },
): Promise<{ generated: number; skipped: number; errors: number; cost_spent_usd: number }> {
  const includeLocked = opts?.includeLocked ?? false;
  const costCap = opts?.costCapUsd ?? DEFAULT_COST_CAP_USD;
  const concurrency = Math.max(1, opts?.concurrency ?? DEFAULT_CONCURRENCY);

  const currentPromptVersion = await getCurrentPromptVersion();
  const allRecords = videoStore.getAll();
  const work = findRecordsNeedingSummaryBadge(allRecords, currentPromptVersion, { includeLocked });

  onEvent({ type: "started", total: work.length });
  log?.(`Summary badge backfill started — ${work.length} record${work.length === 1 ? "" : "s"} eligible (includeLocked=${includeLocked}, concurrency=${concurrency})`);

  let generated = 0;
  let skipped = 0;
  let errors = 0;
  let spent = 0;
  let processedCount = 0;   // for the item_done progress index
  let stoppedByCap = false;
  const signal = opts?.signal ?? new AbortController().signal;

  // Bounded async pool. Workers pull the next un-processed item off
  // the queue until it's empty or aborted / cost-capped. Each Show
  // Notes gen is a blocking network wait — parallelism gives us
  // near-linear speedup up to the OpenRouter concurrency ceiling
  // (empirically fine at 4 for Gemini 2.5 Pro + Haiku fallback).
  let cursor = 0;
  async function worker() {
    while (true) {
      if (signal.aborted || stoppedByCap) return;
      const i = cursor++;
      if (i >= work.length) return;
      const { record, reason, needsBorrowedTranscript } = work[i];

      // Pre-flight cost check. Because workers advance in parallel,
      // spent can move while we're deciding; recheck AFTER the call
      // and refund/deny only if we can't afford this specific gen.
      const resolved = resolveTranscriptForOperation(record, videoStore.getAll());
      const transcriptLen = resolved?.text.length ?? 0;
      const estCost = estimatePerRecordCost(transcriptLen, "google/gemini-2.5-pro");
      if (spent + estCost > costCap) {
        stoppedByCap = true;
        onEvent({
          type: "item_done",
          index: ++processedCount,
          total: work.length,
          recordTitle: record.title,
          outcome: { kind: "stopped_cost_cap", spent, cap: costCap },
        });
        log?.(`Cost cap reached — halting, spent $${spent.toFixed(2)} of $${costCap.toFixed(2)}`);
        return;
      }

      let outcome: BackfillProgressEvent["outcome"];
      try {
        const res = await tryEnsureSummary({
          record,
          currentPromptVersion,
          actorState,
          signal,
          allRecords: videoStore.getAll(),
          overrideLock: includeLocked,
        });
        if (res.generated) {
          generated++;
          spent += estCost;
          outcome = { kind: "generated", recordId: record.id, reason, borrowed: needsBorrowedTranscript };
          log?.(
            `Backfilled badge for ${record.id} (${reason}${needsBorrowedTranscript ? ", borrowed transcript" : ""}) — est $${estCost.toFixed(3)}`,
            { video_id: record.id },
          );
        } else {
          skipped++;
          if (res.reason === "locked") outcome = { kind: "skipped_locked" };
          else if (res.reason === "current") outcome = { kind: "skipped_current" };
          else if (res.reason?.startsWith("no transcript")) outcome = { kind: "skipped_no_transcript" };
          else outcome = { kind: "skipped_current" };
        }
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        outcome = { kind: "error", error: msg };
        log?.(`Backfill error on ${record.id} ("${record.title}"): ${msg}`, { video_id: record.id });
      }

      onEvent({
        type: "item_done",
        index: ++processedCount,
        total: work.length,
        recordTitle: record.title,
        outcome,
      });
    }
  }

  // Launch `concurrency` workers, wait for all to drain.
  const workers = Array.from({ length: Math.min(concurrency, work.length) }, () => worker());
  await Promise.all(workers);

  const totals = { generated, skipped, errors, cost_spent_usd: spent };
  onEvent({ type: "complete", total: work.length, totals });
  log?.(
    `Summary badge backfill complete — ${generated} generated, ${skipped} skipped, ${errors} error(s), $${spent.toFixed(2)} spent`,
  );
  return totals;
}
