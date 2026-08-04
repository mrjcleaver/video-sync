"use client";

import { useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import { isExcluded } from "../lib/rules";
import { applyAutoLinks } from "../lib/provenanceLinker";
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
  onImported: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
  dateFrom?: string;
  dateTo?: string;
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

export default function FirefliesImport({ onImported, onEvent, dateFrom: dateFromProp, dateTo: dateToProp }: Props) {
  const [transcripts, setTranscripts] = useState<NormalisedTranscript[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);
  // Local fallback dates are used only when no parent-controlled dates are passed
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

    for (const t of transcripts) {
      if (!selected.has(t.source_id)) continue;
      if (isExcluded("Fireflies", t.source_id)) { skipped++; continue; }

      const cmd: Record<string, unknown> = {
        source_id: t.source_id,
        source_platform: "Fireflies",
        title: t.title,
        description: t.description ?? undefined,
        duration_seconds: t.duration_seconds,
        participants: t.participants,
        download_url: t.download_url ?? `fireflies://unknown`,
        // transcript_text intentionally omitted because it is stored in the JS cache, not the WASM heap
        tags: t.tags,
        recorded_at: t.recorded_at,
      };
      if (t.metadata_extra) cmd.metadata_extra = t.metadata_extra;

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
      onImported();
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
        <div className="import-source-actions">
          {!datesAreControlled && (
            <fieldset className="import-date-range import-date-range-compact">
              <legend>Date range</legend>
              <label className="import-field">
                <span className="import-field-label">From</span>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setLocalDateFrom(e.target.value)}
                />
              </label>
              <label className="import-field">
                <span className="import-field-label">To</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setLocalDateTo(e.target.value)}
                />
              </label>
            </fieldset>
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={fetchTranscripts}
            disabled={loading}
            aria-busy={loading}
            aria-describedby={error ? "fireflies-import-message" : undefined}
          >
            {loading ? "Fetching..." : "Fetch from Fireflies"}
          </button>
        </div>
      </div>

      <HelpTip>
        Import meeting transcripts from Fireflies.ai. Choose a date range and filter by title,
        duration, or day of week. Meetings with a <strong>✓ transcript</strong> badge include
        full text that will be stored alongside the video record. This is useful for LLM-generated
        descriptions in Processing Rules. Your Fireflies API key must be configured in
        Connections first.
      </HelpTip>

      {error && (
        <div id="fireflies-import-message" className="zoom-import-error" role="alert">
          {error}
        </div>
      )}

      {fetched && transcripts.length > 0 && (
        <>
          <div className="zoom-import-filters">
            <label className="import-field import-field-grow">
              <span className="import-field-label">Title</span>
              <input
                placeholder="Search titles"
                value={filterTitle}
                onChange={(e) => setFilterTitle(e.target.value)}
              />
            </label>
            <label className="import-field import-field-number">
              <span className="import-field-label">Minimum minutes</span>
              <input
                type="number"
                value={filterMinLen}
                onChange={(e) => setFilterMinLen(e.target.value)}
              />
            </label>
            <label className="import-field import-field-number">
              <span className="import-field-label">Maximum minutes</span>
              <input
                type="number"
                value={filterMaxLen}
                onChange={(e) => setFilterMaxLen(e.target.value)}
              />
            </label>
            <fieldset className="import-option-group">
              <legend>Days</legend>
              <div className="import-day-buttons">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={filterDays.has(i)}
                    className={`btn btn-sm ${filterDays.has(i) ? "btn-primary" : ""}`}
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
            </fieldset>
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
