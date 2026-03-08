"use client";

import { useState, useMemo, useCallback } from "react";
import type { VideoStats } from "../app/api/youtube/stats/route";
import { WasmVideoRecord, type VideoRecordJSON } from "../lib/wasm";
import { videoStore } from "../lib/store";
import { isExcluded } from "../lib/rules";
import { applyAutoLinks } from "../lib/provenanceLinker";

const CONNECTIONS_KEY = "video-sync:connections";

// ── Raw API shapes ────────────────────────────────────────────────

interface ZoomMeeting {
  uuid: string;
  id: number;
  topic: string;
  start_time: string;
  duration: number; // minutes
  share_url?: string;
  description?: string;
}

interface FFTranscript {
  source_id: string;
  title: string;
  recorded_at: string;
  duration_seconds: number;
  participants: string[];
  description: string | null;
  transcript_text: string | null;
  download_url: string;
  tags: string[];
  metadata_extra?: Record<string, string>;
}

// ── Merged session ───────────────────────────────────────────────

type LinkKind = "id_match" | "time_match" | "zoom_only" | "ff_only";

interface MergedSession {
  id: string;
  title: string;
  recordedAt: string;
  durationMinutes: number;
  zoom: ZoomMeeting | null;
  ff: FFTranscript | null;
  linkKind: LinkKind;
}

// ── Helpers ──────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60 * 1000;

function buildSessions(zooms: ZoomMeeting[], ffs: FFTranscript[]): MergedSession[] {
  const sessions: MergedSession[] = [];
  const usedFF = new Set<string>();
  const usedZoom = new Set<string>();

  // 1. Match by Zoom meeting ID (high confidence)
  const zoomByNumId = new Map<string, ZoomMeeting>();
  for (const z of zooms) zoomByNumId.set(String(z.id), z);

  for (const ff of ffs) {
    const zoomId = ff.metadata_extra?.zoom_meeting_id;
    if (zoomId && zoomByNumId.has(zoomId)) {
      const z = zoomByNumId.get(zoomId)!;
      if (!usedZoom.has(z.uuid)) {
        sessions.push({
          id: `zoom-${z.uuid}`,
          title: z.topic,
          recordedAt: z.start_time,
          durationMinutes: z.duration,
          zoom: z,
          ff,
          linkKind: "id_match",
        });
        usedFF.add(ff.source_id);
        usedZoom.add(z.uuid);
      }
    }
  }

  // 2. Match remaining by timestamp proximity
  const remainingFF = ffs.filter((f) => !usedFF.has(f.source_id));
  const remainingZoom = zooms.filter((z) => !usedZoom.has(z.uuid));

  for (const z of remainingZoom) {
    const zTime = new Date(z.start_time).getTime();
    const match = remainingFF.find(
      (f) => !usedFF.has(f.source_id) && Math.abs(new Date(f.recorded_at).getTime() - zTime) <= WINDOW_MS
    );
    if (match) {
      sessions.push({
        id: `zoom-${z.uuid}`,
        title: z.topic,
        recordedAt: z.start_time,
        durationMinutes: z.duration,
        zoom: z,
        ff: match,
        linkKind: "time_match",
      });
      usedFF.add(match.source_id);
      usedZoom.add(z.uuid);
    }
  }

  // 3. Orphan Zoom
  for (const z of zooms.filter((z) => !usedZoom.has(z.uuid))) {
    sessions.push({ id: `zoom-${z.uuid}`, title: z.topic, recordedAt: z.start_time, durationMinutes: z.duration, zoom: z, ff: null, linkKind: "zoom_only" });
  }

  // 4. Orphan Fireflies
  for (const f of ffs.filter((f) => !usedFF.has(f.source_id))) {
    sessions.push({ id: f.source_id, title: f.title, recordedAt: f.recorded_at, durationMinutes: Math.round(f.duration_seconds / 60), zoom: null, ff: f, linkKind: "ff_only" });
  }

  sessions.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
  return sessions;
}

