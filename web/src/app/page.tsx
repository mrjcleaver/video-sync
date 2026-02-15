"use client";

import { useEffect, useState, useCallback } from "react";
import { bootStore, videoStore } from "../lib/store";
import type { VideoRecordJSON } from "../lib/wasm";
import IndexForm from "../components/IndexForm";
import VideoCard from "../components/VideoCard";
import EventLog from "../components/EventLog";

const ALL_STATUSES = [
  "All",
  "Discovered",
  "Approved",
  "Publishing",
  "Published",
  "Skipped",
  "Failed",
] as const;

export default function Dashboard() {
  const [ready, setReady] = useState(false);
  const [videos, setVideos] = useState<VideoRecordJSON[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>("All");

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
  }, []);

  if (!ready) {
    return <div className="loading">Loading WASM module...</div>;
  }

  const filtered =
    filter === "All" ? videos : videos.filter((v) => v.status === filter);

  const counts: Record<string, number> = {};
  for (const v of videos) {
    counts[v.status] = (counts[v.status] || 0) + 1;
  }

  return (
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
        </div>
      </div>

      <IndexForm onIndexed={refresh} onEvent={addEvent} />

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

      <div className="video-list">
        {filtered.length === 0 && (
          <div className="empty-state">
            {videos.length === 0
              ? "No videos indexed yet. Click \"Load Samples\" or add one manually."
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

      <EventLog events={events} />
    </div>
  );
}
