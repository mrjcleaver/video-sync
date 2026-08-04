"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
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
import SummaryPromptPanel from "../components/SummaryPromptPanel";
import CatchUpPanel from "../components/CatchUpPanel";
import RulesPanel from "../components/RulesPanel";
import ProcessingRulesPanel from "../components/ProcessingRulesPanel";
import PostProcessingRulesPanel from "../components/PostProcessingRulesPanel";
import BackfillPanel from "../components/BackfillPanel";
import SyncStatusPanel from "../components/SyncStatusPanel";
import VideoCard from "../components/VideoCard";
import { buildBroadcastPairs } from "../lib/broadcastPairs";
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
  const [showSummaryPrompt, setShowSummaryPrompt] = useState(false);
  const [showCatchUp, setShowCatchUp] = useState(false);
  // ADR-049 slice 3: broadcast destinations (e.g. YouTube-Live records
  // paired BroadcastedFrom with a Zoom record) hide by default and the
  // canonical (upstream) record carries a "📺 Broadcast to …" badge.
  // Show paired toggle reveals the collapsed entries for debugging.
  const [showPaired, setShowPaired] = useState(false);
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

  // Subscribe to store mutations so background updates (e.g. Kaltura
  // caption auto-fetch, fire-and-forget transcript hydration) reflect
  // in the UI without depending on every caller threading an
  // onMutated() callback all the way up.
  useEffect(() => {
    const unsubscribe = videoStore.subscribe(() => {
      setVideos(videoStore.getAll());
    });
    return () => { unsubscribe(); };
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

  // ADR-049 slice 3: index every BroadcastedFrom upstream link in the
  // catalog so consumers (Overview, VideoCard) can collapse paired
  // records into one canonical row + a "📺 broadcast" badge.
  // NOTE: these useMemo calls MUST sit above the `if (!ready) return`
  // early-exit below — React's hook-count invariant requires the same
  // number of hooks per render, and the loading branch can't have
  // fewer hooks than the loaded branch.
  const broadcastPairs = useMemo(() => buildBroadcastPairs(videos), [videos]);

  // Videos visible in the dashboard — hides broadcast destinations
  // unless "Show paired records" is toggled on. The canonical
  // (upstream) record stays visible and carries the badge.
  const visibleVideos = useMemo(() =>
    showPaired ? videos : videos.filter(v => !broadcastPairs.destinationRecordIds.has(v.id)),
  [videos, broadcastPairs, showPaired]);

  if (!ready) {
    return <main className="loading" role="status" aria-live="polite">Loading video catalog...</main>;
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
      filter === "All" ? visibleVideos
      : filter === "Active" ? visibleVideos.filter((v) => (ACTIVE_STATUSES as readonly string[]).includes(v.status))
      : filter === "Done" ? visibleVideos.filter((v) => (DONE_STATUSES as readonly string[]).includes(v.status))
      : visibleVideos.filter((v) => v.status === filter);

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
    <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <main id="main-content" className="container" tabIndex={-1}>
      {/* ADR-036: surface auth errors instead of silently falling back to admin */}
      {actorState.error && (
        <div role="alert" style={{
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
      <header className="header">
        <h1>Video Sync</h1>
        <BuildBadge />
        <nav className="stats" aria-label="Dashboard utilities">
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
            aria-expanded={showConnections}
            aria-controls="connections-panel"
          >
            {showConnections ? "Hide Connections" : "Connections"}
          </button>
          <button
            className={`btn btn-sm ${showLogs ? "btn-primary" : ""}`}
            onClick={() => setShowLogs((v) => !v)}
            aria-expanded={showLogs}
            aria-controls="event-log"
          >
            {showLogs ? "Hide Logs" : "View Logs"}
          </button>
          <button
            className={`btn btn-sm ${showSummaryPrompt ? "btn-primary" : ""}`}
            onClick={() => setShowSummaryPrompt(v => !v)}
            title="Edit the org-shared summary prompt and bulk-regenerate unlocked summaries (ADR-046)"
            aria-expanded={showSummaryPrompt}
            aria-controls="summary-prompt-panel"
          >
            Summary prompt
          </button>
          <button
            className={`btn btn-sm ${showCatchUp ? "btn-primary" : ""}`}
            onClick={() => setShowCatchUp(v => !v)}
            title="Walk recent records and run captions / sibling-link / summary stages automatically (ADR-047)"
            aria-expanded={showCatchUp}
            aria-controls="catch-up-panel"
          >
            Catch up
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
            Feedback<span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          <a
            className="btn btn-sm"
            href="https://github.com/mrjcleaver/video-sync/wiki"
            target="_blank"
            rel="noopener noreferrer"
            title="Open the project wiki in a new tab"
          >
            Help<span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </nav>
      </header>

      <ConnectionsPanel open={showConnections} onToggle={() => setShowConnections((v) => !v)} />

      <SummaryPromptPanel
        open={showSummaryPrompt}
        videos={videos}
        onEvent={addEvent}
        onClose={() => setShowSummaryPrompt(false)}
      />

      <CatchUpPanel
        open={showCatchUp}
        videos={videos}
        onEvent={addEvent}
        onClose={() => setShowCatchUp(false)}
      />

      <ImportPanel onImported={refreshWithYouTube} onEvent={addEvent} />

      <SyncStatusPanel videos={visibleVideos} onNavigateToVideo={ensureVideoVisible} />

      <BackfillPanel videos={visibleVideos} onEvent={addEvent} onMutated={refresh} onNavigateToVideo={ensureVideoVisible} />

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
      <section className="burndown-stats" aria-label="Catalog summary">
        <span>Total: {videos.length}</span>
        {exclusionCount > 0 && <span>Excluded: {exclusionCount}</span>}
        {Object.entries(counts)
          .sort(([a], [b]) => ALL_STATUSES.indexOf(a as typeof ALL_STATUSES[number]) - ALL_STATUSES.indexOf(b as typeof ALL_STATUSES[number]))
          .map(([status, count]) => (
            <span key={status}>
              {status}: {count}
            </span>
          ))}
      </section>

      {/* View switcher */}
      <div className="filter-tabs" style={{ marginBottom: 0 }} role="group" aria-label="Catalog view">
        <button
          className={`filter-tab ${view === "videos" ? "active" : ""}`}
          onClick={() => setView("videos")}
          aria-pressed={view === "videos"}
        >
          Videos ({videos.length})
        </button>
        <button
          className={`filter-tab ${view === "provenance" ? "active" : ""}`}
          onClick={() => setView("provenance")}
          aria-pressed={view === "provenance"}
        >
          Provenance
        </button>
      </div>

      {view === "videos" && (
        <>
          <div className="filter-tabs" role="group" aria-label="Filter videos by status">
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
                  aria-pressed={filter === s}
                >
                  {s} ({count})
                </button>
              );
            })}
            {/* Separator */}
            <span aria-hidden="true" style={{ borderLeft: "1px solid var(--border)", margin: "0 4px", alignSelf: "stretch" }} />
            {/* Active sub-statuses */}
            {ACTIVE_STATUSES.map((s) => counts[s] ? (
              <button
                key={s}
                className={`filter-tab ${filter === s ? "active" : ""}`}
                onClick={() => setFilter(s)}
                aria-pressed={filter === s}
              >
                {s} ({counts[s]})
              </button>
            ) : null)}
            {/* Separator */}
            <span aria-hidden="true" style={{ borderLeft: "1px solid var(--border)", margin: "0 4px", alignSelf: "stretch" }} />
            {/* Done sub-statuses */}
            {DONE_STATUSES.map((s) => counts[s] ? (
              <button
                key={s}
                className={`filter-tab ${filter === s ? "active" : ""}`}
                onClick={() => setFilter(s)}
                aria-pressed={filter === s}
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
            <span aria-live="polite" style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)" }}>
              {filtered.length}{search.trim() ? ` of ${videos.length}` : ""} video{filtered.length !== 1 ? "s" : ""}
            </span>
            <label className="visually-hidden" htmlFor="catalog-search">Search videos</label>
            <input
              id="catalog-search"
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
              title="Multiple words use AND matching. Every term must appear somewhere in the record."
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
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Sort:</span>
            {(["recorded", "updated"] as const).map((s) => (
              <button
                key={s}
                className={`btn btn-sm ${sortBy === s ? "btn-primary" : ""}`}
                style={{ padding: "1px 8px", fontSize: "0.72rem" }}
                onClick={() => setSortBy(s)}
                aria-pressed={sortBy === s}
              >
                {s === "recorded" ? "Date recorded" : "Last change"}
              </button>
            ))}
            {broadcastPairs.destinationRecordIds.size > 0 && (
              <button
                className={`btn btn-sm ${showPaired ? "btn-primary" : ""}`}
                style={{ padding: "1px 8px", fontSize: "0.72rem", marginLeft: 8 }}
                onClick={() => setShowPaired(v => !v)}
                aria-pressed={showPaired}
                title={`Toggle visibility of ${broadcastPairs.destinationRecordIds.size} broadcast-destination record(s) collapsed under their upstream canonical (ADR-049)`}
              >
                {showPaired
                  ? `Hide ${broadcastPairs.destinationRecordIds.size} paired`
                  : `Show ${broadcastPairs.destinationRecordIds.size} paired`}
              </button>
            )}
          </div>

          <div className="video-list">
            {filtered.length === 0 && (
              <div className="empty-state" role="status">
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
                broadcastPairs={broadcastPairs}
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
    </main>
    </>
    </ErrorBoundary>
  );
}
