"use client";

import { useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import { isExcluded } from "../lib/rules";
import HelpTip from "./HelpTip";

const CONNECTIONS_KEY = "video-sync:connections";

interface KalturaEntry {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  duration_seconds: number;
  tags: string[];
  thumbnail_url: string | null;
  player_url: string;
  is_live: boolean;
}

interface Props {
  onImported: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
  dateFrom?: string;
  dateTo?: string;
}

function getKalturaCredentials(): { partnerId: string; adminSecret: string } | null {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return null;
    const conn = JSON.parse(raw);
    const k = conn["Kaltura"];
    if (!k?.connected) return null;
    const { partnerId, adminSecret, apiKey } = k.credentials ?? {};
    // Accept legacy `apiKey` field for backward compatibility with
    // overrides saved before the field rename (ADR-042 Phase 2 fix).
    const secret = adminSecret || apiKey;
    if (!partnerId || !secret) return null;
    return { partnerId, adminSecret: secret };
  } catch {
    return null;
  }
}

function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export default function KalturaImport({ onImported, onEvent, dateFrom: dateFromProp, dateTo: dateToProp }: Props) {
  const [entries, setEntries] = useState<KalturaEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);
  const [localDateFrom, setLocalDateFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const [localDateTo, setLocalDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const dateFrom = dateFromProp ?? localDateFrom;
  const dateTo = dateToProp ?? localDateTo;
  const datesAreControlled = dateFromProp !== undefined && dateToProp !== undefined;
  const [filterTitle, setFilterTitle] = useState("");
  const [liveOnly, setLiveOnly] = useState(false);

  async function fetchEntries() {
    // ADR-042: Kaltura is shared-only — operators see no override field, so
    // the local creds will normally be null. Server resolves from shared
    // Secret Manager. If neither is configured, server returns 400.
    const creds = getKalturaCredentials();
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { from: dateFrom, to: dateTo };
      if (creds) {
        body.partnerId = creds.partnerId;
        body.adminSecret = creds.adminSecret;
      }
      const res = await fetch("/api/kaltura/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError((data as { error?: string }).error ?? `Request failed (${res.status})`);
        return;
      }
      setEntries((data.entries ?? []) as KalturaEntry[]);
      setSelected(new Set());
      setFetched(true);
      if ((data.entries ?? []).length === 0) {
        setError("No entries found in the selected date range.");
      }
    } catch (err) {
      setError(`Network error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function importSelected() {
    let count = 0;
    let skipped = 0;
    let failed = 0;
    for (const e of entries) {
      if (!selected.has(e.id)) continue;
      if (isExcluded("Kaltura", e.id)) { skipped++; continue; }

      const cmd: Record<string, unknown> = {
        source_id: e.id,
        source_platform: "Kaltura",
        title: e.name,
        description: e.description ?? undefined,
        // WASM IndexVideo.duration_seconds is a u32 — a fractional value
        // (Kaltura sometimes returns sub-second precision) makes serde
        // throw "invalid type: floating point …, expected u32" and aborts
        // the whole import. Coerce to a non-negative integer, matching
        // URLImport's defensive pattern.
        duration_seconds: Math.max(0, Math.round(e.duration_seconds || 0)),
        participants: [],
        download_url: `kaltura://entry/${e.id}`,
        thumbnail_url: e.thumbnail_url ?? undefined,
        tags: e.tags.length > 0 ? e.tags : ["kaltura-import"],
        recorded_at: e.createdAt,
      };
      const meta: Record<string, string> = { player_url: e.player_url };
      if (e.is_live) meta.live = "1";
      cmd.metadata_extra = meta;

      // Wrap per-entry so one bad record doesn't silently abort the whole
      // batch — surface the failure to the EventLog and keep going.
      try {
        const record = new WasmVideoRecord(JSON.stringify(cmd));
        // Record the existing Kaltura entry as a Destination location too —
        // this video is already on Kaltura, so the Kaltura lozenge in
        // Overview should light up immediately.
        videoStore.add(record);
        const recordId = record.id();
        onEvent(`VideoIndexed: "${e.name}" (Kaltura import${e.is_live ? ", live broadcast" : ""})`, { video_id: recordId });
        count++;

        // Fire-and-forget: pull captions from Kaltura if the entry has
        // them, convert to plain-text transcript with [HH:MM:SS] markers,
        // and hydrate the record. videoStore.setTranscript schedules a
        // push to Drive (PUT /api/artifacts/<id>/transcript) so the
        // transcript artifact lands next to the description.
        const title = e.name;
        const entryId = e.id;
        fetch(`/api/kaltura/captions?entryId=${encodeURIComponent(entryId)}`)
          .then(async r => {
            if (r.status === 404 || r.status === 409 || r.status === 415 || r.status === 422) {
              // Expected misses: no captions / not ready / format unsupported / empty.
              // Don't spam the EventLog for these — operators don't need a line per record.
              return null;
            }
            if (!r.ok) {
              const j = await r.json().catch(() => ({}));
              onEvent(`Kaltura captions failed: "${title}" — ${(j as { error?: string }).error ?? r.status}`, { video_id: recordId });
              return null;
            }
            const data = await r.json() as { text: string; language?: string; format?: string };
            return data.text ? data : null;
          })
          .then(data => {
            if (!data) return;
            videoStore.setTranscript(recordId, data.text);
            onEvent(`Kaltura captions imported: "${title}" — ${data.text.split("\n").length} lines (${data.format ?? "?"}, ${data.language ?? "?"})`, { video_id: recordId });
          })
          .catch(err => {
            onEvent(`Kaltura captions error: "${title}" — ${String(err).slice(0, 120)}`, { video_id: recordId });
          });
      } catch (err) {
        failed++;
        onEvent(`Kaltura import failed: "${e.name}" — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (skipped > 0) onEvent(`Kaltura import: ${skipped} excluded entr${skipped === 1 ? "y" : "ies"} skipped`);
    if (failed > 0) onEvent(`Kaltura import: ${failed} entr${failed === 1 ? "y" : "ies"} failed to index`);
    if (count > 0) {
      onImported();
      setEntries([]);
      setSelected(new Set());
      setFetched(false);
    }
  }

  const visible = entries.filter(e => {
    if (filterTitle && !e.name.toLowerCase().includes(filterTitle.toLowerCase())) return false;
    if (liveOnly && !e.is_live) return false;
    return true;
  });

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Kaltura Entries</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!datesAreControlled && (
            <>
              <input type="date" value={dateFrom} onChange={(e) => setLocalDateFrom(e.target.value)}
                style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }} />
              <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>to</span>
              <input type="date" value={dateTo} onChange={(e) => setLocalDateTo(e.target.value)}
                style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }} />
            </>
          )}
          <button className="btn btn-sm btn-primary" onClick={fetchEntries} disabled={loading}>
            {loading ? "Fetching..." : "Fetch from Kaltura"}
          </button>
        </div>
      </div>

      <HelpTip>
        Pull entries directly from your Kaltura account into the catalog with{" "}
        <strong>source_platform: Kaltura</strong>. Includes live broadcasts captured
        via streaming software (OBS, Streamyard, Wirecast) that landed on Kaltura
        as VOD entries — the <em>Live</em> filter narrows to those.
      </HelpTip>

      {error && <div className="zoom-import-error">{error}</div>}

      {fetched && entries.length > 0 && (
        <>
          <div className="zoom-import-filters" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <input
              placeholder="Filter by title..."
              value={filterTitle}
              onChange={(e) => setFilterTitle(e.target.value)}
              style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem", flex: "1 1 140px" }}
            />
            <label style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={liveOnly} onChange={e => setLiveOnly(e.target.checked)} />
              Live only
            </label>
          </div>
          <div className="zoom-import-list">
            {visible.map((e) => (
              <label key={e.id} className="zoom-import-item">
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelect(e.id)} />
                <div>
                  <span className="zoom-import-topic">{e.name}</span>
                  <span className="zoom-import-meta">
                    {new Date(e.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {" · "}
                    <span title={`${Math.round(e.duration_seconds / 60)} min`}>{fmtDuration(e.duration_seconds)}</span>
                    {e.is_live && (
                      <span style={{ color: "#a855f7", marginLeft: 4 }}>● live</span>
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