function getCredentials() {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return { zoom: null as Record<string, string> | null, ffKey: null as string | null };
    const c = JSON.parse(raw);
    const zoom = c["Zoom"]?.connected ? c["Zoom"].credentials : null;
    const ffKey: string | null = c["Fireflies"]?.connected ? (c["Fireflies"]?.credentials?.apiKey?.trim() || null) : null;
    return { zoom, ffKey };
  } catch {
    return { zoom: null, ffKey: null };
  }
}

function fmtViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const LINK_COLOR: Record<LinkKind, string> = {
  id_match:   "var(--green)",
  time_match: "#f5a623",
  zoom_only:  "var(--text-muted)",
  ff_only:    "var(--text-muted)",
};

const LINK_LABEL: Record<LinkKind, string> = {
  id_match:   "✓ ID linked",
  time_match: "~ time matched",
  zoom_only:  "Zoom only",
  ff_only:    "Fireflies only",
};

// ── Component ────────────────────────────────────────────────────

interface Props {
  onImported: () => void;
  onEvent: (e: string) => void;
}

export default function UnifiedImport({ onImported, onEvent }: Props) {
  const [dateFrom, setDateFrom] = useState(() =>
    new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  );
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [filterTitle, setFilterTitle] = useState("Vibe|Hackerspace");
  const [filterMinLen, setFilterMinLen] = useState("20");
  const [filterSource, setFilterSource] = useState<"All" | "Zoom" | "Fireflies">("All");
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<MergedSession[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);
  const [fetchStatus, setFetchStatus] = useState("");
  const [hidePublished, setHidePublished] = useState(true);
  const [ytStats, setYtStats] = useState<Map<string, VideoStats>>(new Map());

  const fetchYtStats = useCallback(async (merged: MergedSession[]) => {
    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const raw = localStorage.getItem(CONNECTIONS_KEY);
      if (raw) connections = JSON.parse(raw);
    } catch { return; }

    const ytCreds = connections["YouTube"]?.credentials;
    if (!ytCreds?.refreshToken || !ytCreds?.clientId || !ytCreds?.clientSecret) return;

    // Collect all YouTube destination video IDs across the merged sessions
    const allStored = videoStore.getAll();
    const storedMap = new Map(allStored.map((v) => [v.source_id, v]));
    const videoIds: string[] = [];
    for (const s of merged) {
      const sids = [s.zoom ? `zoom-${s.zoom.uuid}` : null, s.ff?.source_id ?? null];
      for (const sid of sids) {
        if (!sid) continue;
        const loc = storedMap.get(sid)?.locations?.find(
          (l) => l.platform === "YouTube" && l.role === "Destination"
        );
        if (loc?.external_id && !videoIds.includes(loc.external_id)) {
          videoIds.push(loc.external_id);
        }
      }
    }
    if (videoIds.length === 0) return;

    try {
      const res = await fetch("/api/youtube/stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoIds,
          refreshToken: ytCreds.refreshToken,
          clientId: ytCreds.clientId,
          clientSecret: ytCreds.clientSecret,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setYtStats(new Map(Object.entries(data.stats as Record<string, VideoStats>)));
    } catch { /* non-blocking — stats are decorative */ }
  }, []);

  async function fetchAll() {
    setLoading(true);
    setError(null);
    setFetchStatus("Fetching Zoom + Fireflies…");

    const { zoom, ffKey } = getCredentials();
    const errors: string[] = [];
    let zooms: ZoomMeeting[] = [];
    let ffs: FFTranscript[] = [];

    await Promise.all([
      (async () => {
        try {
          const res = await fetch("/api/zoom/recordings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accountId: zoom?.accountId,
              clientId: zoom?.clientId,
              clientSecret: zoom?.clientSecret,
              from: dateFrom,
              to: dateTo,
            }),
          });
          const data: Record<string, unknown> = await res.json().catch(() => ({}));
          if (!res.ok) errors.push(`Zoom: ${(data.error as string) ?? `HTTP ${res.status}`}`);
          else zooms = (data.meetings as ZoomMeeting[]) ?? [];
        } catch (e) {
          errors.push(`Zoom: ${e instanceof TypeError && String(e).includes("fetch") ? "Server unreachable — is the dev server running?" : String(e)}`);
        }
      })(),
      (async () => {
        try {
          const res = await fetch("/api/fireflies/transcripts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: ffKey, from: dateFrom, to: dateTo }),
          });
          const data: Record<string, unknown> = await res.json().catch(() => ({}));
          if (!res.ok) errors.push(`Fireflies: ${(data.error as string) ?? `HTTP ${res.status}`}`);
          else ffs = (data.transcripts as FFTranscript[]) ?? [];
        } catch (e) {
          errors.push(`Fireflies: ${e instanceof TypeError && String(e).includes("fetch") ? "Server unreachable — is the dev server running?" : String(e)}`);
        }
      })(),
    ]);

    const merged = buildSessions(zooms, ffs);
    setSessions(merged);
    setSelected(new Set());
    setFetched(true);
    setLoading(false);
    setFetchStatus(`${zooms.length} Zoom · ${ffs.length} Fireflies · ${merged.length} sessions`);
    if (errors.length) setError(errors.join(" | "));
    fetchYtStats(merged);
  }

  // Build source_id → stored record map (used by visible filter and YouTube badges)
  const storedBySourceId = useMemo(() => {
    const map = new Map<string, VideoRecordJSON>();
    try {
      for (const v of videoStore.getAll()) map.set(v.source_id, v);
    } catch { /* store not yet ready */ }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  const visible = useMemo(() => {
    let titleRe: RegExp | null = null;
    try {
      if (filterTitle) titleRe = new RegExp(filterTitle, "i");
    } catch { /* invalid regex — ignore */ }
    const minMin = Number(filterMinLen) || 0;
    return sessions.filter((s) => {
      if (titleRe && !titleRe.test(s.title)) return false;
      if (minMin && s.durationMinutes < minMin) return false;
      if (filterSource === "Zoom" && !s.zoom) return false;
      if (filterSource === "Fireflies" && !s.ff) return false;
      if (hidePublished) {
        const isPublished = [
          s.zoom ? `zoom-${s.zoom.uuid}` : null,
          s.ff?.source_id ?? null,
        ].some((sid) => {
          if (!sid) return false;
          return storedBySourceId.get(sid)?.locations?.some(
            (l) => l.platform === "YouTube" && l.role === "Destination"
          ) ?? false;
        });
        if (isPublished) return false;
      }
      return true;
    });
  }, [sessions, filterTitle, filterMinLen, filterSource, hidePublished, storedBySourceId]);

  function toggleSession(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(visible.map((s) => s.id)));
  }

  function importSelected() {
    let count = 0;
    let skipped = 0;
    const newIds: string[] = [];

    // Prevent re-importing records already in the catalog
    const existingSourceIds = new Set(videoStore.getAll().map((v) => v.source_id));

    for (const session of sessions) {
      if (!selected.has(session.id)) continue;

      // Import Zoom record
      if (session.zoom) {
        const z = session.zoom;
        const sourceId = `zoom-${z.uuid}`;
        if (!isExcluded("Zoom", sourceId) && !existingSourceIds.has(sourceId)) {
          const meta: Record<string, string> = {};
          if (z.share_url) meta.share_url = z.share_url;
          meta.zoom_meeting_id = String(z.id);
          try {
            const rec = new WasmVideoRecord(JSON.stringify({
              source_id: sourceId,
              source_platform: "Zoom",
              title: z.topic,
              description: z.description,
              duration_seconds: z.duration * 60,
              participants: [],
              download_url: `zoom://recording/${z.uuid}`,
              tags: ["zoom-import"],
              recorded_at: z.start_time,
              metadata_extra: meta,
            }));
            videoStore.add(rec);
            newIds.push(rec.id());
            onEvent(`VideoIndexed: "${z.topic}" (Zoom)`);
            count++;
          } catch { skipped++; }
        } else { skipped++; }
      }

      // Import Fireflies record
      if (session.ff) {
        const f = session.ff;
        if (!isExcluded("Fireflies", f.source_id) && !existingSourceIds.has(f.source_id)) {
          const cmd: Record<string, unknown> = {
            source_id: f.source_id,
            source_platform: "Fireflies",
            title: f.title,
            description: f.description ?? undefined,
            duration_seconds: f.duration_seconds,
            participants: f.participants,
            download_url: f.download_url,
            tags: f.tags,
            recorded_at: f.recorded_at,
          };
          if (f.metadata_extra) cmd.metadata_extra = f.metadata_extra;
          try {
            const rec = new WasmVideoRecord(JSON.stringify(cmd));
            videoStore.add(rec);
            newIds.push(rec.id());
            if (f.transcript_text) videoStore.setTranscript(rec.id(), f.transcript_text);
            onEvent(`VideoIndexed: "${f.title}" (Fireflies${f.transcript_text ? ", transcript" : ""})`);
            count++;
          } catch { skipped++; }
        } else { skipped++; }
      }
    }

    if (count > 0) {
      const linked = applyAutoLinks(newIds);
      if (linked > 0) onEvent(`ProvenanceLinker: auto-linked ${linked} session(s)`);
      onImported();
      setSessions([]);
      setSelected(new Set());
      setFetched(false);
      setFetchStatus("");
    }
    if (skipped > 0) onEvent(`Import: ${skipped} record(s) skipped`);
  }

  function bulkMatchProvenance() {
    const all = videoStore.getAll();
    const linked = applyAutoLinks(all.map((v) => v.id));
    onEvent(`BulkProvenance: matched ${linked} record(s) to upstream`);
    onImported();
  }

  function getYouTubeDestination(s: MergedSession): { id: string; url: string | null; stats: VideoStats | null } | null {
    const sourceIds = [
      s.zoom ? `zoom-${s.zoom.uuid}` : null,
      s.ff ? s.ff.source_id : null,
    ];
    for (const sid of sourceIds) {
      if (!sid) continue;
      const stored = storedBySourceId.get(sid);
      const loc = stored?.locations?.find(
        (l) => l.platform === "YouTube" && l.role === "Destination"
      );
      if (loc) return {
        id: loc.external_id,
        url: loc.external_url ?? null,
        stats: ytStats.get(loc.external_id) ?? null,
      };
    }
    return null;
  }

  const selectedCount = visible.filter((s) => selected.has(s.id)).length;

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Import</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
          />
          <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>to</span>
          <input
            type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
          />
          <button className="btn btn-sm btn-primary" onClick={fetchAll} disabled={loading}>
            {loading ? "Fetching…" : "Fetch Zoom + Fireflies"}
          </button>
          <button className="btn btn-sm" onClick={bulkMatchProvenance} title="Auto-link all already-imported records by Zoom meeting ID and timestamp">
            Bulk Match Provenance
          </button>
        </div>
      </div>

      {fetchStatus && !loading && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 4 }}>{fetchStatus}</div>
      )}
      {error && <div className="zoom-import-error">{error}</div>}

      {fetched && sessions.length > 0 && (
        <>
          {/* Filters */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <input
              placeholder="Title filter (regex)…"
              value={filterTitle}
              onChange={(e) => setFilterTitle(e.target.value)}
              style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem", flex: "1 1 160px" }}
            />
            <input
              placeholder="Min (min)"
              type="number"
              value={filterMinLen}
              onChange={(e) => setFilterMinLen(e.target.value)}
              style={{ width: 72, padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
            />
            {(["All", "Zoom", "Fireflies"] as const).map((src) => (
              <button
                key={src}
                className={`btn btn-sm ${filterSource === src ? "btn-primary" : ""}`}
                style={{ padding: "2px 8px", fontSize: "0.75rem" }}
                onClick={() => setFilterSource(src)}
              >
                {src}
              </button>
            ))}
            <button
              className={`btn btn-sm ${hidePublished ? "btn-primary" : ""}`}
              style={{ fontSize: "0.75rem" }}
              onClick={() => setHidePublished((v) => !v)}
              title="Toggle visibility of sessions already published to YouTube"
            >
              {hidePublished ? "▶ Hide YouTube" : "▶ Show YouTube"}
            </button>
            <button className="btn btn-sm" style={{ fontSize: "0.75rem" }} onClick={selectAll}>
              Select all ({visible.length})
            </button>
          </div>

          {/* Session list */}
          <div className="zoom-import-list">
            {visible.map((s) => (
              <label key={s.id} className="zoom-import-item" style={{ alignItems: "flex-start", gap: 10 }}>
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={() => toggleSession(s.id)}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                    <span className="zoom-import-topic">{s.title}</span>
                    <span style={{
                      fontSize: "0.62rem", padding: "1px 5px", borderRadius: 8,
                      background: s.zoom ? "var(--accent)" : "transparent",
                      color: s.zoom ? "#fff" : "var(--text-muted)",
                      border: s.zoom ? "none" : "1px solid var(--border)",
                      opacity: s.zoom ? 1 : 0.45,
                    }}>Zoom</span>
                    <span style={{
                      fontSize: "0.62rem", padding: "1px 5px", borderRadius: 8,
                      background: s.ff ? "#7c3aed" : "transparent",
                      color: s.ff ? "#fff" : "var(--text-muted)",
                      border: s.ff ? "none" : "1px solid var(--border)",
                      opacity: s.ff ? 1 : 0.45,
                    }}>Fireflies</span>
                    <span style={{ fontSize: "0.62rem", color: LINK_COLOR[s.linkKind] }}>
                      {LINK_LABEL[s.linkKind]}
                    </span>
                  </div>
                  <span className="zoom-import-meta">
                    {fmtDate(s.recordedAt)} · {fmtDuration(s.ff?.duration_seconds ?? s.durationMinutes * 60)}
                    {s.ff?.transcript_text && <span style={{ color: "var(--green)", marginLeft: 6 }}>✓ transcript</span>}
                    {s.ff?.description && <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>✓ summary</span>}
                    {(() => {
                      // Flag when Fireflies started materially before the Zoom recording (pre-meeting coordination captured)
                      const preRunMin = s.ff && s.zoom
                        ? Math.round((new Date(s.zoom.start_time).getTime() - new Date(s.ff.recorded_at).getTime()) / 60000)
                        : 0;
                      if (preRunMin <= 5) return null;
                      return (
                        <span style={{ color: "#f5a623", marginLeft: 6 }} title={`Fireflies started ~${preRunMin} min before Zoom — likely includes pre-meeting coordination. Consider trimming (ADR-021).`}>
                          ⚠ {preRunMin}m pre-run
                        </span>
                      );
                    })()}
                    {(() => {
                      const yt = getYouTubeDestination(s);
                      if (!yt) return null;
                      const statsLabel = yt.stats
                        ? ` · ${fmtViews(yt.stats.viewCount)} views`
                        : "";
                      return yt.url ? (
                        <span style={{ marginLeft: 6 }}>
                          <a
                            href={yt.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#e00", fontSize: "0.65rem", textDecoration: "none" }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            ▶ YouTube
                          </a>
                          {statsLabel && (
                            <span style={{ color: "var(--text-muted)", fontSize: "0.65rem" }}>
                              {statsLabel}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ color: "#e00", marginLeft: 6, fontSize: "0.65rem" }}>
                          ▶ YouTube ({yt.id}){statsLabel}
                        </span>
                      );
                    })()}
                  </span>
                </div>
              </label>
            ))}
          </div>

          {selectedCount > 0 && (
            <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={importSelected}>
              Import {selectedCount} session{selectedCount !== 1 ? "s" : ""}
            </button>
          )}
        </>
      )}

      {fetched && sessions.length === 0 && !loading && (
        <div className="zoom-import-error">No recordings found for this date range.</div>
      )}
    </div>
  );
}
