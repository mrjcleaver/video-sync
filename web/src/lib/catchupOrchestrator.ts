"use client";

/**
 * ADR-047 — client-side catch-up orchestrator.
 *
 * Walks records most-recent-backwards within a window, advancing each
 * one through a fixed pipeline of stages. Yields per-stage progress
 * events so the panel can render a live unified view.
 *
 * MVP scope (slice 1):
 *   - hydrate_transcript  (Kaltura captions for entries with none)
 *   - link_siblings       (auto-link ≥ AUTO_LINK_THRESHOLD)
 *   - ensure_summary      (ADR-046: skip if locked, current, or no
 *                           transcript; honor cost cap)
 *
 * Deferred to slice 2:
 *   - source fetch        (operator still uses ImportPanel)
 *   - ingestion rules     (already runs every 60s automatically)
 *   - publish stages      (require extracting publish logic from
 *                           VideoCard; orchestrator just counts
 *                           ready-to-publish records for now)
 *
 * Cancellation: pass an AbortSignal; the orchestrator checks it
 * between stages and between records. Each stage's network call also
 * honors it via fetch({ signal }).
 */

import type { VideoRecordJSON } from "./wasm";
import { videoStore } from "./store";
import { actorCommand } from "./useCurrentActor";
import { rankSiblingCandidates } from "./siblingMatcher";
import { getCurrentPromptVersion } from "./summaryPromptClient";
import { estimatePerRecordCost } from "./llmCost";

export const AUTO_LINK_THRESHOLD = 0.85;        // silent auto-link ≥ this score
export const STAGE_FOR_REVIEW_THRESHOLD = 0.6;  // surfaced via existing banner; orchestrator notes only

export type StageId =
  | "hydrate_transcript"
  | "link_siblings"
  | "ensure_summary";

export type StageStatus = "done" | "skipped" | "n/a" | "failed" | "needs_review";

export interface StageEvent {
  type: "stage";
  record_id: string;
  stage: StageId;
  status: StageStatus;
  note?: string;
}

export interface RecordStartEvent {
  type: "record_start";
  record_id: string;
  title: string;
  index: number;
  total: number;
}

export interface RecordEndEvent {
  type: "record_end";
  record_id: string;
  publishable: boolean;   // Approved + transcript + summary + missing at least one destination
}

export interface StartedEvent { type: "started"; total: number; window_days: number; }
export interface CompleteEvent { type: "complete"; processed: number; cost_spent_usd: number; ready_to_publish: number; cost_cap_hit: boolean; }
export interface CancelledEvent { type: "cancelled"; processed: number; }

export type OrchestratorEvent = StartedEvent | RecordStartEvent | StageEvent | RecordEndEvent | CompleteEvent | CancelledEvent;

