"use client";

import { useState } from "react";
import ZoomImport from "./ZoomImport";
import FirefliesImport from "./FirefliesImport";
import KalturaImport from "./KalturaImport";
import YouTubeLiveImport from "./YouTubeLiveImport";
import URLImport from "./URLImport";
import IndexForm from "./IndexForm";

type Tab = "meetings" | "url" | "manual";

const TABS: { id: Tab; label: string }[] = [
  { id: "meetings", label: "Meetings" },
  { id: "url",      label: "URL" },
  { id: "manual",   label: "Manual" },
];

const TAB_KEY = "video-sync:import-tab";

interface Props {
  onImported: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
}

function loadInitialTab(): Tab {
  try {
    const raw = localStorage.getItem(TAB_KEY);
    // Migrate the old per-source tabs to the merged Meetings tab.
    if (raw === "fireflies" || raw === "zoom") return "meetings";
    if (raw === "meetings" || raw === "url" || raw === "manual") return raw;
  } catch { /* ignore */ }
  return "meetings";
}

export default function ImportPanel({ onImported, onEvent }: Props) {
  const [active, setActive] = useState<Tab>(loadInitialTab);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));

  // When the operator picks the 1st of any month as the start date, auto-fill
  // the end date to the last day of that same month. Saves the second click
  // for the common "import all of <month>" workflow.
  function onDateFromChange(value: string) {
    setDateFrom(value);
    if (/^\d{4}-\d{2}-01$/.test(value)) {
      const [y, m] = value.split("-").map(Number);
      // Day 0 of next month = last day of current month, in UTC
      const last = new Date(Date.UTC(y, m, 0));
      setDateTo(last.toISOString().slice(0, 10));
    }
  }

  function selectTab(tab: Tab) {
    setActive(tab);
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ }
  }

  return (
    <div className="zoom-import" style={{ padding: 0 }}>
      {/* Tab bar */}
      <div role="group" aria-label="Import method" style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => selectTab(id)}
            aria-pressed={active === id}
            style={{
              padding: "8px 16px",
              fontSize: "0.82rem",
              fontWeight: active === id ? 600 : 400,
              color: active === id ? "var(--text)" : "var(--text-muted)",
              background: "none",
              border: "none",
              borderBottom: active === id ? "2px solid var(--primary, #6366f1)" : "2px solid transparent",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ padding: "0" }}>
        {active === "meetings" && (
          <>
            {/* Shared date range — used by both Fireflies and Zoom fetch buttons. */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "12px 16px 0", fontSize: "0.82rem", color: "var(--text-muted)", flexWrap: "wrap" }}>
              <span>Date range:</span>
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
                <label htmlFor="import-date-from">From</label>
                <input
                  id="import-date-from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => onDateFromChange(e.target.value)}
                  style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
                />
              </span>
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
                <label htmlFor="import-date-to">To</label>
                <input
                  id="import-date-to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
                />
              </span>
            </div>
            <FirefliesImport onImported={onImported} onEvent={onEvent} dateFrom={dateFrom} dateTo={dateTo} />
            <div style={{ height: 1, background: "var(--border)", margin: "16px 0" }} />
            <ZoomImport      onImported={onImported} onEvent={onEvent} dateFrom={dateFrom} dateTo={dateTo} />
            <div style={{ height: 1, background: "var(--border)", margin: "16px 0" }} />
            <KalturaImport   onImported={onImported} onEvent={onEvent} dateFrom={dateFrom} dateTo={dateTo} />
            <div style={{ height: 1, background: "var(--border)", margin: "16px 0" }} />
            <YouTubeLiveImport onImported={onImported} onEvent={onEvent} dateFrom={dateFrom} dateTo={dateTo} />
          </>
        )}
        {active === "url"    && <URLImport onImported={onImported} onEvent={onEvent} />}
        {active === "manual" && <IndexForm onIndexed={onImported}  onEvent={onEvent} />}
      </div>
    </div>
  );
}
