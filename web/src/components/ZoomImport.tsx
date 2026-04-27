"use client";

import { useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import { isExcluded } from "../lib/rules";
import HelpTip from "./HelpTip";

const CONNECTIONS_KEY = "video-sync:connections";

interface ZoomRecordingFile {
  file_type: string;
  download_url?: string;
  play_url?: string;
  status?: string;
}

function fmtHHMM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}:00`;
}

interface ZoomMeeting {
  uuid: string;
  id: number;
  topic: string;
  start_time: string;
  duration: number; // minutes
  share_url?: string;
  description?: string;
  recording_files?: ZoomRecordingFile[];
}

interface Props {
  onImported: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
  dateFrom?: string;
  dateTo?: string;
}

function getZoomCredentials(): { accountId: string; clientId: string; clientSecret: string } | null {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return null;
    const connections = JSON.parse(raw);
    const zoom = connections["Zoom"];
    if (!zoom?.connected) return null;
    const { accountId, clientId, clientSecret } = zoom.credentials;
    if (!accountId || !clientId || !clientSecret) return null;
    return { accountId, clientId, clientSecret };
  } catch {
    return null;
  }
}

export default function ZoomImport({ onImported, onEvent, dateFrom: dateFromProp, dateTo: dateToProp }: Props) {
  const [meetings, setMeetings] = useState<ZoomMeeting[]>([]);
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
  const [filterMinLen, setFilterMinLen] = useState("2");
  const [filterMaxLen, setFilterMaxLen] = useState("");
  const [filterDays, setFilterDays] = useState<Set<number>>(new Set());

  async function fetchRecordings() {
    const creds = getZoomCredentials();
    if (!creds) {
      setError("Zoom credentials not configured. Go to Connections and add your Account ID, Client ID, and Client Secret.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/zoom/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...creds, from: dateFrom, to: dateTo }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Request failed (${res.status})`);
        return;
      }
      setMeetings(data.meetings ?? []);
      setSelected(new Set());
      setFetched(true);
      if ((data.meetings ?? []).length === 0) {
        setError("No recordings found in the selected date range.");
      }
    } catch (err) {
      setError(`Network error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function toggleSelect(uuid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  }

  function importSelected() {
    let count = 0;
    let skipped = 0;
    for (const meeting of meetings) {
      if (!selected.has(meeting.uuid)) continue;

      const sourceId = `zoom-${meeting.uuid}`;
      if (isExcluded("Zoom", sourceId)) {
        skipped++;
        continue;
      }

      const downloadUrl = `zoom://recording/${meeting.uuid}`;

      const cmd: Record<string, unknown> = {
        source_id: sourceId,
        source_platform: "Zoom",
        title: meeting.topic,
        description: meeting.description || undefined,
        duration_seconds: meeting.duration * 60,
        participants: [],
        download_url: downloadUrl,
        tags: ["zoom-import"],
        recorded_at: meeting.start_time,
      };
      const meta: Record<string, string> = {};
      if (meeting.share_url) meta.share_url = meeting.share_url;
      if (meeting.id) meta.zoom_meeting_id = String(meeting.id);
      if (Object.keys(meta).length > 0) cmd.metadata_extra = meta;

      const record = new WasmVideoRecord(JSON.stringify(cmd));
      videoStore.add(record);
      onEvent(`VideoIndexed: "${meeting.topic}" (Zoom import)`);
      count++;
    }

    if (skipped > 0) {
      onEvent(`Zoom import: ${skipped} excluded recording(s) skipped`);
    }

    if (count > 0) {
      onImported();
      setMeetings([]);
      setSelected(new Set());
      setFetched(false);
    }
  }

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Zoom Recordings</h2>
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
            onClick={fetchRecordings}
            disabled={loading}
          >
            {loading ? "Fetching..." : "Fetch from Zoom"}
          </button>
        </div>
      </div>

      <HelpTip>
        Fetch and import recordings from your Zoom account. Select a date range, apply filters
        by title, duration, or day of week, then check the recordings you want to bring into
        the pipeline. Zoom credentials (Account ID, Client ID, Client Secret) must be configured
        in Connections first. A <strong>✓ transcript</strong> badge means Zoom has a
        transcript file available for that recording.
      </HelpTip>

      {error && <div className="zoom-import-error">{error}</div>}

      {fetched && meetings.length > 0 && (
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
            {meetings.filter((m) => {
              if (filterTitle && !m.topic.toLowerCase().includes(filterTitle.toLowerCase())) return false;
              if (filterMinLen && m.duration < Number(filterMinLen)) return false;
              if (filterMaxLen && m.duration > Number(filterMaxLen)) return false;
              if (filterDays.size > 0 && !filterDays.has(new Date(m.start_time).getDay())) return false;
              return true;
            }).map((m) => (
              <label key={m.uuid} className="zoom-import-item">
                <input
                  type="checkbox"
                  checked={selected.has(m.uuid)}
                  onChange={() => toggleSelect(m.uuid)}
                />
                <div>
                  <span className="zoom-import-topic">{m.topic}</span>
                  <span className="zoom-import-meta">
                    {new Date(m.start_time).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {" · "}
                    <span title={`${m.duration} min`}>{fmtHHMM(m.duration)}</span>
                    {m.recording_files?.some(f => f.file_type === "TRANSCRIPT") && (
                      <span style={{ color: "var(--green)", marginLeft: 4 }}>✓ transcript</span>
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
