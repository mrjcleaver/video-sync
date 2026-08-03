"use client";

import { useEffect, useState } from "react";
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
  onImported: (imported?: { ids: string[] }) => void;
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
  // Bumping this triggers every source-import sub-panel to run its
  // own fetch. Each sub-panel useEffect-watches the prop and calls
  // its local fetch function when the value changes (skipping the
  // initial 0). Lets the "Fetch all" button fire four probes in
  // parallel without ImportPanel needing refs into each sub-panel.
  const [fetchTrigger, setFetchTrigger] = useState(0);
  // Shared title filter that layers on top of every Meetings sub-panel's
  // own filter. Case-insensitive substring match against each fetched
  // item's title / topic / name. Empty = no filter.
  const [sharedFilterTitle, setSharedFilterTitle] = useState("");

  // ADR-058 Option E — Overview's empty-slot "Import this day"
  // action deep-links to /import?from=YYYY-MM-DD&to=YYYY-MM-DD.
  // Read once on mount to prefill the pickers so the operator lands
  // on the right window without having to re-select it. Using
  // window.location directly avoids Next.js's useSearchParams
  // Suspense-boundary requirement — this component is client-only
  // and mounts under an already-client-side page.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    const to = params.get("to");
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) setDateFrom(from);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) setDateTo(to);
    if (from || to) setActive("meetings");
  }, []);

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
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => selectTab(id)}
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
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => onDateFromChange(e.target.value)}
                style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
              />
              <span>to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
              />
              <button
                className="btn btn-sm btn-primary"
                onClick={() => setFetchTrigger(n => n + 1)}
                title="Trigger Fetch on Fireflies + Zoom + Kaltura + YouTube Live sub-panels simultaneously"
                style={{ marginLeft: "auto" }}
              >
                🔄 Fetch all sources
              </button>
            </div>
            {/* Shared title filter applied to every Meetings sub-panel's
                list. Overrides each panel's own title filter when set. */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 16px 0", fontSize: "0.82rem", color: "var(--text-muted)", flexWrap: "wrap" }}>
              <span>Search titles:</span>
              <input
                type="text"
                value={sharedFilterTitle}
                onChange={(e) => setSharedFilterTitle(e.target.value)}
                placeholder="substring match across all four sources"
                style={{
                  flex: 1, minWidth: 240, padding: "4px 8px",
                  background: "var(--bg)", border: "1px solid var(--border)",
                  borderRadius: 6, color: "var(--text)", fontSize: "0.8rem",
                }}
              />
              {sharedFilterTitle && (
                <button
                  className="btn btn-sm"
                  onClick={() => setSharedFilterTitle("")}
                  style={{ fontSize: "0.72rem" }}
                  title="Clear the shared title filter"
                >
                  ✕
                </button>
              )}
            </div>
            <FirefliesImport onImported={onImported} onEvent={onEvent} dateFrom={dateFrom} dateTo={dateTo} fetchTrigger={fetchTrigger} sharedFilterTitle={sharedFilterTitle} />
            <div style={{ height: 1, background: "var(--border)", margin: "16px 0" }} />
            <ZoomImport      onImported={onImported} onEvent={onEvent} dateFrom={dateFrom} dateTo={dateTo} fetchTrigger={fetchTrigger} sharedFilterTitle={sharedFilterTitle} />
            <div style={{ height: 1, background: "var(--border)", margin: "16px 0" }} />
            <KalturaImport   onImported={onImported} onEvent={onEvent} dateFrom={dateFrom} dateTo={dateTo} fetchTrigger={fetchTrigger} sharedFilterTitle={sharedFilterTitle} />
            <div style={{ height: 1, background: "var(--border)", margin: "16px 0" }} />
            <YouTubeLiveImport onImported={onImported} onEvent={onEvent} dateFrom={dateFrom} dateTo={dateTo} fetchTrigger={fetchTrigger} sharedFilterTitle={sharedFilterTitle} />
          </>
        )}
        {active === "url"    && <URLImport onImported={onImported} onEvent={onEvent} />}
        {active === "manual" && <IndexForm onIndexed={onImported}  onEvent={onEvent} />}
      </div>
    </div>
  );
}
