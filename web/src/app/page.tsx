"use client";

import { useEffect, useState, useCallback } from "react";
import { bootStore, videoStore } from "../lib/store";
import type { VideoRecordJSON } from "../lib/wasm";
import { loadExclusions, syncRulesFromServer, syncExclusionsFromServer } from "../lib/rules";
import { syncProfilesFromServer, syncQueueFromServer } from "../lib/backfill";
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
import SyncStatusPanel from "../components/SyncStatusPanel";
import VideoCard from "../components/VideoCard";
import ProvenanceGraph from "../components/ProvenanceGraph";
import EventLog from "../components/EventLog";
import ErrorBoundary from "../components/ErrorBoundary";
import ShortsPanel from "../components/ShortsPanel";
import { useCurrentActor, actorCommand } from "../lib/useCurrentActor";

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
  const [search, setSearch] = useState<string>("");
  const [showLogs, setShowLogs] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [view, setView] = useState<"videos" | "provenance">("videos");
  const [sortBy, setSortBy] = useState<"recorded" | "updated">("recorded");

  // ADR-036: derived actor for command authorization. Available for the
  // Dashboard's own bulk operations (e.g. bulkApprove); per-card mutations
  // re-call the hook in their own components.
  const actorState = useCurrentActor();
  const cmd = (extra?: Record<string, unknown>) => actorCommand(actorState, extra);

  useEffect(() => {
    const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
    const sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "local";
    const date = process.env.NEXT_PUBLIC_BUILD_DATE ?? new Date().toISOString();
    clientLog("info", "app:boot", `Video Sync v${version} (${sha}) built ${date}`);

    // Sync server-shared state before booting UI (ADR-031, ADR-043)
    Promise.all([
      syncRulesFromServer(),
      syncProcessingRulesFromServer(),
      syncPostProcessingRulesFromServer(),
      syncProfilesFromServer(),
      syncQueueFromServer(),
      syncExclusionsFromServer(),
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

  /**
   * Called after any source import succeeds. Triggers a background YouTube
   * uploads fetch so the cache is populated for auto-association suggestions.
   * Fire-and-forget: errors are swallowed (YouTube might not be configured yet).
   */
  const refreshWithYouTube = useCallback(() => {
    refresh();
    // Skip if no YouTube creds yet (saves a useless API call)
    try {
      const raw = localStorage.getItem("video-sync:connections");
      const conn = raw ? JSON.parse(raw) : {};
      const ytCreds = conn["YouTube"]?.credentials;
      if (!ytCreds?.refreshToken) return;
    } catch { return; }
    import("../lib/youtubeUploadsCache").then(({ fetchChannelUploads }) => {
      fetchChannelUploads(false).then(data => {
        clientLog("info", "yt:uploads-sync", `Fetched ${data.uploads.length} YouTube uploads`, { count: data.uploads.length });
      }).catch(() => { /* swallow — user can still use manual Recover */ });
    });
  }, [refresh]);

  const addEvent = useCallback((ev: string, fields?: { video_id?: string }) => {
    setEvents((prev) => [...prev, ev]);
    clientLog("info", "event", ev, fields);
  }, []);

  // ADR-041: poll the server's audit buffer and surface entries into the
  // EventLog so the operator sees who-did-what across the app, not only
  // the actions their own browser triggered. Polls every 8 seconds.
  useEffect(() => {
    let lastSince = new Date().toISOString();
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/audit/recent?since=${encodeURIComponent(lastSince)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as { events?: Array<{ id: string; ts: string; actor_email: string | null; actor_error: string | null; audit: string; method: string; path: string; status: number; duration_ms: number }> };
        for (const e of data.events ?? []) {
          // Skip noisy GET 200s; surface mutations, errors, and auth failures
          const isMutation = e.audit === "mutation";
          const isError = e.status >= 400;
          const isUnauth = !!e.actor_error;
          if (!isMutation && !isError && !isUnauth) continue;
          const who = e.actor_email ?? (e.actor_error ? `unauth (${e.actor_error.slice(0, 60)})` : "anon");
          const verb = isMutation ? "[mutation]" : isError ? "[error]" : "[access]";
          setEvents(prev => [...prev, `${verb} ${e.method} ${e.path} ${e.status} (${e.duration_ms}ms) by ${who}`]);
          if (e.ts > lastSince) lastSince = e.ts;
        }
      } catch { /* offline or transient — skip */ }
    };
    const id = setInterval(tick, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  /**
   * Ensure a video card is visible, switching filter if necessary, then scroll.
   * Called from Overview/Calendar clicks and from Publish transitions.
   */
  const ensureVideoVisible = useCallback((videoId: string, intent?: "publish") => {
    // Look up status from the freshest WASM store rather than stale state closure
    const all = videoStore.getAll();
    const status = all.find(v => v.id === videoId)?.status;
    setFilter(prev => {
      if (intent === "publish") return "Active";
      if (!status) return prev;
      const active = (ACTIVE_STATUSES as readonly string[]).includes(status);
      const done = (DONE_STATUSES as readonly string[]).includes(status);
      if (prev === "All") return prev;
      if (prev === "Active" && active) return prev;
      if (prev === "Done" && done) return prev;
      if (prev === status) return prev;
      return "All";
    });
    // Defer scroll until after filter change has rendered
    setTimeout(() => {
      const el = document.getElementById(`video-card-${videoId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.style.outline = "2px solid var(--primary, #6366f1)";
        setTimeout(() => { el.style.outline = ""; }, 2000);
      }
    }, 50);
  }, []);

  const { isRunning: isRunnerRunning, lastRun, matchCount, runNow } = useRuleRunner({
    onEvent: addEvent,
    onMutated: refresh,
  });

  useMemoryHealth();

  function bulkApprove() {
    const inScope = videos.filter((v) => v.status === "InScope");
    const payload = cmd();
    for (const v of inScope) {
      videoStore.mutate(v.id, (r) => r.approve(payload));
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

  const filtered = (() => {
    const base =
      filter === "All" ? videos
      : filter === "Active" ? videos.filter((v) => (ACTIVE_STATUSES as readonly string[]).includes(v.status))
      : filter === "Done" ? videos.filter((v) => (DONE_STATUSES as readonly string[]).includes(v.status))
      : videos.filter((v) => v.status === filter);

    // Search across title, source_platform, source_id, recorded_at,
    // catalog id, and tags. Multiple whitespace-separated terms are
    // ANDed (every term must appear somewhere in the haystack).
    const q = search.trim().toLowerCase();
    const filteredBySearch = q === "" ? base : base.filter((v) => {
      const haystack = [
        v.title,
        v.source_platform,
        v.source_id,
        v.recorded_at ?? "",
        v.indexed_at ?? "",
        v.id,
        ...(v.tags ?? []),
        ...(v.participants ?? []),
      ].join(" ").toLowerCase();
      return q.split(/\s+/).every(term => haystack.includes(term));
    });

    return filteredBySearch.slice().sort((a, b) =>
      sortBy === "recorded"
        ? new Date(b.recorded_at || b.indexed_at).getTime() - new Date(a.recorded_at || a.indexed_at).getTime()
        : lastChange(b) - lastChange(a),
    );
  })();

  const counts: Record<string, number> = {};
  for (const v of videos) {
    counts[v.status] = (counts[v.status] || 0) + 1;
  }
  const exclusionCount = loadExclusions().length;

  return (
    <ErrorBoundary>
    <div className="container">
      {/* ADR-036: surface auth errors instead of silently falling back to admin */}
      {actorState.error && (
        <div style={{
          padding: "10px 14px",
          background: "rgba(248,113,113,0.1)",
          border: "1px solid rgba(248,113,113,0.3)",
          borderRadius: 6,
          color: "#f87171",
          fontSize: "0.85rem",
          marginBottom: 12,
        }}>
          <strong>Not authenticated:</strong> {actorState.error}.{" "}
          Mutating actions (approve, publish, etc.) will fail. Contact your Workspace admin to be added to a video-sync group.
        </div>
      )}
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
          {/* Feedback: link straight to a new GitHub issue. Pre-fills the
              title with the build SHA so engineering can correlate the
              report against deployed revision and recent commits. */}
          <a
            className="btn btn-sm"
            href={`https://github.com/mrjcleaver/video-sync/issues/new?template=feedback.yml&title=${encodeURIComponent(`[feedback] ${process.env.NEXT_PUBLIC_BUILD_SHA ?? "unknown"}: `)}&build=${encodeURIComponent(process.env.NEXT_PUBLIC_BUILD_SHA ?? "unknown")}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open a GitHub issue using the feedback template"
          >
            Feedback
          </a>
          <a
            className="btn btn-sm"
            href="https://github.com/mrjcleaver/video-sync/wiki"
            target="_blank"
            rel="noopener noreferrer"
            title="Open the project wiki in a new tab"
          >
            Help
          </a>
        </div>
      </div>

      <ConnectionsPanel open={showConnections} onToggle={() => setShowConnections((v) => !v)} />

      <ImportPanel onImported={refreshWithYouTube} onEvent={addEvent} />

      <SyncStatusPanel videos={videos} onNavigateToVideo={ensureVideoVisible} />

      <BackfillPanel videos={videos} onEvent={addEvent} onMutated={refresh} onNavigateToVideo={ensureVideoVisible} />

      <RulesPanel
        isRunnerRunning={isRunnerRunning}
        lastRun={lastRun}
        matchCount={matchCount}
        onRunNow={runNow}
      />

      <ProcessingRulesPanel />

      <PostProcessingRulesPanel />

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

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, marginTop: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)" }}>
              {filtered.length}{search.trim() ? ` of ${videos.length}` : ""} video{filtered.length !== 1 ? "s" : ""}
            </span>
            <input
              type="search"
              placeholder="Search title, source, date, tags, participants…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                padding: "4px 8px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text)",
                fontSize: "0.8rem",
                flex: "1 1 220px",
                minWidth: 200,
              }}
              title="Multiple words AND together — all terms must appear somewhere in the record's title, source, date, id, tags, or participants."
            />
            {search.trim() && (
              <button
                className="btn btn-sm"
                style={{ padding: "1px 8px", fontSize: "0.72rem" }}
                onClick={() => setSearch("")}
                title="Clear the search filter"
              >
                Clear
              </button>
            )}
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
                  ? "No videos indexed yet. Use the Meetings, URL, or Manual import tabs above."
                  : search.trim()
                    ? `No videos match "${search}" within "${filter}". Clear search or pick a wider filter.`
                    : `No videos with status "${filter}".`}
              </div>
            )}
            {filtered.map((v) => (
              <VideoCard
                key={v.id}
                video={v}
                allVideos={videos}
                onMutated={refresh}
                onEvent={addEvent}
                onNavigateToVideo={ensureVideoVisible}
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
