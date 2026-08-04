"use client";

import { useEffect, useState } from "react";
import { loadClientLog, clearClientLog, type LogRecord } from "../lib/logger";

interface Props {
  events: string[]; // in-memory events from parent (legacy)
  forceShow?: boolean;
}

const LEVEL_COLOR: Record<string, string> = {
  debug: "#64748b",
  info: "#38bdf8",
  warn: "#fbbf24",
  error: "#f87171",
};

export default function EventLog({ events, forceShow = false }: Props) {
  const [stored, setStored] = useState<LogRecord[]>([]);
  const [showStructured, setShowStructured] = useState(false);

  useEffect(() => {
    setStored(loadClientLog());
  }, [events]); // refresh when parent events change (implies a user action occurred)

  function handleClear() {
    clearClientLog();
    setStored([]);
  }

  function handleDownload() {
    const all = loadClientLog();
    const blob = new Blob([all.map((r) => JSON.stringify(r)).join("\n")], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `video-sync-log-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const hasContent = events.length > 0 || stored.length > 0;
  if (!hasContent && !forceShow) return null;

  return (
    <section id="event-log" className="event-log" aria-labelledby="event-log-heading">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h2 id="event-log-heading" style={{ margin: 0 }}>
          Event Log
          {stored.length > 0 && (
            <span style={{ fontSize: "0.75rem", fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>
              {stored.length} structured · {events.length} session
            </span>
          )}
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn btn-sm"
            onClick={() => setShowStructured((v) => !v)}
            style={{ fontSize: "0.72rem" }}
            aria-pressed={showStructured}
          >
            {showStructured ? "Session view" : "Structured view"}
          </button>
          {stored.length > 0 && (
            <button className="btn btn-sm" onClick={handleDownload} style={{ fontSize: "0.72rem" }}>
              Download .jsonl
            </button>
          )}
          <button className="btn btn-sm" onClick={handleClear} style={{ fontSize: "0.72rem", color: "var(--red)" }}>
            Clear
          </button>
        </div>
      </div>

      {showStructured ? (
        // Structured log view (from localStorage buffer)
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {[...stored].reverse().slice(0, 200).map((r, i) => (
            <div key={i} className="event-entry" style={{ fontFamily: "monospace", fontSize: "0.72rem", display: "flex", gap: 8 }}>
              <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{r.ts.slice(11, 19)}</span>
              <span style={{ color: LEVEL_COLOR[r.level] ?? "#94a3b8", flexShrink: 0, width: 42 }}>
                {r.level.toUpperCase()}
              </span>
              <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{r.component}</span>
              <span>{r.msg}</span>
              {r.error && <span style={{ color: LEVEL_COLOR.error }}>Error: {r.error}</span>}
              {r.duration_ms !== undefined && (
                <span style={{ color: "var(--text-muted)", marginLeft: "auto" }}>{r.duration_ms}ms</span>
              )}
            </div>
          ))}
          {stored.length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>No structured log entries yet.</div>
          )}
        </div>
      ) : (
        // Session event view (in-memory, legacy)
        <div>
          {[...events].reverse().map((ev, i) => {
            const colonIdx = ev.indexOf(":");
            const type = colonIdx > 0 ? ev.slice(0, colonIdx) : ev;
            const detail = colonIdx > 0 ? ev.slice(colonIdx + 1) : "";
            return (
              <div key={events.length - 1 - i} className="event-entry">
                <span className="event-type">{type}</span>
                {detail}
              </div>
            );
          })}
          {events.length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>No session events. Switch to "Structured view" to see persisted logs.</div>
          )}
        </div>
      )}
    </section>
  );
}
