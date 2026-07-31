"use client";

/**
 * ADR-055 — operator-editable series registry.
 *
 * A {series_name, pattern} table for the title-alignment resolver.
 * When ingest sees a Zoom/Fireflies/Kaltura/YouTube-Live title that
 * matches one of these patterns, it rewrites the local catalog
 * title to `{series_name} - {D MMM YYYY}`. This surface exists so
 * the operator can add new series or tighten a pattern without
 * SSHing into a JSON file on the FUSE bucket.
 */

import { useEffect, useState } from "react";
import { getSeriesRegistry, refreshSeriesRegistry, saveSeriesRegistry } from "../lib/seriesRegistryClient";
import type { SeriesRegistryEntry } from "../lib/youtubeTitleAlign";

interface RowState extends SeriesRegistryEntry {
  /** Local-only key so React can reorder rows when the operator
   *  edits the series_name in place. */
  _uid: number;
  /** Cached compile error message so the operator sees it while
   *  typing; the /api/series-registry POST is the ultimate gate. */
  regexError?: string;
}

let uidCounter = 1;

export default function SeriesRegistryPanel() {
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Show the cached copy immediately if we have one — first paint
    // shouldn't wait for a GCS-backed round-trip. Then refresh in
    // the background and replace the rows if the server disagrees.
    getSeriesRegistry().then((entries) => {
      if (cancelled) return;
      setRows(entries.map((e) => ({ ...e, _uid: uidCounter++ })));
      setLoading(false);
      // Force a background refetch so the editor eventually shows
      // any out-of-band writes; but only if there's more than a
      // handful of ms of network idle so we don't block first paint.
      setTimeout(() => {
        if (cancelled) return;
        refreshSeriesRegistry();
        getSeriesRegistry().then((fresh) => {
          if (cancelled) return;
          if (JSON.stringify(fresh) !== JSON.stringify(entries)) {
            setRows(fresh.map((e) => ({ ...e, _uid: uidCounter++ })));
          }
        });
      }, 400);
    });
    return () => { cancelled = true; };
  }, []);

  function validateRegex(pattern: string): string | undefined {
    try { new RegExp(pattern, "i"); return undefined; }
    catch (err) { return err instanceof Error ? err.message : String(err); }
  }

  function updateRow(uid: number, patch: Partial<SeriesRegistryEntry>) {
    setDirty(true);
    setStatus(null);
    setRows((prev) => prev.map((r) => {
      if (r._uid !== uid) return r;
      const next = { ...r, ...patch };
      if (typeof patch.pattern === "string") next.regexError = validateRegex(patch.pattern);
      return next;
    }));
  }

  function addRow() {
    setDirty(true);
    setStatus(null);
    setRows((prev) => [...prev, { _uid: uidCounter++, series_name: "", pattern: "", regexError: "empty pattern" }]);
  }

  function removeRow(uid: number) {
    setDirty(true);
    setStatus(null);
    setRows((prev) => prev.filter((r) => r._uid !== uid));
  }

  async function save() {
    // Client-side validation first — cheap, and the POST validates
    // again on the server so we can trust either way.
    const cleaned = rows
      .map((r) => {
        const out: {
          series_name: string;
          pattern: string;
          discord_channel?: string;
          scheduled_start_local?: string;
          scheduled_end_local?: string;
          scheduled_timezone?: string;
        } = {
          series_name: r.series_name.trim(),
          pattern: r.pattern.trim(),
        };
        const dc = (r.discord_channel ?? "").trim();
        if (dc) out.discord_channel = dc;
        const s = (r.scheduled_start_local ?? "").trim();
        const e = (r.scheduled_end_local ?? "").trim();
        const tz = (r.scheduled_timezone ?? "").trim();
        if (s || e || tz) {
          out.scheduled_start_local = s;
          out.scheduled_end_local = e;
          out.scheduled_timezone = tz;
        }
        return out;
      })
      .filter((r) => r.series_name.length > 0);
    for (const [i, r] of cleaned.entries()) {
      if (!r.pattern) {
        setStatus(`Row ${i + 1} ("${r.series_name}") — pattern is required`);
        return;
      }
      const err = validateRegex(r.pattern);
      if (err) {
        setStatus(`Row ${i + 1} ("${r.series_name}") — invalid regex: ${err}`);
        return;
      }
      if (r.discord_channel && !/^https:\/\/(?:.*\.)?discord(?:app)?\.com\//i.test(r.discord_channel)) {
        setStatus(`Row ${i + 1} ("${r.series_name}") — discord_channel must be a Discord webhook URL`);
        return;
      }
      const anyScheduled = r.scheduled_start_local || r.scheduled_end_local || r.scheduled_timezone;
      const allScheduled = r.scheduled_start_local && r.scheduled_end_local && r.scheduled_timezone;
      if (anyScheduled && !allScheduled) {
        setStatus(`Row ${i + 1} ("${r.series_name}") — set all three scheduled fields (start / end / timezone) or leave them all blank`);
        return;
      }
      if (allScheduled) {
        const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
        if (!hhmm.test(r.scheduled_start_local!)) { setStatus(`Row ${i + 1} — scheduled_start_local must be "HH:MM"`); return; }
        if (!hhmm.test(r.scheduled_end_local!))   { setStatus(`Row ${i + 1} — scheduled_end_local must be "HH:MM"`); return; }
        try { new Intl.DateTimeFormat("en-US", { timeZone: r.scheduled_timezone! }); }
        catch { setStatus(`Row ${i + 1} — scheduled_timezone must be a valid IANA zone (e.g. "America/New_York")`); return; }
      }
    }
    setSaving(true);
    setStatus(null);
    const result = await saveSeriesRegistry(cleaned);
    setSaving(false);
    if (!result.ok) {
      setStatus(`Save failed: ${result.error}`);
      return;
    }
    // Reload local rows from the server-canonical shape.
    refreshSeriesRegistry();
    const fresh = await getSeriesRegistry();
    setRows(fresh.map((e) => ({ ...e, _uid: uidCounter++ })));
    setDirty(false);
    setStatus(`Saved ${cleaned.length} entr${cleaned.length === 1 ? "y" : "ies"}.`);
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>Series Registry</h2>
      <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginTop: 0 }}>
        Named series patterns used by ADR-055 title alignment. When an ingest title matches a pattern, the catalog title is rewritten to <code>{"{series_name} - D MMM YYYY"}</code>.
        <br />
        Patterns are JavaScript regex, matched case-insensitively. Longest matching series wins on ties.
      </p>

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Loading…</div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontWeight: 600, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Series name</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontWeight: 600, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Pattern</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontWeight: 600, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }} title="Optional Discord webhook URL. When set, VideoCard shows Push-to-Discord affordances for clips + summaries in this series.">Discord channel</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontWeight: 600, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }} title="ADR-060: scheduled show window. Used to derive pre/post-show trim automatically. Leave blank if the show doesn't run to a fixed schedule.">Show window (start · end · TZ)</th>
                  <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._uid}>
                    <td style={{ padding: "4px 8px", verticalAlign: "top" }}>
                      <input
                        value={r.series_name}
                        onChange={(e) => updateRow(r._uid, { series_name: e.target.value })}
                        placeholder="e.g. Hackerspace Agentics Foundation"
                        style={{ width: "100%", padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.82rem" }}
                      />
                    </td>
                    <td style={{ padding: "4px 8px", verticalAlign: "top" }}>
                      <input
                        value={r.pattern}
                        onChange={(e) => updateRow(r._uid, { pattern: e.target.value })}
                        placeholder="e.g. ^Hackerspace Agentics Foundation"
                        style={{ width: "100%", padding: "4px 6px", background: "var(--bg)", border: r.regexError ? "1px solid var(--red)" : "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.82rem", fontFamily: "monospace" }}
                      />
                      {r.regexError && <div style={{ color: "var(--red)", fontSize: "0.7rem", marginTop: 2 }}>{r.regexError}</div>}
                    </td>
                    <td style={{ padding: "4px 8px", verticalAlign: "top" }}>
                      <input
                        value={r.discord_channel ?? ""}
                        onChange={(e) => updateRow(r._uid, { discord_channel: e.target.value })}
                        placeholder="https://discord.com/api/webhooks/…"
                        style={{ width: "100%", padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.78rem", fontFamily: "monospace" }}
                      />
                    </td>
                    <td style={{ padding: "4px 8px", verticalAlign: "top" }}>
                      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          value={r.scheduled_start_local ?? ""}
                          onChange={(e) => updateRow(r._uid, { scheduled_start_local: e.target.value })}
                          placeholder="12:00"
                          style={{ width: 62, padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.78rem", fontFamily: "monospace" }}
                          title="Local wall-clock start, HH:MM 24-hour"
                        />
                        <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>→</span>
                        <input
                          value={r.scheduled_end_local ?? ""}
                          onChange={(e) => updateRow(r._uid, { scheduled_end_local: e.target.value })}
                          placeholder="13:30"
                          style={{ width: 62, padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.78rem", fontFamily: "monospace" }}
                          title="Local wall-clock end, HH:MM 24-hour"
                        />
                        <input
                          value={r.scheduled_timezone ?? ""}
                          onChange={(e) => updateRow(r._uid, { scheduled_timezone: e.target.value })}
                          placeholder="America/New_York"
                          style={{ flex: "1 1 130px", minWidth: 130, padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.78rem", fontFamily: "monospace" }}
                          title="IANA zone (e.g. America/New_York, Europe/London)"
                        />
                      </div>
                    </td>
                    <td style={{ padding: "4px 8px", verticalAlign: "top", textAlign: "right" }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => removeRow(r._uid)}
                        title="Remove this entry"
                        style={{ padding: "2px 8px" }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-sm" onClick={addRow}>+ Add entry</button>
            <button className="btn btn-sm btn-primary" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            {status && (
              <span style={{ color: status.startsWith("Saved") ? "var(--green)" : "var(--red)", fontSize: "0.78rem" }}>
                {status}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
