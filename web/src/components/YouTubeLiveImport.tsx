"use client";

import { useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import { isExcluded } from "../lib/rules";
import HelpTip from "./HelpTip";

const CONNECTIONS_KEY = "video-sync:connections";

interface BroadcastEntry {
  id: string;
  title: string;
  description: string | null;
  publishedAt: string;
  privacyStatus?: string;
  thumbnail_url: string | null;
  duration_seconds: number;
  scheduledStartTime?: string;
  actualStartTime?: string;
  actualEndTime?: string;
  liveBroadcastContent: "live" | "upcoming" | "completed" | "none";
  channel_title?: string;
}

interface Props {
  onImported: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
  dateFrom?: string;
  dateTo?: string;
}

function fmtDuration(secs: number): string {
  if (!secs) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function getYouTubeCredentials(): { refreshToken: string; clientId: string; clientSecret: string } | null {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return null;
    const conn = JSON.parse(raw);
    const yt = conn["YouTube"];
    if (!yt?.connected) return null;
    const { refreshToken, clientId, clientSecret } = yt.credentials ?? {};
    if (!refreshToken || !clientId || !clientSecret) return null;
    return { refreshToken, clientId, clientSecret };
  } catch {
    return null;
  }
}

export default function YouTubeLiveImport({ onImported, onEvent, dateFrom: dateFromProp, dateTo: dateToProp }: Props) {
  const [broadcasts, setBroadcasts] = useState<BroadcastEntry[]>([]);
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
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "live" | "upcoming">("all");

  async function fetchBroadcasts() {
    const creds = getYouTubeCredentials();
    if (!creds) {
      setError("YouTube not authorised. Configure refresh token, client ID, and secret in Connections.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: dateFrom, to: dateTo });
      const res = await fetch(`/api/youtube/live-broadcasts?${params}`, {
        headers: {
          "x-youtube-refresh-token": creds.refreshToken,
          "x-youtube-client-id": creds.clientId,
          "x-youtube-client-secret": creds.clientSecret,
        },
      });
      const data = await res.json();
      if (!res.ok) {
        setError((data as { error?: string }).error ?? `Request failed (${res.status})`);
        return;
      }
      setBroadcasts((data.broadcasts ?? []) as BroadcastEntry[]);
      setSelected(new Set());
      setFetched(true);
      if ((data.broadcasts ?? []).length === 0) {
        setError("No broadcasts found in the selected date range.");
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
    const all = videoStore.getAll();
    const existing = new Set(all.map(v => `${v.source_platform}:${v.source_id}`));
    for (const b of broadcasts) {
      if (!selected.has(b.id)) continue;
      const sourceId = `youtube-${b.id}`;
      if (isExcluded("YouTube", sourceId) || existing.has(`YouTube:${sourceId}`)) {
        skipped++;
        continue;
      }
      // Recorded-at: prefer the actual start time of the broadcast (when
      // the streaming software went live), fall back to scheduled or
      // publishedAt. This puts the row on the right calendar date in
      // Sync Status.
      const recordedAt = b.actualStartTime ?? b.scheduledStartTime ?? b.publishedAt;

      const cmd: Record<string, unknown> = {
        source_id: sourceId,
        source_platform: "YouTube",
        title: b.title,
        description: b.description ?? undefined,
        duration_seconds: b.duration_seconds,
        participants: [],
        download_url: `youtube://${b.id}`,
        thumbnail_url: b.thumbnail_url ?? undefined,
        tags: ["youtube-live", `live-${b.liveBroadcastContent}`],
        recorded_at: recordedAt,
        metadata_extra: {
          channel: b.channel_title ?? "",
          privacy_status: b.privacyStatus ?? "",
          live_broadcast_content: b.liveBroadcastContent,
          live_broadcast: "1",
          ...(b.actualStartTime ? { actual_start_time: b.actualStartTime } : {}),
          ...(b.actualEndTime ? { actual_end_time: b.actualEndTime } : {}),
          ...(b.scheduledStartTime ? { scheduled_start_time: b.scheduledStartTime } : {}),
          youtube_url: `https://www.youtube.com/watch?v=${b.id}`,
        },
      };

      const record = new WasmVideoRecord(JSON.stringify(cmd));
      videoStore.add(record);
      onEvent(`VideoIndexed: "${b.title}" (YouTube live ${b.liveBroadcastContent})`, { video_id: record.id() });
      count++;
    }
    if (skipped > 0) onEvent(`YouTube live import: ${skipped} duplicate/excluded broadcast(s) skipped`);
    if (count > 0) {
      onImported();
      setBroadcasts([]);
      setSelected(new Set());
      setFetched(false);
    }
  }

  const visible = broadcasts.filter(b => {
    if (filterTitle && !b.title.toLowerCase().includes(filterTitle.toLowerCase())) return false;
    if (statusFilter !== "all" && b.liveBroadcastContent !== statusFilter) return false;
    return true;
  });

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>YouTube Live Broadcasts</h2>
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
          <button className="btn btn-sm btn-primary" onClick={fetchBroadcasts} disabled={loading}>
            {loading ? "Fetching..." : "Fetch from YouTube"}
          </button>
        </div>
      </div>

      <HelpTip>
        Pulls broadcasts from your YouTube channel — past, currently-live, and
        upcoming. These are the entries on YouTube Studio&apos;s Live tab,
        produced by streaming software (OBS, Streamyard, Wirecast, vMix)
        that ingests via YouTube Live RTMP. <strong>Recorded-at</strong> is
        the actual start time of the broadcast, so the catalog row lands on
        the right day in Sync Status.
      </HelpTip>

      {error && <div className="zoom-import-error">{error}</div>}

      {fetched && broadcasts.length > 0 && (
        <>
          <div className="zoom-import-filters" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <input
              placeholder="Filter by title..."
              value={filterTitle}
              onChange={(e) => setFilterTitle(e.target.value)}
              style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem", flex: "1 1 140px" }}
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
            >
              <option value="all">All broadcasts</option>
              <option value="completed">Completed (past)</option>
              <option value="live">Currently live</option>
              <option value="upcoming">Upcoming</option>
            </select>
          </div>
          <div className="zoom-import-list">
            {visible.map((b) => {
              const when = b.actualStartTime ?? b.scheduledStartTime ?? b.publishedAt;
              return (
                <label key={b.id} className="zoom-import-item">
                  <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggleSelect(b.id)} />
                  <div>
                    <span className="zoom-import-topic">{b.title}</span>
                    <span className="zoom-import-meta">
                      {when ? new Date(when).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                      {" · "}
                      <span title={`${Math.round(b.duration_seconds / 60)} min`}>{fmtDuration(b.duration_seconds)}</span>
                      {b.liveBroadcastContent === "live" && <span style={{ color: "var(--red)", marginLeft: 6, fontWeight: 600 }}>● LIVE</span>}
                      {b.liveBroadcastContent === "upcoming" && <span style={{ color: "var(--purple)", marginLeft: 6 }}>scheduled</span>}
                      {b.liveBroadcastContent === "completed" && <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>completed</span>}
                    </span>
                  </div>
                </label>
              );
            })}
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
