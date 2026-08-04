"use client";

/**
 * ADR-046 slice 4 — admin panel for editing the org-shared summary
 * prompt and kicking off bulk regeneration of unlocked summaries.
 *
 * Admin-only. The PUT endpoint enforces the role; this UI also hides
 * the editor when the current actor isn't Admin (for clarity, not
 * security — the API is the boundary).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import { useCurrentActor } from "../lib/useCurrentActor";
import { videoStore } from "../lib/store";
import { actorCommand } from "../lib/useCurrentActor";
import { invalidateCurrentPromptVersion } from "../lib/summaryPromptClient";
import { estimatePerRecordCost, estimateBatchCost, formatUsd, isKnownModel } from "../lib/llmCost";

interface Props {
  open: boolean;
  videos: VideoRecordJSON[];
  onEvent?: (msg: string, ctx?: Record<string, unknown>) => void;
  onClose: () => void;
}

interface PromptVersion {
  version: number;
  text: string;
  model: string;
  updated_at: string;
  updated_by: string;
}

interface SseRecordDone {
  record_id: string;
  title: string;
  doc_id: string;
  doc_url?: string;
  counts: { m: number; l: number; t: number; c: number };
  prompt_version: number;
  generated_at: string;
  cost_so_far_usd: number;
  index: number;
}

type RunState = "idle" | "running" | "paused" | "complete" | "cancelled" | "failed";

export default function SummaryPromptPanel({ open, videos, onEvent, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [open]);
  const actorState = useCurrentActor();
  const isAdmin = actorState.actor?.role === "Admin";

  const [prompt, setPrompt] = useState<PromptVersion | null>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [costCapUsd, setCostCapUsd] = useState(5);
  const [runState, setRunState] = useState<RunState>("idle");
  const [runProgress, setRunProgress] = useState<{ processed: number; failed: number; total: number; costSoFar: number; currentTitle: string | null; lastError: string | null }>({
    processed: 0, failed: 0, total: 0, costSoFar: 0, currentTitle: null, lastError: null,
  });
  const [abort, setAbort] = useState<AbortController | null>(null);

  // Load the current prompt on mount.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/summary/prompt", { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((p: PromptVersion) => {
        if (cancelled) return;
        setPrompt(p);
        setText(p.text);
        setModel(p.model);
      })
      .catch(err => { if (!cancelled) setLoadError(String(err)); });
    return () => { cancelled = true; };
  }, [open]);

  // Eligible records for bulk regen: have a transcript ≥200 chars AND
  // aren't locked. Estimated cost computed per record from the editor's
  // model (so changing the model in the editor updates the estimate).
  const eligible = useMemo(() => {
    return videos
      .filter(v => !v.summary_locked && (v.transcript_text?.length ?? 0) >= 200)
      .map(v => ({
        record_id: v.id,
        title: v.title,
        source_platform: v.source_platform,
        source_id: v.source_id,
        recorded_at: v.recorded_at ?? new Date().toISOString(),
        transcript_chars: v.transcript_text?.length ?? 0,
        estimated_cost_usd: estimatePerRecordCost(v.transcript_text?.length ?? 0, model),
      }));
  }, [videos, model]);

  const estimatedBatchCost = useMemo(
    () => estimateBatchCost(eligible.map(e => ({ transcript_chars: e.transcript_chars })), model),
    [eligible, model],
  );

  if (!open) return null;

  async function savePrompt() {
    if (!text.trim() || !model.trim()) {
      setSaveError("Prompt text and model are both required.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/summary/prompt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), model: model.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const updated: PromptVersion = await res.json();
      setPrompt(updated);
      invalidateCurrentPromptVersion();
      onEvent?.(`Summary prompt updated to v${updated.version}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function startRegen() {
    if (!prompt || eligible.length === 0) return;
    setRunState("running");
    setRunProgress({ processed: 0, failed: 0, total: eligible.length, costSoFar: 0, currentTitle: null, lastError: null });

    const ac = new AbortController();
    setAbort(ac);

    onEvent?.(`Summary regen started — ${eligible.length} record${eligible.length === 1 ? "" : "s"}, est. ${formatUsd(estimatedBatchCost)}, cap ${formatUsd(costCapUsd)}, prompt v${prompt.version}`);

    try {
      const res = await fetch("/api/summary/regen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queue: eligible.map(({ record_id, title, source_platform, source_id, recorded_at, estimated_cost_usd }) =>
            ({ record_id, title, source_platform, source_id, recorded_at, estimated_cost_usd })),
          cost_cap_usd: costCapUsd,
          prompt_version: prompt.version,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      // Parse SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evLine = chunk.split("\n").find(l => l.startsWith("event:"));
          const dataLine = chunk.split("\n").find(l => l.startsWith("data:"));
          if (!evLine || !dataLine) continue;
          const event = evLine.slice("event:".length).trim();
          let data: Record<string, unknown> = {};
          try { data = JSON.parse(dataLine.slice("data:".length).trim()); } catch { continue; }

          if (event === "record_done") {
            const d = data as unknown as SseRecordDone;
            // Stamp the WASM record so the catalog tracks it and the
            // lozenge flips live without a refresh.
            try {
              videoStore.mutate(d.record_id, (r) =>
                r.set_summary_metadata(actorCommand(actorState, {
                  doc_id: d.doc_id,
                  prompt_version: d.prompt_version,
                  counts: d.counts,
                  generated_at: d.generated_at,
                })),
              );
            } catch (e) {
              onEvent?.(`Regen mutation skipped for ${d.title}: ${e instanceof Error ? e.message : String(e)}`, { video_id: d.record_id });
            }
            setRunProgress(p => ({
              ...p,
              processed: p.processed + 1,
              costSoFar: d.cost_so_far_usd,
              currentTitle: d.title,
            }));
            onEvent?.(`Regen done: "${d.title}" → prompt v${d.prompt_version} · M:${d.counts.m} L:${d.counts.l} T:${d.counts.t} C:${d.counts.c}`, { video_id: d.record_id });
          } else if (event === "record_failed") {
            const d = data as { record_id: string; title: string; error: string };
            setRunProgress(p => ({ ...p, failed: p.failed + 1, lastError: d.error, currentTitle: d.title }));
            onEvent?.(`Regen failed: "${d.title}" — ${d.error}`, { video_id: d.record_id });
          } else if (event === "paused") {
            const d = data as { reason: string; cost_so_far_usd: number };
            setRunState(d.reason === "cancelled" ? "cancelled" : "paused");
            setRunProgress(p => ({ ...p, costSoFar: d.cost_so_far_usd }));
            onEvent?.(`Regen ${d.reason === "cancelled" ? "cancelled" : "paused at cost cap"} after ${runProgress.processed}/${runProgress.total} — ${formatUsd(d.cost_so_far_usd)}`);
          } else if (event === "complete") {
            const d = data as { processed: number; failed: number; cost_so_far_usd: number };
            setRunState("complete");
            setRunProgress(p => ({ ...p, processed: d.processed, failed: d.failed, costSoFar: d.cost_so_far_usd, currentTitle: null }));
            onEvent?.(`Regen complete — ${d.processed} done, ${d.failed} failed, ${formatUsd(d.cost_so_far_usd)}`);
          }
        }
      }
      // If the stream closed without a paused/complete event, treat as cancelled.
      setRunState(s => s === "running" ? "cancelled" : s);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("aborted")) {
        setRunState("cancelled");
      } else {
        setRunState("failed");
        setRunProgress(p => ({ ...p, lastError: msg }));
      }
    } finally {
      setAbort(null);
    }
  }

  function cancelRegen() {
    abort?.abort();
  }

  const modelKnown = isKnownModel(model.trim());

  return (
    // Non-blocking side drawer (mirrors CatchUpPanel) — fixed to the
    // right, doesn't intercept clicks on the rest of the dashboard so
    // long bulk-regen runs can stay open while the operator inspects
    // cards in parallel.
    <div
      ref={panelRef}
      tabIndex={-1}
      id="summary-prompt-panel"
      role="dialog"
      aria-labelledby="summary-prompt-heading"
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        bottom: 16,
        width: "min(640px, calc(100% - 32px))",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
        zIndex: 100,
        overflowY: "auto",
        boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
      }}
    >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 id="summary-prompt-heading" style={{ margin: 0, fontSize: "1.1rem" }}>Summary prompt</h2>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>

        {!isAdmin && (
          <div style={{ padding: 12, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 6, marginBottom: 12, fontSize: "0.85rem" }}>
            Admin role required to edit the prompt or run bulk regeneration. You can still see the current prompt below.
          </div>
        )}

        {loadError && (
          <div role="alert" style={{ color: "var(--red)", fontSize: "0.85rem", marginBottom: 12 }}>
            Failed to load prompt: {loadError}
          </div>
        )}

        {prompt && (
          <>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: 8 }}>
              Current: <strong>v{prompt.version}</strong> · {prompt.model} · updated {new Date(prompt.updated_at).toLocaleString()} by {prompt.updated_by}
            </div>

            <label htmlFor="summary-prompt-text" style={{ display: "block", fontSize: "0.78rem", marginTop: 8, marginBottom: 4 }}>Prompt text</label>
            <textarea
              id="summary-prompt-text"
              value={text}
              onChange={e => setText(e.target.value)}
              disabled={!isAdmin || saving}
              rows={16}
              style={{ width: "100%", fontFamily: "monospace", fontSize: "0.78rem", padding: 8, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)" }}
            />

            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 280px" }}>
                <label htmlFor="summary-prompt-model" style={{ display: "block", fontSize: "0.78rem", marginBottom: 4 }}>Model (OpenRouter slug)</label>
                <input
                  id="summary-prompt-model"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  disabled={!isAdmin || saving}
                  style={{ width: "100%", padding: 6, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontFamily: "monospace", fontSize: "0.82rem" }}
                  placeholder="google/gemini-2.5-pro"
                />
                {!modelKnown && model.trim() && (
                  <div style={{ fontSize: "0.7rem", color: "var(--yellow, #f5a623)", marginTop: 2 }}>
                    Unknown model slug — cost estimate falls back to a generic rate.
                  </div>
                )}
              </div>
              <div>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={savePrompt}
                  disabled={!isAdmin || saving || (text === prompt.text && model === prompt.model)}
                  title={text === prompt.text && model === prompt.model ? "No changes to save" : "Bump prompt version"}
                >
                  {saving ? "Saving…" : `Save (bump to v${prompt.version + 1})`}
                </button>
              </div>
            </div>
            {saveError && (
              <div role="alert" style={{ color: "var(--red)", fontSize: "0.85rem", marginTop: 8 }}>Save error: {saveError}</div>
            )}

            {/* Bulk regen CTA */}
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 12 }}>
              <div style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: 6 }}>Bulk regenerate</div>
              <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginBottom: 10 }}>
                {eligible.length} unlocked record{eligible.length === 1 ? "" : "s"} with transcript ready
                {eligible.length > 0 && <> · est. <strong>{formatUsd(estimatedBatchCost)}</strong> total at the editor's model</>}
                .
                Locked records (🔒) are skipped.
              </div>

              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.85rem" }}>
                  Cost cap
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={costCapUsd}
                    onChange={e => setCostCapUsd(Number(e.target.value) || 5)}
                    disabled={runState === "running" || !isAdmin}
                    style={{ width: 80, padding: 4, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)" }}
                  />
                  USD
                </label>
                {runState === "running" ? (
                  <button className="btn btn-sm btn-red" onClick={cancelRegen}>Cancel</button>
                ) : (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={startRegen}
                    disabled={!isAdmin || eligible.length === 0}
                    title={eligible.length === 0 ? "Nothing eligible — every unlocked record with a transcript already gets included" : "Run regeneration"}
                  >
                    {runState === "complete" || runState === "cancelled" || runState === "paused" || runState === "failed" ? "Run again" : `Regenerate ${eligible.length} — ${formatUsd(estimatedBatchCost)}`}
                  </button>
                )}
              </div>

              {runState !== "idle" && (
                <div style={{ marginTop: 12, padding: 10, background: "rgba(125,211,252,0.05)", border: "1px solid rgba(125,211,252,0.2)", borderRadius: 4, fontSize: "0.82rem" }}>
                  <div style={{ marginBottom: 4 }}>
                    Status: <strong>{runState}</strong> · {runProgress.processed}/{runProgress.total} done, {runProgress.failed} failed · spent {formatUsd(runProgress.costSoFar)} / cap {formatUsd(costCapUsd)}
                  </div>
                  {runProgress.currentTitle && runState === "running" && (
                    <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>Now: {runProgress.currentTitle}</div>
                  )}
                  {runProgress.lastError && (
                    <div style={{ color: "var(--red)", marginTop: 4 }}>Last error: {runProgress.lastError}</div>
                  )}
                  <div style={{ height: 4, background: "var(--border)", borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${runProgress.total > 0 ? Math.round((runProgress.processed / runProgress.total) * 100) : 0}%`,
                      background: runState === "failed" ? "var(--red)" : "var(--green)",
                      transition: "width 0.3s",
                    }} />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
    </div>
  );
}
