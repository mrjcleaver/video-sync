"use client";

import { useId, useMemo, useState } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import { type BackfillProfile, loadProfiles } from "../lib/backfill";
import BackfillOverview from "./BackfillOverview";
import BackfillCalendar from "./BackfillCalendar";
import HelpTip from "./HelpTip";

interface Props {
  videos: VideoRecordJSON[];
  onNavigateToVideo?: (id: string, intent?: "publish") => void;
}

const TAB_KEY = "video-sync:sync-status-tab";

/**
 * SyncStatusPanel - top-level "what's been synced" view, lifted out of
 * BackfillPanel. Shows Overview (month-by-month summary) and Calendar
 * (per-day grid) for the whole catalog.
 *
 * If backfill profiles exist, the operator picks one to drive the
 * target-days view. Otherwise, a synthesised "All videos" profile spans
 * from the earliest recording to today, all days targeted.
 */
export default function SyncStatusPanel({ videos, onNavigateToVideo }: Props) {
  const panelId = useId();
  const [activeTab, setActiveTab] = useState<"overview" | "calendar">(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      return v === "calendar" ? "calendar" : "overview";
    } catch {
      return "overview";
    }
  });
  const [profiles] = useState<BackfillProfile[]>(() => loadProfiles());
  const [profileId, setProfileId] = useState<string>(() => profiles[0]?.id ?? "__all__");

  function selectTab(tab: "overview" | "calendar") {
    setActiveTab(tab);
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ }
  }

  // Derive an "All videos" profile from the actual data so the view works
  // even when no backfill profile is configured.
  const syntheticAll = useMemo<BackfillProfile>(() => {
    const earliest = videos
      .map(v => (v.recorded_at || v.indexed_at || "").slice(0, 10))
      .filter(Boolean)
      .sort()[0] ?? new Date().toISOString().slice(0, 10);
    return {
      id: "__all__",
      name: "All videos",
      enabled: true,
      source_platforms: [],
      date_from: earliest,
      criteria: { days_of_week: [0, 1, 2, 3, 4, 5, 6] },
      default_privacy: "unlisted",
      max_uploads_per_day: 0,
      upload_window_start_hour: 0,
    };
  }, [videos]);

  // Sync Status is a "what's been synced through today" view. It borrows
  // the selected profile's source-platform / target-day shape but its
  // date_to is always "today". Otherwise a profile with a stale date_to
  // (e.g. set to two weeks ago when the operator was running a fixed
  // backfill window) hides every record imported since.
  const baseProfile = profileId === "__all__"
    ? syntheticAll
    : (profiles.find(p => p.id === profileId) ?? syntheticAll);
  const profileObj: BackfillProfile = useMemo(
    () => ({ ...baseProfile, date_to: new Date().toISOString().slice(0, 10) }),
    [baseProfile],
  );

  return (
    <section className="zoom-import sync-status-panel" aria-labelledby={`${panelId}-title`}>
      <div className="zoom-import-header sync-status-header">
        <h2 id={`${panelId}-title`}>Sync Status</h2>
        <label className="compact-field sync-status-profile" htmlFor={`${panelId}-profile`}>
          <span>Profile</span>
          <select
            id={`${panelId}-profile`}
            value={profileId}
            onChange={e => setProfileId(e.target.value)}
            style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
          >
            <option value="__all__">All videos</option>
            {profiles.map(p => (
              <option key={p.id} value={p.id}>{p.name || "(unnamed)"}</option>
            ))}
          </select>
        </label>
      </div>

      <HelpTip>
        Status of every video being synced, by month in Overview or by day in Calendar.
        Each row shows where the video has been published: <strong>YouTube</strong> badge
        (privacy-aware), <strong>Kaltura</strong> badge, and a <strong>Drive</strong> link
        to the artifacts folder (transcript, summary, chat, …). Filter to a backfill
        profile if you want to see only target-day coverage.
      </HelpTip>

      <div className="filter-tabs sync-status-tabs" style={{ marginBottom: 12 }} role="tablist" aria-label="Sync status view">
        {(["overview", "calendar"] as const).map(t => (
          <button
            key={t}
            id={`${panelId}-${t}-tab`}
            type="button"
            role="tab"
            aria-selected={activeTab === t}
            aria-controls={`${panelId}-${t}-panel`}
            className={`filter-tab ${activeTab === t ? "active" : ""}`}
            onClick={() => selectTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div
        id={`${panelId}-${activeTab}-panel`}
        className="sync-status-content"
        role="tabpanel"
        aria-labelledby={`${panelId}-${activeTab}-tab`}
        tabIndex={0}
      >
        {activeTab === "overview" && (
          <BackfillOverview videos={videos} profile={profileObj} onNavigateToVideo={onNavigateToVideo} />
        )}

        {activeTab === "calendar" && (
          <BackfillCalendar videos={videos} profile={profileObj} onNavigateToVideo={onNavigateToVideo} />
        )}
      </div>
    </section>
  );
}
