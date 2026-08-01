"use client";

import { useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import { isExcluded } from "../lib/rules";
import { applyAutoLinks } from "../lib/provenanceLinker";
import { saveSourceCheck } from "../lib/importStateClient";
import { resolveTitleFromRegistry } from "../lib/youtubeTitleAlign";
import { getSeriesRegistry } from "../lib/seriesRegistryClient";
import type { SeriesRegistryEntry } from "../lib/youtubeTitleAlign";
import { useEffect } from "react";
import HelpTip from "./HelpTip";

const CONNECTIONS_KEY = "video-sync:connections";

interface NormalisedTranscript {
  source_id: string;
  source_platform: string;
  title: string;
  recorded_at: string;
  duration_seconds: number;
  participants: string[];
  description: string | null;
  transcript_text: string | null;
  download_url: string | null;
  tags: string[];
  metadata_extra?: Record<string, string>;
}

interface Props {
  /** Optional `imported.ids` lets the caller focus the catalog on
   *  just these records after import. */
  onImported: (imported?: { ids: string[] }) => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
  dateFrom?: string;
  dateTo?: string;
  /** ADR-058 — bumped by ImportPanel's "Fetch all sources" button.
   *  Sub-panel fires its own fetch on every value change past 0. */
  fetchTrigger?: number;
}

function getFirefliesApiKey(): string | null {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return null;
    const connections = JSON.parse(raw);
    const ff = connections["Fireflies"];
    if (!ff?.connected) return null;
    return ff.credentials?.apiKey?.trim() || null;
  } catch {
    return null;
  }
}

