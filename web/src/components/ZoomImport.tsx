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
    // ADR-042: don't gate on local creds because the server resolves through
    // local override → shared default → env var. If nothing is configured
    // anywhere, the server returns 400 with a clear message.
    const creds = getZoomCredentials() ?? {};

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

  /**
   * Background-fetch the Zoom in-meeting CHAT for a record (if available)
   * and push it to Drive as `chat.md`. Best-effort; failures are logged
   * to the event stream and don't block the import.
   */
  async function fetchAndStoreChat(args: {
    record_id: string;
    meeting_uuid: string;
    title: string;
    source_id: string;
    recorded_at: string;
    creds: { accountId: string; clientId: string; clientSecret: string } | null;
  }): Promise<void> {
    try {
      const res = await fetch("/api/zoom/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(args.creds ?? {}), meetingUuid: args.meeting_uuid }),
      });
      if (res.status === 404) return; // no CHAT file for this recording, which is common and silent
      if (!res.ok) {
        onEvent(`Zoom chat fetch failed for "${args.title}": ${res.status}`);
        return;
      }
      const data = await res.json() as { content: string; participants: string[]; private_chats_stripped: boolean; private_chats_stripped_count: number; lines: number };
      if (!data.content) return;

      const frontmatter = [
        "---",
        `record_id: ${args.record_id}`,
        "source_platform: Zoom",
        `source_id: ${args.source_id}`,
        `recorded_at: ${args.recorded_at}`,
        `generated_at: ${new Date().toISOString()}`,
        `private_chats_stripped: ${data.private_chats_stripped}`,
        ...(data.private_chats_stripped_count > 0 ? [`private_chats_stripped_count: ${data.private_chats_stripped_count}`] : []),
        `participants: [${data.participants.join(", ")}]`,
        "---",
        "",
        "",
      ].join("\n");

      const putRes = await fetch(`/api/artifacts/${encodeURIComponent(args.record_id)}/chat`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: frontmatter + data.content,
          title: args.title,
          source_platform: "Zoom",
          source_id: args.source_id,
          recorded_at: args.recorded_at,
        }),
      });
      if (!putRes.ok) {
        onEvent(`Zoom chat upload failed for "${args.title}": ${putRes.status}`);
        return;
      }
      onEvent(`Zoom chat captured for "${args.title}" (${data.lines} lines${data.private_chats_stripped_count > 0 ? `, ${data.private_chats_stripped_count} private stripped` : ""})`);
    } catch (err) {
      onEvent(`Zoom chat error for "${args.title}": ${String(err)}`);
    }
  }

  function importSelected() {
    let count = 0;
    let skipped = 0;
    const chatJobs: Array<() => Promise<void>> = [];
    const creds = getZoomCredentials();

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

      // ADR-039: capture in-meeting chat to Drive if a CHAT file exists
      if (meeting.recording_files?.some((f) => f.file_type === "CHAT")) {
        const recordId = record.id();
        chatJobs.push(() => fetchAndStoreChat({
          record_id: recordId,
          meeting_uuid: meeting.uuid,
          title: meeting.topic,
          source_id: sourceId,
          recorded_at: meeting.start_time,
          creds,
        }));
      }

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

      // Fire chat fetches in the background, throttled to avoid hammering Zoom
      void (async () => {
        for (const job of chatJobs) {
          await job();
        }
      })();
    }
  }

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Zoom Recordings</h2>
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
            onClick={fetchRecordings}
            disabled={loading}
            aria-busy={loading}
            aria-describedby={error ? "zoom-import-message" : undefined}
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

      {error && (
        <div id="zoom-import-message" className="zoom-import-error" role="alert">
          {error}
        </div>
      )}

      {fetched && meetings.length > 0 && (
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
