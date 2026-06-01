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
import { runCatchUp, type OrchestratorEvent, type StageId, type StageStatus, AUTO_LINK_THRESHOLD } from "../lib/catchupOrchestrator";

interface Props {
  open: boolean;
  videos: VideoRecordJSON[];
  onEvent?: (msg: string, ctx?: Record<string, unknown>) => void;
  onClose: () => void;
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

export default function CatchUpPanel({ open, videos, onEvent, onClose }: Props) {
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

  // Keep the log pinned to the latest line as it streams.
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logLines]);

  if (!open) return null;

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

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16,
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
          padding: 16, width: "min(960px, 100%)", maxHeight: "90vh", overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>🏃 Catch Up (ADR-047)</h2>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
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
      </div>
    </div>
  );
}