export default function FirefliesImport({ onImported, onEvent, dateFrom: dateFromProp, dateTo: dateToProp, fetchTrigger }: Props) {
  const [transcripts, setTranscripts] = useState<NormalisedTranscript[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // ADR-055/056 at ingest — cache the series registry once at mount
  // so importSelected can rewrite generic Fireflies titles to their
  // dated form the same way YouTube ingest already does.
  const [seriesRegistry, setSeriesRegistry] = useState<SeriesRegistryEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    getSeriesRegistry().then(r => { if (!cancelled) setSeriesRegistry(r); });
    return () => { cancelled = true; };
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);
  // Local fallback dates — used only when no parent-controlled dates are passed
  // (i.e. component is rendered standalone, not inside the merged Meetings tab).
  const [localDateFrom, setLocalDateFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const [localDateTo, setLocalDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const dateFrom = dateFromProp ?? localDateFrom;
  const dateTo = dateToProp ?? localDateTo;
  const datesAreControlled = dateFromProp !== undefined && dateToProp !== undefined;
  const [filterTitle, setFilterTitle] = useState("");
  const [filterMinLen, setFilterMinLen] = useState("2");
  const [filterMaxLen, setFilterMaxLen] = useState("");
  const [filterDays, setFilterDays] = useState<Set<number>>(new Set());

  // ADR-058 — respond to ImportPanel's "Fetch all sources" button.
  // Only fires past 0 so the initial mount doesn't trigger a fetch.
  useEffect(() => {
    if (fetchTrigger && fetchTrigger > 0) fetchTranscripts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchTrigger]);

  async function fetchTranscripts() {
    // ADR-042: server resolves through local override → shared default → env.
    // Pass apiKey only when set locally; absent body field falls through.
    const apiKey = getFirefliesApiKey();

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fireflies/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(apiKey ? { apiKey } : {}), from: dateFrom, to: dateTo }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error || `Request failed (${res.status})`);
        return;
      }
      const data = await res.json();
      setTranscripts(data.transcripts ?? []);
      setSelected(new Set());
      setFetched(true);
      // ADR-058 D — record source-check for the Overview banner.
      saveSourceCheck("Fireflies", dateFrom, dateTo);
      if ((data.transcripts ?? []).length === 0) {
        setError("No transcripts found in the selected date range.");
      }
    } catch (err) {
      setError(`Network error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function toggleSelect(sourceId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }

  function importSelected() {
    let count = 0;
    let skipped = 0;
    const newIds: string[] = [];
    // ADR-062 follow-up (catalog dedupe audit 2026-08-01): guard
    // against re-importing a Fireflies transcript that already
    // exists in the catalog. Duplicates of the same source_id
    // were the majority of hard-dup rows the audit surfaced.
    const existing = new Set(videoStore.getAll().map(v => `${v.source_platform}:${v.source_id}`));

    for (const t of transcripts) {
      if (!selected.has(t.source_id)) continue;
      if (isExcluded("Fireflies", t.source_id) || existing.has(`Fireflies:${t.source_id}`)) { skipped++; continue; }

      // ADR-055/056 — align generic Fireflies titles to their dated
      // form at ingest, preserving the raw platform title in
      // metadata_extra.fireflies_original_title (mirrors YouTube's
      // youtube_original_title pattern).
      const align = resolveTitleFromRegistry(t.title, t.recorded_at, seriesRegistry);
      const finalTitle = align?.new_title ?? t.title;
      const alignExtras = align ? {
        fireflies_original_title: t.title,
        title_aligned_source: align.source,
        ...(align.matched_series ? { title_aligned_matched_series: align.matched_series } : {}),
      } : {};

      const cmd: Record<string, unknown> = {
        source_id: t.source_id,
        source_platform: "Fireflies",
        title: finalTitle,
        description: t.description ?? undefined,
        duration_seconds: t.duration_seconds,
        participants: t.participants,
        download_url: t.download_url ?? `fireflies://unknown`,
        // transcript_text intentionally omitted — stored in JS cache, not WASM heap
        tags: t.tags,
        recorded_at: t.recorded_at,
      };
      const mergedExtra = { ...(t.metadata_extra ?? {}), ...alignExtras };
      if (Object.keys(mergedExtra).length > 0) cmd.metadata_extra = mergedExtra;

      const record = new WasmVideoRecord(JSON.stringify(cmd));
      videoStore.add(record);
      newIds.push(record.id());
      // Store transcript in JS-side cache (avoids large WASM heap allocations)
      if (t.transcript_text) {
        videoStore.setTranscript(record.id(), t.transcript_text);
      }
      onEvent(`VideoIndexed: "${t.title}" (Fireflies import${t.transcript_text ? ", transcript included" : ""})`);
      count++;
    }

    if (skipped > 0) onEvent(`Fireflies import: ${skipped} excluded transcript(s) skipped`);
    if (count > 0) {
      const linked = applyAutoLinks(newIds);
      if (linked > 0) onEvent(`ProvenanceLinker: auto-linked ${linked} record(s) to Zoom upstream`);
      onImported({ ids: newIds });
      setTranscripts([]);
      setSelected(new Set());
      setFetched(false);
    }
  }

  const durationMinutes = (t: NormalisedTranscript) => Math.round(t.duration_seconds / 60);
  function fmtDuration(secs: number): string {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  const visible = transcripts.filter((t) => {
    const mins = durationMinutes(t);
    if (filterTitle && !t.title.toLowerCase().includes(filterTitle.toLowerCase())) return false;
    if (filterMinLen && mins < Number(filterMinLen)) return false;
    if (filterMaxLen && mins > Number(filterMaxLen)) return false;
    if (filterDays.size > 0 && !filterDays.has(new Date(t.recorded_at).getDay())) return false;
    return true;
  });

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Fireflies Transcripts</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!datesAreControlled && (
            <>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setLocalDateFrom(e.target.value)}
                style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
              />
              <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setLocalDateTo(e.target.value)}
                style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
              />
            </>
          )}
          <button
            className="btn btn-sm btn-primary"
            onClick={fetchTranscripts}
            disabled={loading}
          >
            {loading ? "Fetching..." : "Fetch from Fireflies"}
          </button>
        </div>
      </div>

      <HelpTip>
        Import meeting transcripts from Fireflies.ai. Choose a date range and filter by title,
        duration, or day of week. Meetings with a <strong>✓ transcript</strong> badge include
        full text that will be stored alongside the video record — useful for LLM-generated
        descriptions in Processing Rules. Your Fireflies API key must be configured in
        Connections first.
      </HelpTip>

      {error && <div className="zoom-import-error">{error}</div>}

      {fetched && transcripts.length > 0 && (
        <>
          <div className="zoom-import-filters" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <input
              placeholder="Filter by title..."
              value={filterTitle}
              onChange={(e) => setFilterTitle(e.target.value)}
              style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem", flex: "1 1 140px" }}
            />
            <input
              placeholder="Min (min)"
              type="number"
              value={filterMinLen}
              onChange={(e) => setFilterMinLen(e.target.value)}
              style={{ width: 80, padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
            />
            <input
              placeholder="Max (min)"
              type="number"
              value={filterMaxLen}
              onChange={(e) => setFilterMaxLen(e.target.value)}
              style={{ width: 80, padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
            />
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Days:</span>
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
              <button
                key={d}
                className={`btn btn-sm ${filterDays.has(i) ? "btn-primary" : ""}`}
                style={{ padding: "2px 6px", fontSize: "0.7rem" }}
                onClick={() => setFilterDays((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i); else next.add(i);
                  return next;
                })}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="zoom-import-list">
            {visible.map((t) => (
              <label key={t.source_id} className="zoom-import-item">
                <input
                  type="checkbox"
                  checked={selected.has(t.source_id)}
                  onChange={() => toggleSelect(t.source_id)}
                />
                <div>
                  <span className="zoom-import-topic">{t.title}</span>
                  <span className="zoom-import-meta">
                    {new Date(t.recorded_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {" · "}
                    <span title={`${durationMinutes(t)} min`}>{fmtDuration(t.duration_seconds)}</span>
                    {t.transcript_text && (
                      <span style={{ color: "var(--green)", marginLeft: 4 }}>✓ transcript</span>
                    )}
                    {t.description && (
                      <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>✓ summary</span>
                    )}
                  </span>
                </div>
              </label>
            ))}
          </div>
          {selected.size > 0 && (
            <button className="btn btn-primary" onClick={importSelected}>
              Import {selected.size} selected
            </button>
          )}
        </>
      )}
    </div>
  );
}
