"use client";

/**
 * ADR-057 — Overview / Calendar page.
 *
 * SyncStatusPanel already carries Overview + Calendar as tabs
 * (tab selection persists in localStorage). Promoted from /import
 * to its own sidebar entry because operators surfaced this as
 * "the first place I tend to look" — deserves top-level billing.
 *
 * ADR-058 Option D: a compact per-source "last checked" banner
 * above the panel turns empty target-day slots from ambiguous
 * ("nothing here") into truthful ("checked N ago" vs "not checked
 * for this window"). The banner sits above so it colours the
 * operator's interpretation of every calendar row below.
 */

import SyncStatusPanel from "../../../components/SyncStatusPanel";
import { useApp } from "../AppContext";
import { getImportState, type ImportStateSnapshot } from "../../../lib/importStateClient";
import { useEffect, useState } from "react";

function relativeTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const SOURCES = ["Zoom", "Fireflies", "YouTube", "Kaltura"] as const;

function LastCheckedBanner({ state }: { state: ImportStateSnapshot }) {
  const hasAny = SOURCES.some(s => state.sources[s]);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      padding: "8px 12px", marginBottom: 12,
      background: "var(--bg-card, rgba(99,102,241,0.05))",
      border: "1px solid var(--border)", borderRadius: 6,
      fontSize: "0.78rem",
    }}>
      <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>
        Last checked (ADR-058):
      </span>
      {SOURCES.map(source => {
        const s = state.sources[source];
        const label = s
          ? `${relativeTime(s.last_checked_at)} — ${s.last_range_from} → ${s.last_range_to}`
          : "not checked yet";
        return (
          <span
            key={source}
            title={s
              ? `Widest known-checked range for ${source} (grows every time you click Fetch in the Import panel).`
              : `${source} hasn't been probed yet — empty target days may just mean we haven't looked, not that nothing is there.`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "2px 8px", borderRadius: 12,
              background: s ? "rgba(56,189,248,0.10)" : "rgba(148,163,184,0.10)",
              border: `1px solid ${s ? "rgba(56,189,248,0.25)" : "rgba(148,163,184,0.25)"}`,
              color: s ? "#38bdf8" : "#94a3b8",
            }}
          >
            <span style={{ fontWeight: 600 }}>{source}</span>
            <span style={{ fontSize: "0.7rem", opacity: 0.9 }}>· {label}</span>
          </span>
        );
      })}
      {!hasAny && (
        <span style={{ color: "var(--text-muted)", fontSize: "0.72rem", marginLeft: "auto" }}>
          Click ⬇ import on any empty day to start.
        </span>
      )}
    </div>
  );
}

export default function OverviewPage() {
  const { videos, broadcastPairs, showPaired, ensureVideoVisible } = useApp();
  const [importState, setImportState] = useState<ImportStateSnapshot>({ sources: {} });

  useEffect(() => {
    let cancelled = false;
    getImportState().then(s => { if (!cancelled) setImportState(s); });
    return () => { cancelled = true; };
  }, []);

  // OpusClip clips are excluded from the Overview per-day rollups —
  // a single recording can produce 20+ shorts and they'd swamp the
  // parent recording. Show the count separately so the operator can
  // see clip volume at a glance without noise on the calendar.
  const clipCount = videos.filter(v => v.source_platform === "OpusClip").length;
  const withoutClips = videos.filter(v => v.source_platform !== "OpusClip");
  const visibleVideos = showPaired
    ? withoutClips
    : withoutClips.filter(v => !broadcastPairs.destinationRecordIds.has(v.id));
  return (
    <>
      <div className="header">
        <h1>Overview</h1>
        {clipCount > 0 && (
          <span
            style={{
              fontSize: "0.75rem",
              color: "rgb(94,234,212)",
              background: "rgba(20,184,166,0.08)",
              border: "1px solid rgba(20,184,166,0.25)",
              borderRadius: 12,
              padding: "2px 10px",
              marginLeft: 12,
              fontWeight: 600,
            }}
            title="OpusClip shorts derived from your recordings — nested under their parent video in the catalog, listed on /shorts"
          >
            ✂️ {clipCount} clip{clipCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <LastCheckedBanner state={importState} />
      <SyncStatusPanel videos={visibleVideos} onNavigateToVideo={ensureVideoVisible} />
    </>
  );
}
