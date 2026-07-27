"use client";

/**
 * ADR-047 — Catch Up panel.
 *
 * One-click batch action that walks records most-recent-backwards and
 * advances each through the pipeline stages the orchestrator covers
 * (currently: hydrate Kaltura captions, auto-link high-confidence
 * siblings, ensure summary). Auto-publish is deferred to a follow-up.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import { useCurrentActor } from "../lib/useCurrentActor";
import { formatUsd, estimatePerRecordCost } from "../lib/llmCost";
import { runCatchUp, runBroadcastPairMigration, type OrchestratorEvent, type StageId, type StageStatus, AUTO_LINK_THRESHOLD, type MigrationProgressEvent } from "../lib/catchupOrchestrator";
import { runYouTubeRowBackfill, findMissingYouTubeRows, type BackfillProgressEvent } from "../lib/youtubeIngest";
import { runSummaryBadgeBackfill, findRecordsNeedingSummaryBadge, type BackfillProgressEvent as SummaryBackfillEvent } from "../lib/summaryBadgeBackfill";
import { getCurrentPromptVersion } from "../lib/summaryPromptClient";
import { runYouTubeTitleAlignBackfill, findRecordsNeedingTitleAlignment, type TitleAlignmentProgressEvent } from "../lib/youtubeTitleAlignBackfill";
import { getSeriesRegistry } from "../lib/seriesRegistryClient";
import type { SeriesRegistryEntry } from "../lib/youtubeTitleAlign";
import { findOrphanClips, runOrphanClipsRepair, type OrphanRepairProgressEvent } from "../lib/orphanClipsRepair";
import { discoverOpusProjects, parseProjectIds, getOpusApiKey, findClipsMissingKeywords, refreshOpusKeywords, type DiscoverProgressEvent, type KeywordsRefreshProgressEvent } from "../lib/opusClipsDiscovery";

interface Props {
  open: boolean;
  videos: VideoRecordJSON[];
  onEvent?: (msg: string, ctx?: Record<string, unknown>) => void;
  onClose: () => void;
  /** ADR-057 Option A: when rendered on a dedicated Maintain page,
   *  we drop the fixed-drawer chrome and let the content sit inline
   *  in the page flow. "drawer" is the historical popover behaviour;
   *  "page" is the new full-canvas mode. Default preserves the
   *  historical drawer semantics. */
  variant?: "drawer" | "page";
}

interface RecordRow {
  id: string;
  title: string;
  stages: Partial<Record<StageId, { status: StageStatus; note?: string }>>;
  publishable: boolean | null;
  finished: boolean;
}

type RunState = "idle" | "running" | "complete" | "cancelled";

const STAGE_LABEL: Record<StageId, string> = {
  hydrate_transcript: "transcript",
  link_siblings: "siblings",
  ensure_summary: "summary",
};

const STATUS_ICON: Record<StageStatus, string> = {
  done: "✓",
  skipped: "·",
  "n/a": "·",
  failed: "✗",
  needs_review: "?",
};

const STATUS_COLOR: Record<StageStatus, string> = {
  done: "var(--green)",
  skipped: "var(--text-muted)",
  "n/a": "var(--text-muted)",
  failed: "var(--red)",
  needs_review: "#fbbf24",
};

