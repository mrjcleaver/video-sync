"use client";

import { useState } from "react";
import ZoomImport from "./ZoomImport";
import FirefliesImport from "./FirefliesImport";
import URLImport from "./URLImport";
import IndexForm from "./IndexForm";

type Tab = "zoom" | "fireflies" | "url" | "manual";

const TABS: { id: Tab; label: string }[] = [
  { id: "fireflies",  label: "Fireflies" },
  { id: "zoom",       label: "Zoom" },
  { id: "url",        label: "URL" },
  { id: "manual",     label: "Manual" },
];

const TAB_KEY = "video-sync:import-tab";

interface Props {
  onImported: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
}

export default function ImportPanel({ onImported, onEvent }: Props) {
  const [active, setActive] = useState<Tab>(() => {
    try { return (localStorage.getItem(TAB_KEY) as Tab) ?? "fireflies"; } catch { return "fireflies"; }
  });

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
        {active === "zoom"      && <ZoomImport       onImported={onImported} onEvent={onEvent} />}
        {active === "fireflies" && <FirefliesImport   onImported={onImported} onEvent={onEvent} />}
        {active === "url"       && <URLImport         onImported={onImported} onEvent={onEvent} />}
        {active === "manual"    && <IndexForm         onIndexed={onImported}  onEvent={onEvent} />}
      </div>
    </div>
  );
}
