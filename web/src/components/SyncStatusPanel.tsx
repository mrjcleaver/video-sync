"use client";

import { useMemo, useState } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import { type BackfillProfile, loadProfiles } from "../lib/backfill";
import { getPrivacy } from "../lib/youtubePrivacyCache";
import BackfillOverview from "./BackfillOverview";
import BackfillCalendar from "./BackfillCalendar";
import HelpTip from "./HelpTip";

interface Props {
  videos: VideoRecordJSON[];
  onNavigateToVideo?: (id: string, intent?: "publish") => void;
}

const TAB_KEY = "video-sync:sync-status-tab";
const DEST_KEY = "video-sync:sync-status-dest";
const PRIV_KEY = "video-sync:sync-status-privacy";

type DestFilter = "any" | "youtube" | "kaltura" | "both" | "neither";
type PrivacyFilter = "any" | "public" | "not_public";

function extractYtId(v: VideoRecordJSON): string | null {
  const dest = v.locations?.find(l => l.platform === "YouTube" && l.external_id);
  if (dest?.external_id) return dest.external_id.replace(/^youtube-/, "");
  if (v.source_platform === "YouTube") return v.source_id.replace(/^youtube-/, "");
  return null;
}

function hasLocation(v: VideoRecordJSON, platform: string): boolean {
  if (v.source_platform === platform) return true;
  return (v.locations ?? []).some(l => l.platform === platform);
}

/**
 * SyncStatusPanel — top-level "what's been synced" view, lifted out of
 * BackfillPanel. Shows Overview (month-by-month summary) and Calendar
 * (per-day grid) for the whole catalog.
 *
 * If backfill profiles exist, the operator picks one to drive the
 * target-days view. Otherwise, a synthesised "All videos" profile spans
 * from the earliest recording to today, all days targeted.
 */
export default function SyncStatusPanel({ videos, onNavigateToVideo }: Props) {
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
  const [destFilter, setDestFilter] = useState<DestFilter>(() => {
    try { const v = localStorage.getItem(DEST_KEY); return (v === "youtube" || v === "kaltura" || v === "both" || v === "neither") ? v : "any"; }
    catch { return "any"; }
  });
  const [privacyFilter, setPrivacyFilter] = useState<PrivacyFilter>(() => {
    try { const v = localStorage.getItem(PRIV_KEY); return (v === "public" || v === "not_public") ? v : "any"; }
    catch { return "any"; }
  });

  function selectDest(v: DestFilter) {
    setDestFilter(v);
    try { localStorage.setItem(DEST_KEY, v); } catch { /* ignore */ }
  }
  function selectPrivacy(v: PrivacyFilter) {
    setPrivacyFilter(v);
    try { localStorage.setItem(PRIV_KEY, v); } catch { /* ignore */ }
  }

  // Apply destination + privacy filters BEFORE handing to the child
  // panels so per-day / per-month rollups only count what matched.
  const filteredVideos = useMemo(() => {
    if (destFilter === "any" && privacyFilter === "any") return videos;
    return videos.filter(v => {
      const hasYt = hasLocation(v, "YouTube");
      const hasKal = hasLocation(v, "Kaltura");
      if (destFilter === "youtube" && !hasYt) return false;
      if (destFilter === "kaltura" && !hasKal) return false;
      if (destFilter === "both" && !(hasYt && hasKal)) return false;
      if (destFilter === "neither" && (hasYt || hasKal)) return false;
      if (privacyFilter !== "any") {
        // Privacy is a YouTube-only concept in this codebase (Kaltura
        // doesn't expose a public/private toggle we track). Records
        // without a YouTube location have no meaningful privacy and
        // are dropped when a privacy filter is active.
        const ytId = extractYtId(v);
        if (!ytId) return false;
        const priv = getPrivacy(ytId) ?? "unknown";
        if (privacyFilter === "public" && priv !== "public") return false;
        if (privacyFilter === "not_public" && priv === "public") return false;
      }
      return true;
    });
  }, [videos, destFilter, privacyFilter]);

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

  // Sync Status is a "what's been synced through today" view — it borrows
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
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Sync Status</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "0.8rem", flexWrap: "wrap" }}>
          <select
            value={profileId}
            onChange={e => setProfileId(e.target.value)}
            style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
            title="Filter to a backfill profile, or show every video"
          >
            <option value="__all__">All videos</option>
            {profiles.map(p => (
              <option key={p.id} value={p.id}>{p.name || "(unnamed)"}</option>
            ))}
          </select>
          <label style={{ display: "inline-flex", gap: 4, alignItems: "center", color: "var(--text-muted)" }}>
            <span style={{ fontSize: "0.72rem" }}>Where:</span>
            <select
              value={destFilter}
              onChange={e => selectDest(e.target.value as DestFilter)}
              style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
              title="Filter to records that have (or don't have) a YouTube / Kaltura location"
            >
              <option value="any">Any</option>
              <option value="youtube">On YouTube</option>
              <option value="kaltura">On Kaltura</option>
              <option value="both">On both</option>
              <option value="neither">On neither</option>
            </select>
          </label>
          <label style={{ display: "inline-flex", gap: 4, alignItems: "center", color: "var(--text-muted)" }}>
            <span style={{ fontSize: "0.72rem" }}>Privacy:</span>
            <select
              value={privacyFilter}
              onChange={e => selectPrivacy(e.target.value as PrivacyFilter)}
              style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
              title="Filter by YouTube privacy status (cached from the last Check Status). Non-public = unlisted, private, or unknown."
            >
              <option value="any">Any</option>
              <option value="public">Public</option>
              <option value="not_public">Not public</option>
            </select>
          </label>
          {(destFilter !== "any" || privacyFilter !== "any") && (
            <span
              style={{
                fontSize: "0.72rem", color: "var(--text-muted)",
                padding: "2px 8px", borderRadius: 12,
                background: "var(--bg-card, rgba(99,102,241,0.05))",
                border: "1px solid var(--border)",
              }}
              title={`${filteredVideos.length} of ${videos.length} match the current filters`}
            >
              {filteredVideos.length} / {videos.length}
            </span>
          )}
        </div>
      </div>

      <HelpTip>
        Status of every video being synced — by month (Overview) or by day (Calendar).
        Each row shows where the video has been published: <strong>YouTube</strong> badge
        (privacy-aware), <strong>Kaltura</strong> badge, and a <strong>Drive</strong> link
        to the artifacts folder (transcript, summary, chat, …). Filter to a backfill
        profile if you want to see only target-day coverage. The <strong>Where</strong> and{" "}
        <strong>Privacy</strong> dropdowns narrow to records that (do or don&apos;t) exist on
        YouTube / Kaltura and, for YouTube, by cached privacy status. Privacy comes from the
        client-side cache written by Check Status / bulk backfill — records without a cached
        privacy default to &quot;not public&quot;.
      </HelpTip>

      <div className="filter-tabs" style={{ marginBottom: 12 }}>
        {(["overview", "calendar"] as const).map(t => (
          <button
            key={t}
            className={`filter-tab ${activeTab === t ? "active" : ""}`}
            onClick={() => selectTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <BackfillOverview videos={filteredVideos} profile={profileObj} onNavigateToVideo={onNavigateToVideo} />
      )}

      {activeTab === "calendar" && (
        <BackfillCalendar videos={filteredVideos} profile={profileObj} onNavigateToVideo={onNavigateToVideo} />
      )}
    </div>
  );
}
