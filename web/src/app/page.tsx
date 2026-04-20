"use client";

import { useEffect, useState, useCallback } from "react";
import { bootStore, videoStore } from "../lib/store";
import type { VideoRecordJSON } from "../lib/wasm";
import { loadExclusions, syncRulesFromServer } from "../lib/rules";
import { syncProcessingRulesFromServer, syncPostProcessingRulesFromServer } from "../lib/processingRules";
import { clientLog } from "../lib/logger";
import { useRuleRunner } from "../lib/useRuleRunner";
import { useMemoryHealth } from "../lib/useMemoryHealth";
import ImportPanel from "../components/ImportPanel";
import ConnectionsPanel from "../components/ConnectionsPanel";
import RulesPanel from "../components/RulesPanel";
import ProcessingRulesPanel from "../components/ProcessingRulesPanel";
import PostProcessingRulesPanel from "../components/PostProcessingRulesPanel";
import BackfillPanel from "../components/BackfillPanel";
import VideoCard from "../components/VideoCard";
import ProvenanceGraph from "../components/ProvenanceGraph";
import EventLog from "../components/EventLog";
import ErrorBoundary from "../components/ErrorBoundary";
import ShortsPanel from "../components/ShortsPanel";

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function BuildBadge() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "local";
  const date = process.env.NEXT_PUBLIC_BUILD_DATE ?? "";
  const ago = date ? timeAgo(date) : "";
  const fullDate = date ? new Date(date).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
  return (
    <span title={fullDate} style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "monospace", cursor: "default" }}>
      v{version} · {sha}{ago ? ` · ${ago}` : ""}
    </span>
  );
}

const ACTIVE_STATUSES = ["Discovered", "InScope", "Approved", "Publishing", "Failed", "ToRetry"] as const;
const DONE_STATUSES = ["Published", "Skipped", "Abandoned"] as const;
const ALL_STATUSES = ["Active", "All", ...ACTIVE_STATUSES, "Done", ...DONE_STATUSES] as const;