export interface CatchupOptions {
  windowDays: number;
  costCapUsd: number;
  /** Cancellable. */
  signal: AbortSignal;
  /** Called for every progress event. */
  onEvent: (ev: OrchestratorEvent) => void;
  /** EventLog forwarder for human-readable lines. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

function inWindow(v: VideoRecordJSON, windowDays: number): boolean {
  const ts = v.recorded_at ?? v.indexed_at;
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  const cutoff = Date.now() - windowDays * 86_400_000;
  return t >= cutoff;
}

/**
 * Single-stage helper for Kaltura caption hydration. Returns the new
 * transcript text on success, or null if no captions are available.
 * Throws on hard fetch errors so the orchestrator can mark `failed`.
 */
async function tryHydrateKalturaTranscript(record: VideoRecordJSON, signal: AbortSignal): Promise<string | null> {
  if (record.source_platform !== "Kaltura") return null;
  if ((record.transcript_text ?? "").length >= 200) return null;
  const res = await fetch(`/api/kaltura/captions?entryId=${encodeURIComponent(record.source_id)}`, { signal });
  if (res.status === 404 || res.status === 409 || res.status === 415 || res.status === 422) {
    // Expected "no captions / format unsupported / empty" — soft skip
    return null;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const data = await res.json() as { text?: string };
  return data.text && data.text.length >= 200 ? data.text : null;
}

interface LinkArgs {
  target: VideoRecordJSON;
  candidates: VideoRecordJSON[];
  actorState: Parameters<typeof actorCommand>[0];
  threshold: number;
}

function tryAutoLinkSibling({ target, candidates, actorState, threshold }: LinkArgs): { linked: boolean; score?: number; siblingId?: string; siblingTitle?: string; reviewNeeded?: boolean } {
  // Skip if already has any upstream link — the operator has made a decision.
  if ((target.upstream_links?.length ?? 0) > 0) return { linked: false };
  const ranked = rankSiblingCandidates(target, candidates, 3);
  const top = ranked[0];
  if (!top) return { linked: false };
  if (top.score < STAGE_FOR_REVIEW_THRESHOLD) return { linked: false };
  if (top.score < threshold) {
    // Above review threshold but below auto-link bar — banner already
    // shows it in the card; orchestrator notes it as `needs_review`.
    return { linked: false, score: top.score, siblingId: top.video.id, siblingTitle: top.video.title, reviewNeeded: true };
  }
  // Auto-link.
  try {
    videoStore.mutate(target.id, (r) =>
      r.link_upstream(actorCommand(actorState, {
        platform: top.video.source_platform,
        external_id: top.video.source_id,
        relation: "SameEvent",
        linked_by: "Auto",
      })),
    );
    return { linked: true, score: top.score, siblingId: top.video.id, siblingTitle: top.video.title };
  } catch {
    return { linked: false };
  }
}

interface SummaryArgs {
  record: VideoRecordJSON;
  currentPromptVersion: number | null;
  actorState: Parameters<typeof actorCommand>[0];
  signal: AbortSignal;
}

async function tryEnsureSummary({ record, currentPromptVersion, actorState, signal }: SummaryArgs): Promise<{ generated: boolean; reason?: string }> {
  if ((record.transcript_text?.length ?? 0) < 200) return { generated: false, reason: "no transcript" };
  if (record.summary_locked) return { generated: false, reason: "locked" };
  if (record.summary_doc_id && currentPromptVersion != null && record.summary_prompt_version === currentPromptVersion) {
    return { generated: false, reason: "current" };
  }

  const res = await fetch("/api/summary/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      record_id: record.id,
      title: record.title,
      source_platform: record.source_platform,
      source_id: record.source_id,
      recorded_at: record.recorded_at ?? record.indexed_at,
    }),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const data = await res.json() as {
    doc_id: string;
    prompt_version: number;
    counts: { m: number; l: number; t: number; c: number };
    generated_at: string;
  };
  videoStore.mutate(record.id, (r) =>
    r.set_summary_metadata(actorCommand(actorState, {
      doc_id: data.doc_id,
      prompt_version: data.prompt_version,
      counts: data.counts,
      generated_at: data.generated_at,
    })),
  );
  return { generated: true };
}

function isPublishable(v: VideoRecordJSON): boolean {
  if (v.status !== "Approved") return false;
  if ((v.transcript_text?.length ?? 0) < 200) return false;
  if (!v.summary_doc_id) return false;
  const hasYouTube = (v.locations ?? []).some(l => l.role === "Destination" && l.platform === "YouTube");
  const hasKaltura = (v.locations ?? []).some(l => l.role === "Destination" && l.platform === "Kaltura");
  return !hasYouTube || !hasKaltura;
}

export async function runCatchUp(opts: CatchupOptions, actorState: Parameters<typeof actorCommand>[0]): Promise<void> {
  const { windowDays, costCapUsd, signal, onEvent, log } = opts;

  // Build the work list once: most-recent-backwards in window.
  const all = videoStore.getAll();
  const sorted = [...all]
    .filter(v => inWindow(v, windowDays))
    .sort((a, b) => {
      const ta = new Date(a.recorded_at ?? a.indexed_at).getTime();
      const tb = new Date(b.recorded_at ?? b.indexed_at).getTime();
      return tb - ta;
    });

  onEvent({ type: "started", total: sorted.length, window_days: windowDays });
  log?.(`Catch-up started — ${sorted.length} record${sorted.length === 1 ? "" : "s"} in window (last ${windowDays} days)`);

  const currentPromptVersion = await getCurrentPromptVersion();
  let costSpent = 0;
  let costCapHit = false;
  let processed = 0;
  let readyToPublish = 0;

  for (let i = 0; i < sorted.length; i++) {
    if (signal.aborted) {
      onEvent({ type: "cancelled", processed });
      return;
    }
    // Re-read from store so updates from prior records are visible.
    const fresh = videoStore.getAll().find(v => v.id === sorted[i].id);
    if (!fresh) continue;

    onEvent({ type: "record_start", record_id: fresh.id, title: fresh.title, index: i, total: sorted.length });

    // Stage: hydrate_transcript ─────────────────────────────────
    try {
      if (fresh.source_platform === "Kaltura" && (fresh.transcript_text?.length ?? 0) < 200) {
        const text = await tryHydrateKalturaTranscript(fresh, signal);
        if (text) {
          videoStore.setTranscript(fresh.id, text);
          onEvent({ type: "stage", record_id: fresh.id, stage: "hydrate_transcript", status: "done", note: `${text.split("\n").length} lines from Kaltura captions` });
          log?.(`Catch-up · hydrated transcript: "${fresh.title}"`, { video_id: fresh.id });
        } else {
          onEvent({ type: "stage", record_id: fresh.id, stage: "hydrate_transcript", status: "n/a", note: "no captions available" });
        }
      } else {
        onEvent({ type: "stage", record_id: fresh.id, stage: "hydrate_transcript", status: "skipped", note: (fresh.transcript_text?.length ?? 0) >= 200 ? "already present" : "not a Kaltura source" });
      }
    } catch (err) {
      if (signal.aborted) { onEvent({ type: "cancelled", processed }); return; }
      onEvent({ type: "stage", record_id: fresh.id, stage: "hydrate_transcript", status: "failed", note: err instanceof Error ? err.message : String(err) });
      log?.(`Catch-up · transcript fetch failed: "${fresh.title}" — ${err instanceof Error ? err.message : String(err)}`, { video_id: fresh.id });
      processed++;
      onEvent({ type: "record_end", record_id: fresh.id, publishable: false });
      continue;
    }

    // Stage: link_siblings ──────────────────────────────────────
    const afterTranscript = videoStore.getAll().find(v => v.id === sorted[i].id) ?? fresh;
    const linkResult = tryAutoLinkSibling({
      target: afterTranscript,
      candidates: videoStore.getAll(),
      actorState,
      threshold: AUTO_LINK_THRESHOLD,
    });
    if (linkResult.linked) {
      onEvent({ type: "stage", record_id: fresh.id, stage: "link_siblings", status: "done", note: `linked → "${linkResult.siblingTitle}" (score ${linkResult.score?.toFixed(2)})` });
      log?.(`Catch-up · sibling linked: "${fresh.title}" ↔ "${linkResult.siblingTitle}" (score ${linkResult.score?.toFixed(2)})`, { video_id: fresh.id });
    } else if (linkResult.reviewNeeded) {
      onEvent({ type: "stage", record_id: fresh.id, stage: "link_siblings", status: "needs_review", note: `"${linkResult.siblingTitle}" at ${linkResult.score?.toFixed(2)} — below auto-link bar (${AUTO_LINK_THRESHOLD})` });
    } else {
      onEvent({ type: "stage", record_id: fresh.id, stage: "link_siblings", status: "n/a", note: "no candidate above review threshold" });
    }

    // Stage: ensure_summary ─────────────────────────────────────
    const afterLink = videoStore.getAll().find(v => v.id === sorted[i].id) ?? fresh;
    const estCost = estimatePerRecordCost(afterLink.transcript_text?.length ?? 0, "google/gemini-2.5-pro");
    if (costSpent + estCost > costCapUsd) {
      onEvent({ type: "stage", record_id: fresh.id, stage: "ensure_summary", status: "skipped", note: `would exceed cost cap (est. ${estCost.toFixed(2)}, spent ${costSpent.toFixed(2)}, cap ${costCapUsd.toFixed(2)})` });
      costCapHit = true;
      processed++;
      onEvent({ type: "record_end", record_id: fresh.id, publishable: isPublishable(afterLink) });
      if (isPublishable(afterLink)) readyToPublish++;
      // Stop processing further records once cap is hit.
      onEvent({ type: "complete", processed, cost_spent_usd: costSpent, ready_to_publish: readyToPublish, cost_cap_hit: true });
      log?.(`Catch-up stopped at cost cap — ${processed}/${sorted.length} processed, $${costSpent.toFixed(2)} spent`);
      return;
    }
    try {
      const result = await tryEnsureSummary({ record: afterLink, currentPromptVersion, actorState, signal });
      if (result.generated) {
        costSpent += estCost;
        onEvent({ type: "stage", record_id: fresh.id, stage: "ensure_summary", status: "done", note: `est. cost $${estCost.toFixed(2)}` });
        log?.(`Catch-up · summarised: "${fresh.title}" (est. $${estCost.toFixed(2)})`, { video_id: fresh.id });
      } else {
        onEvent({ type: "stage", record_id: fresh.id, stage: "ensure_summary", status: result.reason === "current" ? "skipped" : "n/a", note: result.reason });
      }
    } catch (err) {
      if (signal.aborted) { onEvent({ type: "cancelled", processed }); return; }
      onEvent({ type: "stage", record_id: fresh.id, stage: "ensure_summary", status: "failed", note: err instanceof Error ? err.message : String(err) });
      log?.(`Catch-up · summary failed: "${fresh.title}" — ${err instanceof Error ? err.message : String(err)}`, { video_id: fresh.id });
    }

    // End-of-record
    const final = videoStore.getAll().find(v => v.id === sorted[i].id) ?? fresh;
    const publishable = isPublishable(final);
    if (publishable) readyToPublish++;
    processed++;
    onEvent({ type: "record_end", record_id: fresh.id, publishable });
  }

  onEvent({ type: "complete", processed, cost_spent_usd: costSpent, ready_to_publish: readyToPublish, cost_cap_hit: costCapHit });
  log?.(`Catch-up complete — ${processed} record${processed === 1 ? "" : "s"} processed, $${costSpent.toFixed(2)} spent, ${readyToPublish} ready to publish`);
}
