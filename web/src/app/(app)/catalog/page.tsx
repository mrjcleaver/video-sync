"use client";

/**
 * ADR-057 Option A — Catalog page.
 *
 * The daily-driver activity: review + curate the video list.
 * Pulled out of the old monolithic page.tsx.
 */

import VideoCard from "../../../components/VideoCard";
import { useApp } from "../AppContext";
import type { VideoRecordJSON } from "../../../lib/wasm";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const ACTIVE_STATUSES = ["Discovered", "InScope", "Approved", "Publishing", "Failed", "ToRetry"] as const;
// ADR-062 follow-up (dedupe audit 2026-08-01): moved Abandoned out
// of DONE_STATUSES so soft-deleted records don't clutter the
// "Done" view. They stay reachable via the explicit "Abandoned"
// status filter or "All".
const DONE_STATUSES = ["Published", "Skipped"] as const;
const ALL_STATUSES = ["Active", "All", ...ACTIVE_STATUSES, "Done", ...DONE_STATUSES] as const;

function lastChange(v: VideoRecordJSON): number {
  return Math.max(
    new Date(v.published_at || 0).getTime(),
    new Date(v.curated_at || 0).getTime(),
    new Date(v.indexed_at).getTime(),
  );
}

export default function CatalogPage() {
  // useSearchParams needs a Suspense boundary in Next 15. Client-
  // only page but the framework still enforces it during prerender.
  return (
    <Suspense fallback={null}>
      <CatalogPageInner />
    </Suspense>
  );
}