export default function Dashboard() {
  const [ready, setReady] = useState(false);
  const [videos, setVideos] = useState<VideoRecordJSON[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>("Active");
  const [showLogs, setShowLogs] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [view, setView] = useState<"videos" | "provenance">("videos");
  const [sortBy, setSortBy] = useState<"recorded" | "updated">("recorded");

  useEffect(() => {
    const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
    const sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "local";
    const date = process.env.NEXT_PUBLIC_BUILD_DATE ?? new Date().toISOString();
    clientLog("info", "app:boot", `Video Sync v${version} (${sha}) built ${date}`);

    // Sync rules from server before booting UI (ADR-031)
    Promise.all([
      syncRulesFromServer(),
      syncProcessingRulesFromServer(),
      syncPostProcessingRulesFromServer(),
    ]).finally(() => {
      bootStore().then(() => {
        setReady(true);
        setVideos(videoStore.getAll());
      }).catch((err) => {
        console.error("WASM boot failed:", err);
        setReady(true);
      });
    });
  }, []);

  const refresh = useCallback(() => {
    setVideos(videoStore.getAll());
  }, []);

  const addEvent = useCallback((ev: string, fields?: { video_id?: string }) => {
    setEvents((prev) => [...prev, ev]);
    clientLog("info", "event", ev, fields);
  }, []);

  const { isRunning: isRunnerRunning, lastRun, matchCount, runNow } = useRuleRunner({
    onEvent: addEvent,
    onMutated: refresh,
  });

  useMemoryHealth();

  function bulkApprove() {
    const inScope = videos.filter((v) => v.status === "InScope");
    for (const v of inScope) {
      videoStore.mutate(v.id, (r) =>
        r.approve(
          JSON.stringify({
            actor: { user_id: "00000000-0000-0000-0000-000000000001", role: "Admin" },
          })
        )
      );
    }
    addEvent(`Bulk approved ${inScope.length} InScope videos`);
    refresh();
  }

  if (!ready) {
    return <div className="loading">Loading WASM module...</div>;
  }

  function lastChange(v: VideoRecordJSON): number {
    return Math.max(
      new Date(v.published_at || 0).getTime(),
      new Date(v.curated_at || 0).getTime(),
      new Date(v.indexed_at).getTime(),
    );
  }

  const filtered = (
    filter === "All" ? videos
    : filter === "Active" ? videos.filter((v) => (ACTIVE_STATUSES as readonly string[]).includes(v.status))
    : filter === "Done" ? videos.filter((v) => (DONE_STATUSES as readonly string[]).includes(v.status))
    : videos.filter((v) => v.status === filter)
  ).slice().sort((a, b) =>
    sortBy === "recorded"
      ? new Date(b.recorded_at || b.indexed_at).getTime() - new Date(a.recorded_at || a.indexed_at).getTime()
      : lastChange(b) - lastChange(a)
  );

  const counts: Record<string, number> = {};
  for (const v of videos) {
    counts[v.status] = (counts[v.status] || 0) + 1;
  }
  const exclusionCount = loadExclusions().length;

  return (
    <ErrorBoundary>
    <div className="container">
      <div className="header">
        <h1>Video Sync</h1>
        <BuildBadge />
        <div className="stats">
          <span className="stat-badge">{videos.length} total</span>
          {counts["Discovered"] && (
            <span className="stat-badge">{counts["Discovered"]} to review</span>
          )}
          {counts["Published"] && (
            <span className="stat-badge">{counts["Published"]} published</span>
          )}
          <button
            className={`btn btn-sm ${showConnections ? "btn-primary" : ""}`}
            onClick={() => setShowConnections((v) => !v)}
          >
            {showConnections ? "Hide Connections" : "Connections"}
          </button>
          <button
            className={`btn btn-sm ${showLogs ? "btn-primary" : ""}`}
            onClick={() => setShowLogs((v) => !v)}
          >
            {showLogs ? "Hide Logs" : "View Logs"}
          </button>
        </div>
      </div>

      <ConnectionsPanel open={showConnections} onToggle={() => setShowConnections((v) => !v)} />

      <ImportPanel onImported={refresh} onEvent={addEvent} />

      <RulesPanel
        isRunnerRunning={isRunnerRunning}
        lastRun={lastRun}
        matchCount={matchCount}
        onRunNow={runNow}
      />

      <ProcessingRulesPanel />

      <PostProcessingRulesPanel />

      <BackfillPanel videos={videos} onEvent={addEvent} onMutated={refresh} />

      <ShortsPanel videos={videos} onEvent={addEvent} onMutated={refresh} />

      {/* Burndown stats */}
      <div className="burndown-stats">
        <span>Total: {videos.length}</span>
        {exclusionCount > 0 && <span>Excluded: {exclusionCount}</span>}
        {Object.entries(counts)
          .sort(([a], [b]) => ALL_STATUSES.indexOf(a as typeof ALL_STATUSES[number]) - ALL_STATUSES.indexOf(b as typeof ALL_STATUSES[number]))
          .map(([status, count]) => (
            <span key={status}>
              {status}: {count}
            </span>
          ))}
      </div>

      {/* View switcher */}
      <div className="filter-tabs" style={{ marginBottom: 0 }}>
        <button
          className={`filter-tab ${view === "videos" ? "active" : ""}`}
          onClick={() => setView("videos")}
        >
          Videos ({videos.length})
        </button>
        <button
          className={`filter-tab ${view === "provenance" ? "active" : ""}`}
          onClick={() => setView("provenance")}
        >
          Provenance
        </button>
      </div>

      {view === "videos" && (
        <>
          <div className="filter-tabs">
            {/* Group: summary tabs */}
            {(["Active", "All", "Done"] as const).map((s) => {
              const count = s === "All" ? videos.length
                : s === "Active" ? ACTIVE_STATUSES.reduce((n, st) => n + (counts[st] ?? 0), 0)
                : DONE_STATUSES.reduce((n, st) => n + (counts[st] ?? 0), 0);
              return (
                <button
                  key={s}
                  className={`filter-tab ${filter === s ? "active" : ""}`}
                  style={{ fontWeight: 600 }}
                  onClick={() => setFilter(s)}
                >
                  {s} ({count})
                </button>
              );
            })}
            {/* Separator */}
            <span style={{ borderLeft: "1px solid var(--border)", margin: "0 4px", alignSelf: "stretch" }} />
            {/* Active sub-statuses */}
            {ACTIVE_STATUSES.map((s) => counts[s] ? (
              <button
                key={s}
                className={`filter-tab ${filter === s ? "active" : ""}`}
                onClick={() => setFilter(s)}
              >
                {s} ({counts[s]})
              </button>
            ) : null)}
            {/* Separator */}
            <span style={{ borderLeft: "1px solid var(--border)", margin: "0 4px", alignSelf: "stretch" }} />
            {/* Done sub-statuses */}
            {DONE_STATUSES.map((s) => counts[s] ? (
              <button
                key={s}
                className={`filter-tab ${filter === s ? "active" : ""}`}
                onClick={() => setFilter(s)}
              >
                {s} ({counts[s]})
              </button>
            ) : null)}
          </div>

          {filter === "InScope" && (counts["InScope"] ?? 0) > 0 && (
            <div className="bulk-approve-bar">
              <button className="btn btn-green" onClick={bulkApprove}>
                Bulk Approve All InScope ({counts["InScope"]})
              </button>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, marginTop: 4 }}>
            <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)" }}>
              {filtered.length} video{filtered.length !== 1 ? "s" : ""}
            </span>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>· Sort:</span>
            {(["recorded", "updated"] as const).map((s) => (
              <button
                key={s}
                className={`btn btn-sm ${sortBy === s ? "btn-primary" : ""}`}
                style={{ padding: "1px 8px", fontSize: "0.72rem" }}
                onClick={() => setSortBy(s)}
              >
                {s === "recorded" ? "Date recorded" : "Last change"}
              </button>
            ))}
          </div>

          <div className="video-list">
            {filtered.length === 0 && (
              <div className="empty-state">
                {videos.length === 0
                  ? "No videos indexed yet. Use Zoom Import, Fireflies Import, or Manual Entry above."
                  : `No videos with status "${filter}".`}
              </div>
            )}
            {filtered.map((v) => (
              <VideoCard
                key={v.id}
                video={v}
                onMutated={refresh}
                onEvent={addEvent}
              />
            ))}
          </div>
        </>
      )}

      {view === "provenance" && (
        <div style={{ marginTop: 12 }}>
          <ProvenanceGraph
            videos={videos}
            onJumpTo={(id) => {
              setView("videos");
              setFilter("All");
              // Scroll to card after render
              setTimeout(() => {
                const el = document.getElementById(`video-card-${id}`);
                el?.scrollIntoView({ behavior: "smooth", block: "center" });
              }, 100);
            }}
          />
        </div>
      )}

      {showLogs && <EventLog events={events} forceShow />}
    </div>
    </ErrorBoundary>
  );
}