export default function CatchUpPanel({ open, videos, onEvent, onClose, variant = "drawer" }: Props) {
  const actorState = useCurrentActor();
  const [maxRecords, setMaxRecords] = useState(1);
  const [costCapUsd, setCostCapUsd] = useState(10);
  const [runState, setRunState] = useState<RunState>("idle");
  const [rows, setRows] = useState<Record<string, RecordRow>>({});
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [summary, setSummary] = useState<{ processed: number; costSpent: number; readyToPublish: number; capHit: boolean; jobTag: string; taggedCount: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Append every event for the downloadable log; stamped with ISO ts.
  const logBufferRef = useRef<Array<{ ts: string; event: OrchestratorEvent }>>([]);
  // Rendered log lines streamed live into the panel.
  const [logLines, setLogLines] = useState<Array<{ ts: string; level: "info" | "warn" | "error"; text: string }>>([]);
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  // Eligible records preview: most-recent-first, capped at maxRecords.
  // Same selection the orchestrator uses, so the est. cost matches what
  // the run will actually spend.
  const eligible = useMemo(() => {
    return [...videos]
      .sort((a, b) => new Date(b.recorded_at ?? b.indexed_at).getTime() - new Date(a.recorded_at ?? a.indexed_at).getTime())
      .slice(0, Math.max(1, maxRecords));
  }, [videos, maxRecords]);

  const summaryCostEstimate = useMemo(() => {
    // Rough preview: sum est cost over records that *would* need a summary.
    return eligible
      .filter(v => (v.transcript_text?.length ?? 0) >= 200 && !v.summary_locked && !v.summary_doc_id)
      .reduce((s, v) => s + estimatePerRecordCost(v.transcript_text?.length ?? 0, "google/gemini-2.5-pro"), 0);
  }, [eligible]);

  // ADR-049 slice 5 — migration state. Distinct from the catch-up
  // RunState since this is a one-shot maintenance pass with different
  // semantics; surfaced inline at the bottom of the panel.
  const [migrating, setMigrating] = useState(false);
  const [migrationSummary, setMigrationSummary] = useState<{ records_changed: number; locations_removed: number; relations_reclassified: number } | null>(null);

  async function runMigration() {
    setMigrating(true);
    setMigrationSummary(null);
    try {
      await runBroadcastPairMigration(
        actorState,
        (ev: MigrationProgressEvent) => {
          if (ev.type === "complete" && ev.totals) setMigrationSummary(ev.totals);
        },
        onEvent,
      );
    } catch (err) {
      onEvent?.(`Migration errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setMigrating(false);
    }
  }

  // ADR-049/050 C1-A — backfill the missing YouTube source rows so the
  // pair-aware UI starts working for historical publishes. Driven off
  // the same actor + event log as the broadcast-pair migration above.
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ index: number; total: number } | null>(null);
  const [backfillSummary, setBackfillSummary] = useState<{ created: number; repaired: number; skipped: number; errors: number } | null>(null);
  const missingYouTubeCount = useMemo(() => findMissingYouTubeRows(videos).length, [videos]);

  async function runBackfill() {
    setBackfilling(true);
    setBackfillProgress(null);
    setBackfillSummary(null);
    try {
      await runYouTubeRowBackfill(
        (ev: BackfillProgressEvent) => {
          if (ev.type === "item_done" && ev.index) {
            setBackfillProgress({ index: ev.index, total: ev.total });
          } else if (ev.type === "complete" && ev.totals) {
            setBackfillSummary(ev.totals);
            setBackfillProgress(null);
          }
        },
        onEvent,
        { actor: actorState.actor },
      );
    } catch (err) {
      onEvent?.(`Backfill errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBackfilling(false);
    }
  }

  // ADR-052 — Summary Badge Backfill state. Walks every record in
  // catalog, regenerates badges for missing + stale. Default skips
  // locked records; the "include locked (override)" checkbox enables
  // re-summarising those too.
  const [summaryBackfilling, setSummaryBackfilling] = useState(false);
  const [summaryIncludeLocked, setSummaryIncludeLocked] = useState(false);
  const [summaryCurrentPromptVersion, setSummaryCurrentPromptVersion] = useState<number | null>(null);
  const [summaryBackfillProgress, setSummaryBackfillProgress] = useState<{ index: number; total: number } | null>(null);
  const [summaryBackfillSummary, setSummaryBackfillSummary] = useState<{ generated: number; skipped: number; errors: number; cost_spent_usd: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCurrentPromptVersion().then((v) => { if (!cancelled) setSummaryCurrentPromptVersion(v); });
    return () => { cancelled = true; };
  }, []);

  const summaryWorkList = useMemo(
    () => findRecordsNeedingSummaryBadge(videos, summaryCurrentPromptVersion, { includeLocked: summaryIncludeLocked }),
    [videos, summaryCurrentPromptVersion, summaryIncludeLocked],
  );
  const summaryWorkCounts = useMemo(() => {
    const missing = summaryWorkList.filter((c) => c.reason === "missing").length;
    const stale = summaryWorkList.filter((c) => c.reason === "stale").length;
    const viaBorrow = summaryWorkList.filter((c) => c.needsBorrowedTranscript).length;
    return { missing, stale, total: summaryWorkList.length, viaBorrow };
  }, [summaryWorkList]);

  async function runSummaryBackfill() {
    setSummaryBackfilling(true);
    setSummaryBackfillProgress(null);
    setSummaryBackfillSummary(null);
    try {
      await runSummaryBadgeBackfill(
        actorState,
        (ev: SummaryBackfillEvent) => {
          if (ev.type === "item_done" && ev.index) {
            setSummaryBackfillProgress({ index: ev.index, total: ev.total });
          } else if (ev.type === "complete" && ev.totals) {
            setSummaryBackfillSummary(ev.totals);
            setSummaryBackfillProgress(null);
          }
        },
        onEvent,
        { includeLocked: summaryIncludeLocked },
      );
    } catch (err) {
      onEvent?.(`Summary backfill errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSummaryBackfilling(false);
    }
  }

  // ADR-055 — YouTube title alignment. Fourth Catch-Up maintenance
  // card. Walks YouTube-source records and applies the resolver
  // (paired-canonical inheritance > series-registry template).
  const [titleAligning, setTitleAligning] = useState(false);
  const [titleAlignProgress, setTitleAlignProgress] = useState<{ index: number; total: number } | null>(null);
  const [titleAlignSummary, setTitleAlignSummary] = useState<{ renamed_via_pair: number; renamed_via_registry: number; skipped: number; errors: number; youtube_pushed: number; youtube_noop: number; youtube_errors: number } | null>(null);
  const [alignPushToYouTube, setAlignPushToYouTube] = useState(false);
  const [alignForce, setAlignForce] = useState(false);
  const [seriesRegistry, setSeriesRegistry] = useState<SeriesRegistryEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    getSeriesRegistry().then((r) => { if (!cancelled) setSeriesRegistry(r); });
    return () => { cancelled = true; };
  }, []);

  const titleAlignWork = useMemo(
    () => findRecordsNeedingTitleAlignment(videos, seriesRegistry, { force: false }),
    [videos, seriesRegistry],
  );
  const titleAlignWorkForced = useMemo(
    () => findRecordsNeedingTitleAlignment(videos, seriesRegistry, { force: true }),
    [videos, seriesRegistry],
  );
  const titleAlignCounts = useMemo(() => {
    const paired = titleAlignWork.filter((c) => c.alignment.source === "paired_canonical").length;
    const registry = titleAlignWork.filter((c) => c.alignment.source === "series_registry").length;
    return { paired, registry, total: titleAlignWork.length };
  }, [titleAlignWork]);
  const titleAlignCountForced = titleAlignWorkForced.length;

  // Orphan-clip repair (ADR-058 follow-up) — finds OpusClip source
  // rows without a ClipOf upstream link and writes one using
  // metadata_extra.parent_video_id. Fixes clips created before
  // ADR-055's ClipOf link addition.
  const [repairingClips, setRepairingClips] = useState(false);
  const [orphanRepairSummary, setOrphanRepairSummary] = useState<{ repaired: number; errors: number } | null>(null);
  const [orphanRepairProgress, setOrphanRepairProgress] = useState<{ index: number; total: number } | null>(null);
  const orphanCount = useMemo(() => findOrphanClips(videos).length, [videos]);

  // Opus discovery — operator pastes project IDs (Opus has no
  // list-all endpoint, so we can't enumerate for them).
  const [opusProjectIdsBlob, setOpusProjectIdsBlob] = useState("");
  const [discoveringOpus, setDiscoveringOpus] = useState(false);
  const [opusDiscoveryProgress, setOpusDiscoveryProgress] = useState<{ index: number; total: number } | null>(null);
  const [opusDiscoverySummary, setOpusDiscoverySummary] = useState<{ discovered: number; indexed: number; skipped: number; errors: number } | null>(null);
  const parsedOpusIds = useMemo(() => parseProjectIds(opusProjectIdsBlob), [opusProjectIdsBlob]);

  // Keyword refresh — walk existing OpusClip rows lacking
  // metadata_extra.keywords and refetch from Opus grouped by jobId.
  const [refreshingKeywords, setRefreshingKeywords] = useState(false);
  const [keywordsRefreshProgress, setKeywordsRefreshProgress] = useState<{ index: number; total: number } | null>(null);
  const [keywordsRefreshSummary, setKeywordsRefreshSummary] = useState<{ updated: number; unchanged: number; errors: number } | null>(null);
  const keywordsNeeded = useMemo(() => findClipsMissingKeywords(videos), [videos]);

  async function runKeywordsRefresh() {
    const key = getOpusApiKey();
    if (!key) {
      onEvent?.("Keyword refresh aborted — OpusClip API key not configured. Add it in Connections.");
      return;
    }
    if (keywordsNeeded.total === 0) return;
    setRefreshingKeywords(true);
    setKeywordsRefreshSummary(null);
    setKeywordsRefreshProgress(null);
    try {
      await refreshOpusKeywords(
        key,
        actorState,
        (ev: KeywordsRefreshProgressEvent) => {
          if (ev.type === "item_done" && ev.index) {
            setKeywordsRefreshProgress({ index: ev.index, total: ev.total });
          } else if (ev.type === "complete" && ev.totals) {
            setKeywordsRefreshSummary(ev.totals);
            setKeywordsRefreshProgress(null);
          }
        },
        onEvent,
      );
    } catch (err) {
      onEvent?.(`Keyword refresh errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRefreshingKeywords(false);
    }
  }

  async function runOpusDiscovery() {
    const key = getOpusApiKey();
    if (!key) {
      onEvent?.("Opus discovery aborted — OpusClip API key not configured. Add it in Connections.");
      return;
    }
    if (parsedOpusIds.length === 0) return;
    setDiscoveringOpus(true);
    setOpusDiscoverySummary(null);
    setOpusDiscoveryProgress(null);
    try {
      await discoverOpusProjects(
        parsedOpusIds,
        key,
        actorState,
        (ev: DiscoverProgressEvent) => {
          if (ev.type === "item_done" && ev.index) {
            setOpusDiscoveryProgress({ index: ev.index, total: ev.total });
          } else if (ev.type === "complete" && ev.totals) {
            setOpusDiscoverySummary(ev.totals);
            setOpusDiscoveryProgress(null);
          }
        },
        onEvent,
      );
    } catch (err) {
      onEvent?.(`Opus discovery errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDiscoveringOpus(false);
    }
  }

  async function runOrphanRepair() {
    setRepairingClips(true);
    setOrphanRepairSummary(null);
    setOrphanRepairProgress(null);
    try {
      await runOrphanClipsRepair(
        actorState,
        (ev: OrphanRepairProgressEvent) => {
          if (ev.type === "item_done" && ev.index) {
            setOrphanRepairProgress({ index: ev.index, total: ev.total });
          } else if (ev.type === "complete" && ev.totals) {
            setOrphanRepairSummary(ev.totals);
            setOrphanRepairProgress(null);
          }
        },
        onEvent,
      );
    } catch (err) {
      onEvent?.(`Orphan-clip repair errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRepairingClips(false);
    }
  }

  async function runTitleAlignBackfill() {
    setTitleAligning(true);
    setTitleAlignProgress(null);
    setTitleAlignSummary(null);
    // Pull YouTube credentials from localStorage when the operator
    // opted into pushing to YouTube — the backfill needs them per
    // record to call videos.update.
    let pushToYouTube: { refreshToken: string; clientId: string; clientSecret: string } | undefined;
    if (alignPushToYouTube) {
      try {
        const raw = localStorage.getItem("video-sync:connections");
        const conns = raw ? JSON.parse(raw) as Record<string, { credentials?: Record<string, string> }> : {};
        const yt = conns["YouTube"]?.credentials;
        if (yt?.refreshToken && yt?.clientId && yt?.clientSecret) {
          pushToYouTube = { refreshToken: yt.refreshToken, clientId: yt.clientId, clientSecret: yt.clientSecret };
        } else {
          onEvent?.("Title alignment: YouTube push requested but no YouTube credentials configured. Skipping push.");
        }
      } catch { /* leave undefined */ }
    }
    try {
      await runYouTubeTitleAlignBackfill(
        actorState,
        (ev: TitleAlignmentProgressEvent) => {
          if (ev.type === "item_done" && ev.index) {
            setTitleAlignProgress({ index: ev.index, total: ev.total });
          } else if (ev.type === "complete" && ev.totals) {
            setTitleAlignSummary(ev.totals);
            setTitleAlignProgress(null);
          }
        },
        onEvent,
        { pushToYouTube, force: alignForce },
      );
    } catch (err) {
      onEvent?.(`Title alignment errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTitleAligning(false);
    }
  }

  // Keep the log pinned to the latest line as it streams.
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logLines]);

  // In drawer mode, hidden = null. In page mode the component IS the
  // page's primary content; render regardless of the (unused) `open`.
  if (variant === "drawer" && !open) return null;

  /** Format an orchestrator event into a single human-readable log line.
   *  Returns null to suppress noisy events (record_start/end already
   *  visible in the per-record table above the log). */
  function formatLogLine(ev: OrchestratorEvent, title: string | undefined): { level: "info" | "warn" | "error"; text: string } | null {
    if (ev.type === "started") {
      return { level: "info", text: `Started — ${ev.total} record${ev.total === 1 ? "" : "s"}, tag ${ev.job_tag}` };
    }
    if (ev.type === "record_start") {
      return { level: "info", text: `▶ (${ev.index + 1}/${ev.total}) ${ev.title}` };
    }
    if (ev.type === "stage") {
      const stageName = ev.stage === "hydrate_transcript" ? "transcript" : ev.stage === "link_siblings" ? "siblings" : "summary";
      const prefix = ev.status === "done" ? "✓"
        : ev.status === "failed" ? "✗"
        : ev.status === "needs_review" ? "?"
        : "·";
      const level: "info" | "warn" | "error" = ev.status === "failed" ? "error" : ev.status === "needs_review" ? "warn" : "info";
      const titlePart = title ? `${title} · ` : "";
      return { level, text: `  ${prefix} ${titlePart}${stageName}: ${ev.status}${ev.note ? ` — ${ev.note}` : ""}` };
    }
    if (ev.type === "record_end") return null;  // covered by stage lines + per-record table
    if (ev.type === "complete") {
      const capPart = ev.cost_cap_hit ? " · stopped at cost cap" : "";
      return { level: "info", text: `✓ Complete — ${ev.processed} processed, ${ev.tagged_count} tagged with ${ev.job_tag}, $${ev.cost_spent_usd.toFixed(2)} spent, ${ev.ready_to_publish} ready to publish${capPart}` };
    }
    if (ev.type === "cancelled") {
      return { level: "warn", text: `✗ Cancelled — ${ev.processed} processed, ${ev.tagged_count} tagged with ${ev.job_tag}` };
    }
    return null;
  }

  function applyEvent(ev: OrchestratorEvent) {
    logBufferRef.current.push({ ts: new Date().toISOString(), event: ev });
    // Resolve the title for stage events so the log line reads
    // naturally. record_start carries title; everything else doesn't,
    // so we look it up from the row map populated by the prior
    // record_start.
    let title: string | undefined;
    if ("record_id" in ev) {
      title = rows[ev.record_id]?.title;
    }
    const line = formatLogLine(ev, title);
    if (line) {
      const ts = new Date().toLocaleTimeString();
      setLogLines(prev => [...prev, { ts, level: line.level, text: line.text }]);
    }
    setRows(prev => {
      const next = { ...prev };
      if (ev.type === "record_start") {
        next[ev.record_id] = { id: ev.record_id, title: ev.title, stages: {}, publishable: null, finished: false };
      } else if (ev.type === "stage") {
        const row = next[ev.record_id];
        if (row) {
          next[ev.record_id] = {
            ...row,
            stages: { ...row.stages, [ev.stage]: { status: ev.status, note: ev.note } },
          };
        }
      } else if (ev.type === "record_end") {
        const row = next[ev.record_id];
        if (row) next[ev.record_id] = { ...row, publishable: ev.publishable, finished: true };
      }
      return next;
    });
    if (ev.type === "started") {
      setOrderedIds([]);
    } else if (ev.type === "record_start") {
      setOrderedIds(prev => prev.includes(ev.record_id) ? prev : [...prev, ev.record_id]);
    } else if (ev.type === "complete") {
      setRunState("complete");
      setSummary({ processed: ev.processed, costSpent: ev.cost_spent_usd, readyToPublish: ev.ready_to_publish, capHit: ev.cost_cap_hit, jobTag: ev.job_tag, taggedCount: ev.tagged_count });
    } else if (ev.type === "cancelled") {
      setRunState("cancelled");
      setSummary({ processed: ev.processed, costSpent: 0, readyToPublish: 0, capHit: false, jobTag: ev.job_tag, taggedCount: ev.tagged_count });
    }
  }

  async function start() {
    setRunState("running");
    setRows({});
    setOrderedIds([]);
    setSummary(null);
    logBufferRef.current = [];
    setLogLines([]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await runCatchUp({
        maxRecords,
        costCapUsd,
        signal: ac.signal,
        onEvent: applyEvent,
        log: onEvent,
      }, actorState);
    } catch (err) {
      onEvent?.(`Catch-up errored: ${err instanceof Error ? err.message : String(err)}`);
      setRunState("cancelled");
    } finally {
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function downloadLog() {
    if (logBufferRef.current.length === 0) return;
    const jobTag = summary?.jobTag ?? "catchup";
    const lines = logBufferRef.current
      .map(entry => JSON.stringify({ ts: entry.ts, ...entry.event }))
      .join("\n");
    const blob = new Blob([lines + "\n"], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${jobTag.replace(":", "-")}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function copyJobTag() {
    if (!summary) return;
    navigator.clipboard?.writeText(summary.jobTag).catch(() => {});
  }

  const isPageMode = variant === "page";
  return (
    <div
      style={
        isPageMode
          ? {
              // Inline on the Maintain page — no fixed positioning, no
              // shadow. Sits in the normal document flow so the sidebar
              // + page header layout it naturally.
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 16,
              marginTop: 8,
            }
          : {
              // Non-blocking side drawer — fixed to the right, doesn't
              // intercept clicks on the rest of the dashboard. Long
              // catch-up runs can stay open while the operator inspects
              // cards in parallel.
              position: "fixed",
              top: 16,
              right: 16,
              bottom: 16,
              width: "min(640px, calc(100vw - 32px))",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 16,
              zIndex: 100,
              overflowY: "auto",
              boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
            }
      }
    >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>🏃 Catch Up (ADR-047)</h2>
          {!isPageMode && <button className="btn btn-sm" onClick={onClose}>Close</button>}
        </div>

        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12 }}>
          Walks records most-recent-backwards and advances each through the pipeline.
          MVP stages: hydrate Kaltura captions · auto-link siblings (≥ {AUTO_LINK_THRESHOLD.toFixed(2)} score) · ensure summary
          (skips locked + current-prompt). Auto-publish is deferred — when this run finishes, the bottom of the panel
          tells you which records are ready for you to click Publish on.
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 12, flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.78rem" }}>
            Records
            <input
              type="number"
              min={1}
              max={1000}
              value={maxRecords}
              onChange={e => setMaxRecords(Math.max(1, Number(e.target.value) || 1))}
              disabled={runState === "running"}
              title="How many most-recent records to walk. Start with 1 for a dry run."
              style={{ width: 80, padding: 4, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.78rem" }}>
            Cost cap (USD)
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={costCapUsd}
              onChange={e => setCostCapUsd(Number(e.target.value) || 10)}
              disabled={runState === "running"}
              style={{ width: 80, padding: 4, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)" }}
            />
          </label>
          <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
            Will walk <strong>{eligible.length}</strong> record{eligible.length === 1 ? "" : "s"} (most recent first) · est. summary cost <strong>{formatUsd(summaryCostEstimate)}</strong>
          </div>
          {runState === "running" ? (
            <button className="btn btn-sm btn-red" onClick={cancel}>Cancel</button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={start} disabled={eligible.length === 0}>
              {runState === "idle" ? "Run catch-up" : "Run again"}
            </button>
          )}
        </div>

        {/* Live per-record progress */}
        {orderedIds.length > 0 && (
          <div style={{ marginTop: 8, padding: 10, background: "rgba(125,211,252,0.05)", border: "1px solid rgba(125,211,252,0.2)", borderRadius: 4, fontSize: "0.78rem", maxHeight: "50vh", overflowY: "auto" }}>
            {orderedIds.map(id => {
              const row = rows[id];
              if (!row) return null;
              return (
                <div key={id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "4px 0", borderBottom: "1px dashed var(--border)", flexWrap: "wrap" }}>
                  <span style={{ flex: "1 1 240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.title}
                  </span>
                  {(["hydrate_transcript", "link_siblings", "ensure_summary"] as StageId[]).map(stage => {
                    const s = row.stages[stage];
                    return (
                      <span
                        key={stage}
                        title={s ? `${STAGE_LABEL[stage]}: ${s.status}${s.note ? ` (${s.note})` : ""}` : `${STAGE_LABEL[stage]}: pending`}
                        style={{
                          color: s ? STATUS_COLOR[s.status] : "var(--text-muted)",
                          fontVariantNumeric: "tabular-nums",
                          minWidth: 90,
                          fontSize: "0.72rem",
                        }}
                      >
                        {s ? STATUS_ICON[s.status] : "…"} {STAGE_LABEL[stage]}
                      </span>
                    );
                  })}
                  {row.finished && row.publishable && (
                    <span style={{ fontSize: "0.72rem", color: "var(--green)" }}>ready to publish</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Live event log — shows every stage transition with timestamps.
            Streamed in real time; auto-scrolls to the latest line. */}
        {logLines.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-muted)" }}>
                Log · {logLines.length} event{logLines.length === 1 ? "" : "s"}
              </span>
              <button
                className="btn btn-sm"
                style={{ fontSize: "0.7rem" }}
                onClick={downloadLog}
                disabled={logBufferRef.current.length === 0}
                title="Download the full event log as JSONL (one JSON object per line) for archival or audit"
              >
                Download .jsonl
              </button>
            </div>
            <div
              ref={logScrollRef}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "6px 8px",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.72rem",
                lineHeight: 1.4,
                maxHeight: "30vh",
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {logLines.map((line, i) => (
                <div
                  key={i}
                  style={{
                    color: line.level === "error" ? "var(--red)" : line.level === "warn" ? "#fbbf24" : "var(--text)",
                  }}
                >
                  <span style={{ color: "var(--text-muted)" }}>{line.ts}</span> {line.text}
                </div>
              ))}
            </div>
          </div>
        )}

        {summary && (
          <div style={{ marginTop: 12, padding: 10, background: "rgba(34,197,94,0.05)", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 4, fontSize: "0.85rem" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {runState === "complete" ? "Catch-up complete" : "Catch-up cancelled"}
            </div>
            <div>
              {summary.processed} record{summary.processed === 1 ? "" : "s"} processed · spent {formatUsd(summary.costSpent)}
              {summary.capHit && <> · <strong>stopped at cost cap</strong></>}
            </div>
            {summary.taggedCount > 0 && (
              <div style={{ marginTop: 6, padding: 8, background: "rgba(168,85,247,0.08)", border: "1px dashed rgba(168,85,247,0.4)", borderRadius: 4 }}>
                <div style={{ marginBottom: 6 }}>
                  Tagged <strong>{summary.taggedCount}</strong> record{summary.taggedCount === 1 ? "" : "s"} with{" "}
                  <code style={{ background: "var(--bg)", padding: "1px 5px", borderRadius: 3, fontSize: "0.8rem" }}>{summary.jobTag}</code>.
                  Paste the tag into the dashboard search box to filter to just these records for manual inspection.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn-sm" onClick={copyJobTag} title="Copy the catchup tag to clipboard so you can paste it into the search box">
                    Copy tag
                  </button>
                </div>
              </div>
            )}
            {summary.taggedCount === 0 && (
              <div style={{ marginTop: 4, color: "var(--text-muted)", fontStyle: "italic" }}>
                Nothing changed — every record was already current. No tag applied.
              </div>
            )}
            {summary.readyToPublish > 0 && (
              <div style={{ marginTop: 6 }}>
                <strong>{summary.readyToPublish} record{summary.readyToPublish === 1 ? "" : "s"} ready to publish</strong> — open each card and click Publish.
              </div>
            )}
          </div>
        )}

        {/* ADR-049 slice 5 — one-shot migration that cleans up
            pre-existing duplicate locations and reclassifies SameEvent
            upstream-links into BroadcastedFrom for YouTube-Live ↔
            broadcaster-platform pairs. Idempotent; safe to re-run. */}
        <div style={{
          marginTop: 16, padding: 10,
          background: "rgba(168,85,247,0.05)", border: "1px solid rgba(168,85,247,0.25)", borderRadius: 4,
          fontSize: "0.82rem",
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>🔧 Broadcast-pair migration (ADR-049 slice 5)</div>
          <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>
            One-time cleanup: removes duplicate same-video location entries (Origin + Destination of the same id)
            and reclassifies <code>SameEvent</code> upstream links into <code>BroadcastedFrom</code> for
            YouTube-Live ↔ Zoom/Streamyard/OBS/Wirecast pairs. Idempotent; safe to run multiple times.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={runMigration}
              disabled={migrating}
            >
              {migrating ? "Migrating…" : "Run migration"}
            </button>
            {migrationSummary && (
              <span style={{ color: "var(--text-muted)" }}>
                Last run: {migrationSummary.records_changed} record(s) changed ·{" "}
                {migrationSummary.locations_removed} duplicate location(s) removed ·{" "}
                {migrationSummary.relations_reclassified} relation(s) reclassified.
              </span>
            )}
          </div>
        </div>

        {/* ADR-049/050 C1-A — backfill the YouTube source rows for past
            publishes. Without this, every Destination YouTube location
            on the catalog has no corresponding source row, so ADR-049's
            pair-aware UI (📺 badges, "already published" gating) stays
            a no-op for historical publishes. Forward publishes are now
            auto-ingested via ADR-049/050 C3. */}
        <div style={{
          marginTop: 12, padding: 10,
          background: "rgba(34,197,94,0.05)", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 4,
          fontSize: "0.82rem",
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>📺 YouTube row backfill (ADR-049/050 C1-A)</div>
          <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>
            One-time backfill: for each Destination YouTube location on a host record that has no
            matching YouTube source row, fetch metadata via the YouTube Data API, create the source
            row, and write the right <code>BroadcastedFrom</code> upstream link per ADR-049/050.
            Idempotent — already-ingested rows are skipped automatically.
            {missingYouTubeCount > 0 && (
              <> <strong>{missingYouTubeCount}</strong> missing row{missingYouTubeCount === 1 ? "" : "s"} detected.</>
            )}
            {missingYouTubeCount === 0 && <> No missing rows detected.</>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={runBackfill}
              disabled={backfilling || missingYouTubeCount === 0}
            >
              {backfilling
                ? backfillProgress ? `Backfilling ${backfillProgress.index}/${backfillProgress.total}…` : "Backfilling…"
                : `Run backfill${missingYouTubeCount ? ` (${missingYouTubeCount})` : ""}`}
            </button>
            {backfillSummary && (
              <span style={{ color: "var(--text-muted)" }}>
                Last run: {backfillSummary.created} created ·{" "}
                {backfillSummary.repaired} repaired (link added) ·{" "}
                {backfillSummary.skipped} skipped (already complete) ·{" "}
                {backfillSummary.errors} error{backfillSummary.errors === 1 ? "" : "s"}.
              </span>
            )}
          </div>
        </div>

        {/* ADR-052 — Summary Badge Backfill. Walks every record with a
            usable transcript (own or borrowed via ADR-053) and
            generates / refreshes the 📄 badge. */}
        <div style={{
          marginTop: 12, padding: 10,
          background: "rgba(96,165,250,0.05)", border: "1px solid rgba(96,165,250,0.25)", borderRadius: 4,
          fontSize: "0.82rem",
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>📄 Summary badge backfill (ADR-052)</div>
          <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>
            Walks every record with a usable transcript (own or borrowed via paired Fireflies / Zoom / YouTube / Kaltura per ADR-053)
            and generates summary badges that are missing or stale (prompt version drifted). Default skips locked records.
            {summaryCurrentPromptVersion != null && (
              <> Current prompt version: <strong>v{summaryCurrentPromptVersion}</strong>.</>
            )}
            {summaryWorkCounts.total > 0 ? (
              <>
                {" "}<strong>{summaryWorkCounts.total}</strong> eligible (
                {summaryWorkCounts.missing} missing, {summaryWorkCounts.stale} stale
                {summaryWorkCounts.viaBorrow > 0 && <>, {summaryWorkCounts.viaBorrow} via borrowed transcript</>}
                ).
              </>
            ) : (
              <> All badges current.</>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={runSummaryBackfill}
              disabled={summaryBackfilling || summaryWorkCounts.total === 0}
            >
              {summaryBackfilling
                ? summaryBackfillProgress ? `Generating ${summaryBackfillProgress.index}/${summaryBackfillProgress.total}…` : "Generating…"
                : `Run backfill${summaryWorkCounts.total ? ` (${summaryWorkCounts.total})` : ""}`}
            </button>
            <label style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={summaryIncludeLocked}
                onChange={(e) => setSummaryIncludeLocked(e.target.checked)}
                disabled={summaryBackfilling}
              />
              Include locked records (override)
            </label>
            {summaryBackfillSummary && (
              <span style={{ color: "var(--text-muted)" }}>
                Last run: {summaryBackfillSummary.generated} generated ·{" "}
                {summaryBackfillSummary.skipped} skipped ·{" "}
                {summaryBackfillSummary.errors} error{summaryBackfillSummary.errors === 1 ? "" : "s"} ·{" "}
                ${summaryBackfillSummary.cost_spent_usd.toFixed(2)} spent.
              </span>
            )}
          </div>
        </div>

        {/* ADR-055 — YouTube title alignment. Fourth maintenance card.
            Rewrites undated YouTube-source titles to the dated form
            used elsewhere in the catalog (paired-canonical
            inheritance first, series-registry template as fallback). */}
        <div style={{
          marginTop: 12, padding: 10,
          background: "rgba(251,146,60,0.05)", border: "1px solid rgba(251,146,60,0.25)", borderRadius: 4,
          fontSize: "0.82rem",
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>🏷️ Catalog title alignment (ADR-055/056)</div>
          <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>
            Rewrites undated series-named titles ("AI Hackerspace Live") to the dated form
            ("AI Hackerspace Live - 6 Feb 2026") across every source platform. Prefers the
            paired canonical's title (Zoom / Fireflies / YouTube via SameEvent, BroadcastedFrom,
            or TranscribedFrom); falls back to the series registry when no dated canonical
            exists. Skips already-dated titles.
            {titleAlignCounts.total > 0 ? (
              <>
                {" "}<strong>{titleAlignCounts.total}</strong> eligible (
                {titleAlignCounts.paired} via paired canonical
                {titleAlignCounts.registry > 0 && <>, {titleAlignCounts.registry} via series registry</>}
                ).
              </>
            ) : (
              <> All YouTube titles aligned{seriesRegistry.length === 0 ? " (registry is empty — only paired-canonical strategy is active)" : ""}.</>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={runTitleAlignBackfill}
              disabled={titleAligning || (alignForce ? titleAlignCountForced === 0 : titleAlignCounts.total === 0)}
            >
              {titleAligning
                ? titleAlignProgress ? `Renaming ${titleAlignProgress.index}/${titleAlignProgress.total}…` : "Renaming…"
                : `Run alignment${(alignForce ? titleAlignCountForced : titleAlignCounts.total) ? ` (${alignForce ? titleAlignCountForced : titleAlignCounts.total})` : ""}`}
            </button>
            <label style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}
              title="Widen the sweep to already-dated records so newly-added series aliases can reshape their titles. Uses metadata_extra.<platform>_original_title (populated at ingest) to re-run resolution."
            >
              <input
                type="checkbox"
                checked={alignForce}
                onChange={(e) => setAlignForce(e.target.checked)}
                disabled={titleAligning}
              />
              Include already-dated titles ({titleAlignCountForced})
            </label>
            <label style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}
              title="For every record whose local title is rewritten, also PUT the new title to the actual YouTube video via videos.update. Requires the youtube.force-ssl OAuth scope — if the operator authorised YouTube before ADR-029 landed, re-connect in Connections."
            >
              <input
                type="checkbox"
                checked={alignPushToYouTube}
                onChange={(e) => setAlignPushToYouTube(e.target.checked)}
                disabled={titleAligning}
              />
              Also push to YouTube
            </label>
            {titleAlignSummary && (
              <span style={{ color: "var(--text-muted)" }}>
                Last run: {titleAlignSummary.renamed_via_pair} via pair ·{" "}
                {titleAlignSummary.renamed_via_registry} via registry ·{" "}
                {titleAlignSummary.errors} error{titleAlignSummary.errors === 1 ? "" : "s"}
                {(titleAlignSummary.youtube_pushed + titleAlignSummary.youtube_noop + titleAlignSummary.youtube_errors) > 0 && (
                  <>
                    {" · "}YouTube: {titleAlignSummary.youtube_pushed} pushed
                    {titleAlignSummary.youtube_noop > 0 && <>, {titleAlignSummary.youtube_noop} already matched</>}
                    {titleAlignSummary.youtube_errors > 0 && <>, {titleAlignSummary.youtube_errors} error{titleAlignSummary.youtube_errors === 1 ? "" : "s"}</>}
                  </>
                )}
                .
              </span>
            )}
          </div>
        </div>

        {/* Repair shorts→video links (ADR-058 follow-up). Finds
            OpusClip source rows without a ClipOf upstream_link and
            writes one from metadata_extra.parent_video_id — fixes
            clips created before ADR-055's link-addition landed. */}
        <div style={{
          marginTop: 12, padding: 10,
          background: "rgba(20,184,166,0.05)", border: "1px solid rgba(20,184,166,0.28)", borderRadius: 4,
          fontSize: "0.82rem",
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>✂️ Shorts → video linkage repair</div>
          <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>
            Finds OpusClip records that are missing their <code>ClipOf</code> upstream link and reconstructs it
            from the clip's <code>metadata_extra.parent_video_id</code>. Clips created before ADR-055 shipped
            (or from a partial ingest) show up detached in the Provenance graph — this fixes that.
            {orphanCount > 0 ? (
              <> <strong>{orphanCount}</strong> orphan clip{orphanCount === 1 ? "" : "s"} detected.</>
            ) : (
              <> No orphan clips detected.</>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={runOrphanRepair}
              disabled={repairingClips || orphanCount === 0}
            >
              {repairingClips
                ? orphanRepairProgress ? `Repairing ${orphanRepairProgress.index}/${orphanRepairProgress.total}…` : "Repairing…"
                : `Repair links${orphanCount ? ` (${orphanCount})` : ""}`}
            </button>
            {orphanRepairSummary && (
              <span style={{ color: "var(--text-muted)" }}>
                Last run: {orphanRepairSummary.repaired} linked ·{" "}
                {orphanRepairSummary.errors} error{orphanRepairSummary.errors === 1 ? "" : "s"}.
              </span>
            )}
          </div>

          {/* Discover from Opus — paste project IDs / clip.opus.pro URLs. */}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed rgba(20,184,166,0.28)" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>🔍 Discover clips from Opus Clip</div>
            <div style={{ color: "var(--text-muted)", marginBottom: 6, fontSize: "0.78rem" }}>
              Opus has no "list my projects" endpoint, so paste project IDs (or full <code>clip.opus.pro/clip/…</code> URLs) — one per line
              or comma-separated. For each, we call Opus, match the parent by the source YouTube URL, and ingest any clips missing from
              the catalog with a proper <code>ClipOf</code> link. Already-present clips are skipped.
            </div>
            <textarea
              value={opusProjectIdsBlob}
              onChange={(e) => setOpusProjectIdsBlob(e.target.value)}
              placeholder="P30726134uS0&#10;https://clip.opus.pro/clip/P30726134uS1&#10;…"
              rows={3}
              disabled={discoveringOpus}
              style={{
                width: "100%", padding: "6px 8px", fontFamily: "monospace",
                fontSize: "0.78rem", background: "var(--bg)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 4, marginBottom: 6,
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                className="btn btn-sm btn-primary"
                onClick={runOpusDiscovery}
                disabled={discoveringOpus || parsedOpusIds.length === 0}
              >
                {discoveringOpus
                  ? opusDiscoveryProgress ? `Discovering ${opusDiscoveryProgress.index}/${opusDiscoveryProgress.total}…` : "Discovering…"
                  : `Discover from Opus${parsedOpusIds.length ? ` (${parsedOpusIds.length})` : ""}`}
              </button>
              {opusDiscoverySummary && (
                <span style={{ color: "var(--text-muted)" }}>
                  Last run: {opusDiscoverySummary.indexed} clip(s) indexed across {opusDiscoverySummary.discovered} project(s) ·{" "}
                  {opusDiscoverySummary.skipped} skipped ·{" "}
                  {opusDiscoverySummary.errors} error{opusDiscoverySummary.errors === 1 ? "" : "s"}.
                </span>
              )}
            </div>
          </div>

          {/* Refresh keywords — walks OpusClip rows missing keywords
              and one-shots each unique project id back through
              /api/shorts/status to pull them in. */}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed rgba(20,184,166,0.28)" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>🏷️ Refresh clip keywords</div>
            <div style={{ color: "var(--text-muted)", marginBottom: 6, fontSize: "0.78rem" }}>
              Clips indexed before keyword capture landed show their title in the collapsible list under the parent VideoCard instead of
              Opus's keyword tags. This pass re-fetches each clip's keywords from Opus (one call per project) and merges them into
              <code> metadata_extra.keywords</code>. Idempotent — clips that already have keywords are left alone.
              {keywordsNeeded.total > 0 ? (
                <> <strong>{keywordsNeeded.total}</strong> clip{keywordsNeeded.total === 1 ? "" : "s"} across {keywordsNeeded.jobs.size} project{keywordsNeeded.jobs.size === 1 ? "" : "s"} need refreshing.</>
              ) : (
                <> All clip rows have keywords.</>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                className="btn btn-sm btn-primary"
                onClick={runKeywordsRefresh}
                disabled={refreshingKeywords || keywordsNeeded.total === 0}
              >
                {refreshingKeywords
                  ? keywordsRefreshProgress ? `Refreshing ${keywordsRefreshProgress.index}/${keywordsRefreshProgress.total}…` : "Refreshing…"
                  : `Refresh keywords${keywordsNeeded.total ? ` (${keywordsNeeded.total})` : ""}`}
              </button>
              {keywordsRefreshSummary && (
                <span style={{ color: "var(--text-muted)" }}>
                  Last run: {keywordsRefreshSummary.updated} row(s) updated ·{" "}
                  {keywordsRefreshSummary.unchanged} unchanged ·{" "}
                  {keywordsRefreshSummary.errors} error{keywordsRefreshSummary.errors === 1 ? "" : "s"}.
                </span>
              )}
            </div>
          </div>
        </div>
    </div>
  );
}
