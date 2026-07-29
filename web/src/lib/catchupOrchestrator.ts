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
import { getDisplayTitle, loadProcessingRules, applyProcessingRules } from "./processingRules";
import { resolveTranscriptForOperation } from "./transcriptProvenance";

/** ADR-049 — broadcaster source platforms (must match siblingMatcher's set). */
const BROADCASTER_PLATFORMS_MIGRATION: ReadonlySet<string> = new Set(["Zoom", "Streamyard", "OBS", "Wirecast"]);

/** Strip the platform prefix from an external_id for cross-role dedupe. */
function stripPlatformPrefix(platform: string, id: string): string {
  const prefix = platform.toLowerCase() + "-";
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

export interface MigrationProgressEvent {
  type: "started" | "record_done" | "complete";
  recordIdx?: number;
  totalRecords?: number;
  recordTitle?: string;
  locationsRemoved?: number;
  relationsReclassified?: number;
  errors?: string[];
  /** Cumulative totals on `complete`. */
  totals?: { locations_removed: number; relations_reclassified: number; records_changed: number };
}

/**
 * ADR-049 slice 5 — operator-invoked migration that fixes pre-existing
 * data the slice-1/2 prevention can't reach:
 *
 * 1. Removes redundant Destination locations whose normalised
 *    (platform, external_id) duplicates the record's Origin. The
 *    canonical 779fabe6 case has Origin "youtube-X" and Destination
 *    "X" pointing at the same YouTube video — the Destination goes.
 *
 * 2. Re-classifies SameEvent upstream_links into BroadcastedFrom when
 *    the pair matches the YouTube-Live + broadcaster-platform shape.
 *    Implemented via unlink_upstream + link_upstream since the
 *    WASM aggregate has no in-place relation edit.
 *
 * Idempotent: re-running on a clean catalog is a no-op. Each per-
 * record mutation goes through the regular videoStore.mutate so the
 * standard persistence + subscribe-driven UI refresh apply.
 */
export async function runBroadcastPairMigration(
  actorState: Parameters<typeof actorCommand>[0],
  onEvent: (ev: MigrationProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<void> {
  const all = videoStore.getAll();
  onEvent({ type: "started", totalRecords: all.length });
  log?.(`Broadcast-pair migration started — ${all.length} record${all.length === 1 ? "" : "s"} to scan`);

  let totalLocations = 0;
  let totalRelations = 0;
  let recordsChanged = 0;

  for (let i = 0; i < all.length; i++) {
    const fresh = videoStore.getAll().find(v => v.id === all[i].id);
    if (!fresh) continue;
    const displayTitle = getDisplayTitle(fresh);
    let locationsRemoved = 0;
    let relationsReclassified = 0;
    const errors: string[] = [];

    // 1) Location dedupe — keep the Origin entry, drop later duplicates
    //    that resolve to the same (platform, normalised id).
    const seen = new Set<string>();
    const toRemove: Array<{ platform: string; external_id: string }> = [];
    const sortedLocations = [...(fresh.locations ?? [])].sort((a, b) => {
      if (a.role === "Origin" && b.role !== "Origin") return -1;
      if (b.role === "Origin" && a.role !== "Origin") return 1;
      return 0;
    });
    for (const loc of sortedLocations) {
      const key = `${loc.platform}::${stripPlatformPrefix(loc.platform, loc.external_id)}`;
      if (seen.has(key)) toRemove.push({ platform: loc.platform, external_id: loc.external_id });
      else seen.add(key);
    }
    for (const r of toRemove) {
      try {
        videoStore.mutate(fresh.id, (rec) =>
          rec.remove_location(actorCommand(actorState, { platform: r.platform, external_id: r.external_id })),
        );
        locationsRemoved++;
      } catch (err) {
        errors.push(`remove ${r.platform}/${r.external_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2) SameEvent → directional reclassification.
    //    - YouTube-Live + meeting-source → BroadcastedFrom (ADR-049 slice 2)
    //    - Fireflies   + meeting-source → TranscribedFrom (extension shipped 2026-06-07)
    const isYtLive = fresh.source_platform === "YouTube"
      && ((fresh.tags ?? []).includes("youtube-live")
          || (fresh.metadata_extra as { live_broadcast?: string } | null)?.live_broadcast === "1");
    const isFireflies = fresh.source_platform === "Fireflies";
    let targetRelation: "BroadcastedFrom" | "TranscribedFrom" | null = null;
    if (isYtLive) targetRelation = "BroadcastedFrom";
    else if (isFireflies) targetRelation = "TranscribedFrom";
    if (targetRelation) {
      for (const link of fresh.upstream_links ?? []) {
        if (link.relation !== "SameEvent") continue;
        if (!BROADCASTER_PLATFORMS_MIGRATION.has(link.platform)) continue;
        try {
          videoStore.mutate(fresh.id, (rec) =>
            rec.unlink_upstream(actorCommand(actorState, { platform: link.platform, external_id: link.external_id })),
          );
          videoStore.mutate(fresh.id, (rec) =>
            rec.link_upstream(actorCommand(actorState, {
              platform: link.platform,
              external_id: link.external_id,
              relation: targetRelation,
              linked_by: link.linked_by,
            })),
          );
          relationsReclassified++;
        } catch (err) {
          errors.push(`reclassify ${link.platform}/${link.external_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    totalLocations += locationsRemoved;
    totalRelations += relationsReclassified;
    if (locationsRemoved > 0 || relationsReclassified > 0) recordsChanged++;

    onEvent({
      type: "record_done",
      recordIdx: i,
      totalRecords: all.length,
      recordTitle: displayTitle,
      locationsRemoved,
      relationsReclassified,
      errors,
    });

    if (locationsRemoved > 0 || relationsReclassified > 0) {
      log?.(`Migrated "${displayTitle}" — removed ${locationsRemoved} dup location(s), reclassified ${relationsReclassified} relation(s)`, { video_id: fresh.id });
    }
    if (errors.length > 0) {
      log?.(`Migration errors on "${displayTitle}": ${errors.join("; ")}`, { video_id: fresh.id });
    }
  }

  onEvent({
    type: "complete",
    totals: { locations_removed: totalLocations, relations_reclassified: totalRelations, records_changed: recordsChanged },
  });
  log?.(`Broadcast-pair migration complete — ${recordsChanged} record${recordsChanged === 1 ? "" : "s"} changed, ${totalLocations} dup location(s) removed, ${totalRelations} relation(s) reclassified`);
}

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

export interface StartedEvent { type: "started"; total: number; max_records: number; job_id: string; job_tag: string; }
export interface CompleteEvent { type: "complete"; processed: number; cost_spent_usd: number; ready_to_publish: number; cost_cap_hit: boolean; job_id: string; job_tag: string; tagged_count: number; }
export interface CancelledEvent { type: "cancelled"; processed: number; job_id: string; job_tag: string; tagged_count: number; }

export type OrchestratorEvent = StartedEvent | RecordStartEvent | StageEvent | RecordEndEvent | CompleteEvent | CancelledEvent;

export interface CatchupOptions {
  /** Cap on how many records to walk. Sorted most-recent first; the
   *  orchestrator processes the top N. Default 5 in the panel; set 1
   *  for a single-record dry run. */
  maxRecords: number;
  costCapUsd: number;
  /** Cancellable. */
  signal: AbortSignal;
  /** Called for every progress event. */
  onEvent: (ev: OrchestratorEvent) => void;
  /** EventLog forwarder for human-readable lines. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
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

function tryAutoLinkSibling({ target, candidates, actorState, threshold }: LinkArgs): { linked: boolean; score?: number; siblingId?: string; siblingTitle?: string; reviewNeeded?: boolean; relation?: string } {
  // Skip if already has any upstream link — the operator has made a decision.
  if ((target.upstream_links?.length ?? 0) > 0) return { linked: false };
  const ranked = rankSiblingCandidates(target, candidates, 3);
  const top = ranked[0];
  if (!top) return { linked: false };
  if (top.score < STAGE_FOR_REVIEW_THRESHOLD) return { linked: false };
  if (top.score < threshold) {
    // Above review threshold but below auto-link bar — banner already
    // shows it in the card; orchestrator notes it as `needs_review`.
    return { linked: false, score: top.score, siblingId: top.video.id, siblingTitle: getDisplayTitle(top.video), reviewNeeded: true };
  }
  // ADR-049: directional relations only get the upstream link on the
  // downstream side. BroadcastedFrom → YouTube-side; TranscribedFrom
  // → Fireflies-side. Wrong-side iterations skip and let the right-
  // side pass handle it.
  if (top.recommendedRelation === "BroadcastedFrom" && target.source_platform !== "YouTube") {
    return { linked: false };
  }
  if (top.recommendedRelation === "TranscribedFrom" && target.source_platform !== "Fireflies") {
    return { linked: false };
  }
  try {
    videoStore.mutate(target.id, (r) =>
      r.link_upstream(actorCommand(actorState, {
        platform: top.video.source_platform,
        external_id: top.video.source_id,
        relation: top.recommendedRelation,
        linked_by: "Auto",
      })),
    );
    return { linked: true, score: top.score, siblingId: top.video.id, siblingTitle: getDisplayTitle(top.video), relation: top.recommendedRelation };
  } catch {
    return { linked: false };
  }
}

export interface SummaryArgs {
  record: VideoRecordJSON;
  currentPromptVersion: number | null;
  actorState: Parameters<typeof actorCommand>[0];
  signal: AbortSignal;
  /** All catalog records — needed for ADR-053 transcript provenance
   *  lookup so we can borrow a sibling's transcript when our own is
   *  empty. Optional for backwards-compat with existing callers that
   *  don't yet pass it; absent → falls back to own-transcript-only. */
  allRecords?: VideoRecordJSON[];
  /** Skip the locked-record gate. ADR-052 backfill exposes this as
   *  an explicit "include locked (override)" checkbox. */
  overrideLock?: boolean;
}

export async function tryEnsureSummary({ record, currentPromptVersion, actorState, signal, allRecords, overrideLock }: SummaryArgs): Promise<{ generated: boolean; reason?: string }> {
  // ADR-053 — try own transcript first; fall back to a donor record
  // linked via a safe relation (SameEvent / BroadcastedFrom /
  // TranscribedFrom). The allRecords arg is optional so existing
  // call-sites that don't pass it keep their no-donor behaviour.
  const resolved = allRecords
    ? resolveTranscriptForOperation(record, allRecords)
    : ((record.transcript_text?.length ?? 0) >= 200
        ? { text: record.transcript_text!, source: { kind: "own" as const } }
        : null);
  if (!resolved) return { generated: false, reason: "no transcript (own or via provenance)" };
  if (record.summary_locked && !overrideLock) return { generated: false, reason: "locked" };
  if (record.summary_doc_id && currentPromptVersion != null && record.summary_prompt_version === currentPromptVersion) {
    return { generated: false, reason: "current" };
  }

  const isBorrowed = resolved.source.kind === "borrowed";
  // ADR-059 — per-record trim inherited from ADR-014 processing
  // rules. Same value the publish path uses for ffmpeg trimming;
  // reused here so summarisation ignores the pre-show window. The
  // rules are cheap to load per record — client-side, localStorage-
  // backed. `applyProcessingRules` returns 0 when nothing matches.
  const trimStartSeconds = (() => {
    try {
      const attrs = applyProcessingRules(loadProcessingRules(), record);
      return Math.max(0, Math.floor(attrs.trim_start_seconds ?? 0));
    } catch { return 0; }
  })();
  const res = await fetch("/api/summary/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      record_id: record.id,
      title: record.title,
      source_platform: record.source_platform,
      source_id: record.source_id,
      recorded_at: record.recorded_at ?? record.indexed_at,
      ...(trimStartSeconds > 0 ? { trim_start_seconds: trimStartSeconds } : {}),
      // ADR-053 — when transcript is borrowed from a paired record,
      // send the text inline so the server doesn't try (and fail) to
      // read the target's own Drive transcript artifact. Also record
      // the donor pointer for audit.
      ...(isBorrowed ? {
        transcript_override: resolved.text,
        transcript_source_record_id: resolved.source.donor_record_id,
      } : {}),
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

/**
 * Make a short, human-readable job id that doubles as the tag. Format
 * `YYYYMMDD-HHmm-XXXX` — sortable, distinguishable across same-minute
 * runs via a random 4-char suffix.
 */
function makeJobId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const datePart = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${datePart}-${rand}`;
}

export async function runCatchUp(opts: CatchupOptions, actorState: Parameters<typeof actorCommand>[0]): Promise<void> {
  const { maxRecords, costCapUsd, signal, onEvent, log } = opts;

  const jobId = makeJobId();
  const jobTag = `catchup:${jobId}`;

  // Build the work list: every record, most-recent-backwards, capped at maxRecords.
  const all = videoStore.getAll();
  const sorted = [...all]
    .sort((a, b) => {
      const ta = new Date(a.recorded_at ?? a.indexed_at).getTime();
      const tb = new Date(b.recorded_at ?? b.indexed_at).getTime();
      return tb - ta;
    })
    .slice(0, Math.max(1, maxRecords));

  onEvent({ type: "started", total: sorted.length, max_records: maxRecords, job_id: jobId, job_tag: jobTag });
  log?.(`Catch-up ${jobId} started — ${sorted.length} record${sorted.length === 1 ? "" : "s"} (most recent first, cap ${maxRecords}). Records changed will be tagged "${jobTag}".`);

  const currentPromptVersion = await getCurrentPromptVersion();
  let costSpent = 0;
  let costCapHit = false;
  let processed = 0;
  let readyToPublish = 0;
  let taggedCount = 0;

  /**
   * Apply the catch-up tag to a record. Idempotent: re-adding an
   * existing tag is a no-op at the field level. Called after each
   * record that had at least one stage do something — pure
   * inspections (everything skipped/n-a) don't tag.
   */
  function tagRecord(recordId: string, currentTags: string[]): boolean {
    if (currentTags.includes(jobTag)) return false;
    const newTags = [...currentTags, jobTag];
    try {
      videoStore.mutate(recordId, (r) =>
        r.update_metadata(actorCommand(actorState, { edits: { tags: newTags } })),
      );
      taggedCount++;
      return true;
    } catch (err) {
      log?.(`Catch-up · tag failed for ${recordId}: ${err instanceof Error ? err.message : String(err)}`, { video_id: recordId });
      return false;
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    if (signal.aborted) {
      onEvent({ type: "cancelled", processed, job_id: jobId, job_tag: jobTag, tagged_count: taggedCount });
      return;
    }
    // Re-read from store so updates from prior records are visible.
    const fresh = videoStore.getAll().find(v => v.id === sorted[i].id);
    if (!fresh) continue;
    let anyStageDone = false;

    // Many records share the same raw title (e.g. recurring meetings);
    // operators disambiguate via processing rules that prefix dates.
    // Surface the processed title in the log so each line is unique.
    const displayTitle = getDisplayTitle(fresh);

    onEvent({ type: "record_start", record_id: fresh.id, title: displayTitle, index: i, total: sorted.length });

    // Stage: hydrate_transcript ─────────────────────────────────
    try {
      if (fresh.source_platform === "Kaltura" && (fresh.transcript_text?.length ?? 0) < 200) {
        const text = await tryHydrateKalturaTranscript(fresh, signal);
        if (text) {
          videoStore.setTranscript(fresh.id, text);
          anyStageDone = true;
          onEvent({ type: "stage", record_id: fresh.id, stage: "hydrate_transcript", status: "done", note: `${text.split("\n").length} lines from Kaltura captions` });
          log?.(`Catch-up · hydrated transcript: "${displayTitle}"`, { video_id: fresh.id });
        } else {
          onEvent({ type: "stage", record_id: fresh.id, stage: "hydrate_transcript", status: "n/a", note: "no captions available" });
        }
      } else {
        onEvent({ type: "stage", record_id: fresh.id, stage: "hydrate_transcript", status: "skipped", note: (fresh.transcript_text?.length ?? 0) >= 200 ? "already present" : "not a Kaltura source" });
      }
    } catch (err) {
      if (signal.aborted) { onEvent({ type: "cancelled", processed, job_id: jobId, job_tag: jobTag, tagged_count: taggedCount }); return; }
      onEvent({ type: "stage", record_id: fresh.id, stage: "hydrate_transcript", status: "failed", note: err instanceof Error ? err.message : String(err) });
      log?.(`Catch-up · transcript fetch failed: "${displayTitle}" — ${err instanceof Error ? err.message : String(err)}`, { video_id: fresh.id });
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
      anyStageDone = true;
      const rel = linkResult.relation ?? "SameEvent";
      const arrow = rel === "BroadcastedFrom" ? "←" : "↔";  // ← signals directional broadcast-source
      onEvent({ type: "stage", record_id: fresh.id, stage: "link_siblings", status: "done", note: `linked (${rel}) ${arrow} "${linkResult.siblingTitle}" (score ${linkResult.score?.toFixed(2)})` });
      log?.(`Catch-up · sibling linked (${rel}): "${displayTitle}" ${arrow} "${linkResult.siblingTitle}" (score ${linkResult.score?.toFixed(2)})`, { video_id: fresh.id });
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
      if (anyStageDone) tagRecord(afterLink.id, afterLink.tags ?? []);
      onEvent({ type: "record_end", record_id: fresh.id, publishable: isPublishable(afterLink) });
      if (isPublishable(afterLink)) readyToPublish++;
      // Stop processing further records once cap is hit.
      onEvent({ type: "complete", processed, cost_spent_usd: costSpent, ready_to_publish: readyToPublish, cost_cap_hit: true, job_id: jobId, job_tag: jobTag, tagged_count: taggedCount });
      log?.(`Catch-up ${jobId} stopped at cost cap — ${processed}/${sorted.length} processed, ${taggedCount} tagged with "${jobTag}", $${costSpent.toFixed(2)} spent`);
      return;
    }
    try {
      const result = await tryEnsureSummary({ record: afterLink, currentPromptVersion, actorState, signal, allRecords: videoStore.getAll() });
      if (result.generated) {
        costSpent += estCost;
        anyStageDone = true;
        onEvent({ type: "stage", record_id: fresh.id, stage: "ensure_summary", status: "done", note: `est. cost $${estCost.toFixed(2)}` });
        log?.(`Catch-up · summarised: "${displayTitle}" (est. $${estCost.toFixed(2)})`, { video_id: fresh.id });
      } else {
        onEvent({ type: "stage", record_id: fresh.id, stage: "ensure_summary", status: result.reason === "current" ? "skipped" : "n/a", note: result.reason });
      }
    } catch (err) {
      if (signal.aborted) { onEvent({ type: "cancelled", processed, job_id: jobId, job_tag: jobTag, tagged_count: taggedCount }); return; }
      onEvent({ type: "stage", record_id: fresh.id, stage: "ensure_summary", status: "failed", note: err instanceof Error ? err.message : String(err) });
      log?.(`Catch-up · summary failed: "${displayTitle}" — ${err instanceof Error ? err.message : String(err)}`, { video_id: fresh.id });
    }

    // End-of-record
    const final = videoStore.getAll().find(v => v.id === sorted[i].id) ?? fresh;
    if (anyStageDone) {
      tagRecord(final.id, final.tags ?? []);
    }
    const publishable = isPublishable(final);
    if (publishable) readyToPublish++;
    processed++;
    onEvent({ type: "record_end", record_id: fresh.id, publishable });
  }

  onEvent({ type: "complete", processed, cost_spent_usd: costSpent, ready_to_publish: readyToPublish, cost_cap_hit: costCapHit, job_id: jobId, job_tag: jobTag, tagged_count: taggedCount });
  log?.(`Catch-up ${jobId} complete — ${processed} processed, ${taggedCount} tagged with "${jobTag}", $${costSpent.toFixed(2)} spent, ${readyToPublish} ready to publish`);
}