function CatalogPageInner() {
  const {
    videos, broadcastPairs, showPaired, setShowPaired,
    filter, setFilter, search, setSearch, sortBy, setSortBy,
    sortDir, setSortDir,
    refresh, addEvent, ensureVideoVisible, bulkApprove, exclusionCount,
  } = useApp();
  const router = useRouter();

  // ?just=id1,id2 — set after an import (or a ⛶ focus click) so
  // the operator sees just those cards. useSearchParams triggers
  // a re-render on URL change, so a focus click that pushes a new
  // ?just= updates the filter in place.
  const searchParams = useSearchParams();
  const justIds = useMemo(() => {
    const raw = searchParams.get("just");
    return raw ? new Set(raw.split(",").filter(Boolean)) : new Set<string>();
  }, [searchParams]);

  // OpusClip records are rendered nested under their parent
  // VideoCard's collapsible '✂️ N clips' section — never as
  // standalone rows in the main list (a single video can have
  // 20+ clips and they'd flood the catalog).
  const catalogPool = videos.filter(v => v.source_platform !== "OpusClip");
  const catalogPoolPostPairing = showPaired
    ? catalogPool
    : catalogPool.filter(v => !broadcastPairs.destinationRecordIds.has(v.id));
  const visibleVideos = justIds.size > 0
    ? catalogPoolPostPairing.filter(v => justIds.has(v.id))
    : catalogPoolPostPairing;

  function clearJustFilter() {
    // Drop the ?just= param from the URL without a full nav — the
    // useSearchParams-driven useMemo above will re-derive an empty
    // set on the URL change.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("just");
      router.replace(url.pathname + (url.search ? url.search : ""));
    }
  }

  const filtered = (() => {
    // When ?just= is active the operator wants THOSE records regardless
    // of what status they carry — Abandoned, Skipped, whatever. Layering
    // the status filter on top of an explicit id list hides the very
    // record the operator clicked "focus" on. Skip the status filter
    // entirely under ?just=.
    const base =
      justIds.size > 0 ? visibleVideos
      : filter === "All" ? visibleVideos
      : filter === "Active" ? visibleVideos.filter((v) => (ACTIVE_STATUSES as readonly string[]).includes(v.status))
      : filter === "Done" ? visibleVideos.filter((v) => (DONE_STATUSES as readonly string[]).includes(v.status))
      : visibleVideos.filter((v) => v.status === filter);

    const q = search.trim().toLowerCase();
    const filteredBySearch = q === "" ? base : base.filter((v) => {
      const haystack = [
        v.title, v.source_platform, v.source_id,
        v.recorded_at ?? "", v.indexed_at ?? "", v.id,
        ...(v.tags ?? []),
        ...(v.participants ?? []),
      ].join(" ").toLowerCase();
      return q.split(/\s+/).every(term => haystack.includes(term));
    });

    const dir = sortDir === "asc" ? -1 : 1;
    return filteredBySearch.slice().sort((a, b) =>
      sortBy === "recorded"
        ? dir * (new Date(b.recorded_at || b.indexed_at).getTime() - new Date(a.recorded_at || a.indexed_at).getTime())
        : dir * (lastChange(b) - lastChange(a)),
    );
  })();

  // Counts drive the filter pill labels ("Active (12)", "Discovered (3)"). Compute
  // over the SAME pool the catalog actually renders — the raw `videos` list
  // includes OpusClip clips and broadcast-pair destinations that are hidden by
  // default, so counting over it produced misleadingly large numbers ("Active 187"
  // then only 2 cards render). Uses `catalogPoolPostPairing`, which honours both
  // the OpusClip exclusion and the showPaired toggle.
  const counts: Record<string, number> = {};
  for (const v of catalogPoolPostPairing) counts[v.status] = (counts[v.status] || 0) + 1;

  return (
    <>
      <div className="header">
        <h1>Catalog</h1>
        <div className="stats">
          <span className="stat-badge">{videos.length} total</span>
          {counts["Discovered"] && <span className="stat-badge">{counts["Discovered"]} to review</span>}
          {counts["Published"] && <span className="stat-badge">{counts["Published"]} published</span>}
        </div>
      </div>

      {justIds.size > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            background: "rgba(99,102,241,0.10)",
            border: "1px solid rgba(99,102,241,0.35)",
            borderRadius: 6,
            fontSize: "0.82rem",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span>
            🔍 Focused on <strong>{visibleVideos.length}</strong> record{visibleVideos.length === 1 ? "" : "s"} (filtered by <code>?just=</code>).
          </span>
          <button
            className="btn btn-sm"
            onClick={clearJustFilter}
            title="Drop the just= filter and show the full catalog"
          >
            Show all
          </button>
        </div>
      )}

      <div className="burndown-stats">
        <span>Total: {videos.length}</span>
        {exclusionCount > 0 && <span>Excluded: {exclusionCount}</span>}
        {Object.entries(counts)
          .sort(([a], [b]) => ALL_STATUSES.indexOf(a as typeof ALL_STATUSES[number]) - ALL_STATUSES.indexOf(b as typeof ALL_STATUSES[number]))
          .map(([status, count]) => (
            <span key={status}>{status}: {count}</span>
          ))}
      </div>

      <div className="filter-tabs">
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
        <span style={{ borderLeft: "1px solid var(--border)", margin: "0 4px", alignSelf: "stretch" }} />
        {ACTIVE_STATUSES.map((s) => counts[s] ? (
          <button
            key={s}
            className={`filter-tab ${filter === s ? "active" : ""}`}
            onClick={() => setFilter(s)}
          >
            {s} ({counts[s]})
          </button>
        ) : null)}
        <span style={{ borderLeft: "1px solid var(--border)", margin: "0 4px", alignSelf: "stretch" }} />
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
            padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 6, color: "var(--text)", fontSize: "0.8rem", flex: "1 1 220px", minWidth: 200,
          }}
          title="Multiple words AND together — all terms must appear somewhere."
        />
        {search.trim() && (
          <button
            className="btn btn-sm"
            style={{ padding: "1px 8px", fontSize: "0.72rem" }}
            onClick={() => setSearch("")}
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
        <button
          className="btn btn-sm"
          style={{ padding: "1px 8px", fontSize: "0.72rem" }}
          onClick={() => setSortDir(sortDir === "desc" ? "asc" : "desc")}
          title={sortDir === "desc" ? "Currently newest first — click for oldest first" : "Currently oldest first — click for newest first"}
        >
          {sortDir === "desc" ? "↓ newest first" : "↑ oldest first"}
        </button>
        {broadcastPairs.destinationRecordIds.size > 0 && (
          <button
            className={`btn btn-sm ${showPaired ? "btn-primary" : ""}`}
            style={{ padding: "1px 8px", fontSize: "0.72rem", marginLeft: 8 }}
            onClick={() => setShowPaired(!showPaired)}
            title={`Toggle visibility of ${broadcastPairs.destinationRecordIds.size} broadcast-destination record(s) collapsed under their upstream canonical (ADR-049)`}
          >
            {showPaired
              ? `📺 Hide ${broadcastPairs.destinationRecordIds.size} paired`
              : `📺 Show ${broadcastPairs.destinationRecordIds.size} paired`}
          </button>
        )}
      </div>

      <div className="video-list">
        {filtered.length === 0 && (
          <div className="empty-state">
            {videos.length === 0
              ? "No videos indexed yet. Use the Import page (sidebar) to bring content in."
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
  );
}
