"use client";

import { useEffect, useState, useCallback } from "react";
import { bootStore, videoStore } from "../lib/store";
import type { VideoRecordJSON } from "../lib/wasm";
import { loadExclusions } from "../lib/rules";
import { clientLog } from "../lib/logger";
import { useRuleRunner } from "../lib/useRuleRunner";
import IndexForm from "../components/IndexForm";
import ZoomImport from "../components/ZoomImport";
import FirefliesImport from "../components/FirefliesImport";
import ConnectionsPanel from "../components/ConnectionsPanel";
import RulesPanel from "../components/RulesPanel";
import ProcessingRulesPanel from "../components/ProcessingRulesPanel";
import BackfillPanel from "../components/BackfillPanel";
import VideoCard from "../components/VideoCard";
import EventLog from "../components/EventLog";
import ErrorBoundary from "../components/ErrorBoundary";

const ALL_STATUSES = [
  "All",
  "Discovered",
  "InScope",
  "Approved",
  "Publishing",
  "Published",
  "Skipped",
  "Failed",
  "ToRetry",
  "Abandoned",
] as const;

export default function Dashboard() {
  const [ready, setReady] = useState(false);
  const [videos, setVideos] = useState<VideoRecordJSON[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>("All");
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    bootStore().then(() => {
      setReady(true);
      setVideos(videoStore.getAll());
    });
  }, []);

  const refresh = useCallback(() => {
    setVideos(videoStore.getAll());
  }, []);

  const addEvent = useCallback((ev: string) => {
    setEvents((prev) => [...prev, ev]);
    clientLog("info", "event", ev);
  }, []);

  const { isRunning: isRunnerRunning, lastRun, matchCount, runNow } = useRuleRunner({
    onEvent: addEvent,
    onMutated: refresh,
  });

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

  const filtered =
    filter === "All" ? videos : videos.filter((v) => v.status === filter);

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
        <div className="stats">
          <span className="stat-badge">{videos.length} total</span>
          {counts["Discovered"] && (
            <span className="stat-badge">{counts["Discovered"]} to review</span>
          )}
          {counts["Published"] && (
            <span className="stat-badge">{counts["Published"]} published</span>
          )}
          <button
            className={`btn btn-sm ${showLogs ? "btn-primary" : ""}`}
            onClick={() => setShowLogs((v) => !v)}
            style={{ marginLeft: 8 }}
          >
            {showLogs ? "Hide Logs" : "View Logs"}
          </button>
        </div>
      </div>

      <IndexForm onIndexed={refresh} onEvent={addEvent} />

      <ZoomImport onImported={refresh} onEvent={addEvent} />

      <FirefliesImport onImported={refresh} onEvent={addEvent} />

      <ConnectionsPanel />

      <RulesPanel
        isRunnerRunning={isRunnerRunning}
        lastRun={lastRun}
        matchCount={matchCount}
        onRunNow={runNow}
      />

      <ProcessingRulesPanel />

      <BackfillPanel videos={videos} onEvent={addEvent} onMutated={refresh} />

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

      <div className="filter-tabs">
        {ALL_STATUSES.map((s) => (
          <button
            key={s}
            className={`filter-tab ${filter === s ? "active" : ""}`}
            onClick={() => setFilter(s)}
          >
            {s}
            {s !== "All" && counts[s] ? ` (${counts[s]})` : ""}
            {s === "All" ? ` (${videos.length})` : ""}
          </button>
        ))}
      </div>

      {filter === "InScope" && (counts["InScope"] ?? 0) > 0 && (
        <div className="bulk-approve-bar">
          <button className="btn btn-green" onClick={bulkApprove}>
            Bulk Approve All InScope ({counts["InScope"]})
          </button>
        </div>
      )}

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

      {showLogs && <EventLog events={events} forceShow />}
    </div>
    </ErrorBoundary>
  );
}
