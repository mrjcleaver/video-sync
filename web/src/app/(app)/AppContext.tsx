"use client";

/**
 * ADR-057 Option A — shared app state moved out of the old
 * single-page Dashboard component so multiple routes under `(app)/`
 * can each render just their slice of the UI.
 *
 * Owns:
 *   - videos (from WASM store), reactive to store mutations
 *   - EventLog buffer + addEvent
 *   - broadcastPairs derived index (ADR-049 slice 3)
 *   - showPaired toggle
 *   - actor state (ADR-036)
 *   - RuleRunner (ADR-013) — one instance for the whole app, not per route
 *   - Boot lifecycle: server-shared state sync + WASM store boot +
 *     videoStore.subscribe + ADR-041 audit-log polling
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { bootStore, videoStore } from "../../lib/store";
import type { VideoRecordJSON } from "../../lib/wasm";
import { loadExclusions, syncRulesFromServer, syncExclusionsFromServer } from "../../lib/rules";
import { syncProfilesFromServer, syncQueueFromServer } from "../../lib/backfill";
import { syncProcessingRulesFromServer, syncPostProcessingRulesFromServer } from "../../lib/processingRules";
import { clientLog } from "../../lib/logger";
import { useRuleRunner } from "../../lib/useRuleRunner";
import { useMemoryHealth } from "../../lib/useMemoryHealth";
import { buildBroadcastPairs, type BroadcastPairsIndex } from "../../lib/broadcastPairs";
import { useCurrentActor, actorCommand } from "../../lib/useCurrentActor";

type ActorState = ReturnType<typeof useCurrentActor>;

interface AppContextValue {
  ready: boolean;
  videos: VideoRecordJSON[];
  events: string[];
  broadcastPairs: BroadcastPairsIndex;
  actorState: ActorState;
  showPaired: boolean;
  setShowPaired: (v: boolean) => void;
  refresh: () => void;
  refreshWithYouTube: () => void;
  addEvent: (event: string, fields?: { video_id?: string }) => void;
  ensureVideoVisible: (videoId: string, intent?: "publish") => void;
  bulkApprove: () => void;
  exclusionCount: number;
  // Rule runner
  ruleRunner: {
    isRunning: boolean;
    lastRun: number | null;
    matchCount: number;
    runNow: () => void;
  };
  // Filter state — lives here because /catalog needs to persist it
  // across in-app navigation (e.g. jump to /provenance and back
  // without losing the current filter).
  filter: string;
  setFilter: (v: string) => void;
  search: string;
  setSearch: (v: string) => void;
  sortBy: "recorded" | "updated";
  setSortBy: (v: "recorded" | "updated") => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside an AppContext.Provider (layout /(app)/layout.tsx)");
  return ctx;
}

/** Provider — mounts inside (app)/layout so every route beneath sees the same state. */
export function AppProvider({ children }: { children: React.ReactNode }) {
  const actorState = useCurrentActor();
  const [ready, setReady] = useState(false);
  const [videos, setVideos] = useState<VideoRecordJSON[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>("Active");
  const [search, setSearch] = useState<string>("");
  const [sortBy, setSortBy] = useState<"recorded" | "updated">("recorded");
  const [showPaired, setShowPaired] = useState(false);

  // Boot sequence — runs once at layout mount. All routes benefit.
  useEffect(() => {
    const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
    const sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "local";
    const date = process.env.NEXT_PUBLIC_BUILD_DATE ?? new Date().toISOString();
    clientLog("info", "app:boot", `Video Sync v${version} (${sha}) built ${date}`);

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

  // Subscribe to store mutations globally.
  useEffect(() => {
    const unsubscribe = videoStore.subscribe(() => setVideos(videoStore.getAll()));
    return () => { unsubscribe(); };
  }, []);

  const refreshWithYouTube = useCallback(() => {
    refresh();
    try {
      const raw = localStorage.getItem("video-sync:connections");
      const conn = raw ? JSON.parse(raw) : {};
      const ytCreds = conn["YouTube"]?.credentials;
      if (!ytCreds?.refreshToken) return;
    } catch { return; }
    import("../../lib/youtubeUploadsCache").then(({ fetchChannelUploads }) => {
      fetchChannelUploads(false).then(data => {
        clientLog("info", "yt:uploads-sync", `Fetched ${data.uploads.length} YouTube uploads`, { count: data.uploads.length });
      }).catch(() => { /* swallow */ });
    });
  }, [refresh]);

  const addEvent = useCallback((ev: string, fields?: { video_id?: string }) => {
    setEvents((prev) => [...prev, ev]);
    clientLog("info", "event", ev, fields);
  }, []);

  // ADR-041 audit-log polling — global to the app.
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
          const isMutation = e.audit === "mutation";
          const isError = e.status >= 400;
          const isUnauth = !!e.actor_error;
          if (!isMutation && !isError && !isUnauth) continue;
          const who = e.actor_email ?? (e.actor_error ? `unauth (${e.actor_error.slice(0, 60)})` : "anon");
          const verb = isMutation ? "[mutation]" : isError ? "[error]" : "[access]";
          setEvents(prev => [...prev, `${verb} ${e.method} ${e.path} ${e.status} (${e.duration_ms}ms) by ${who}`]);
          if (e.ts > lastSince) lastSince = e.ts;
        }
      } catch { /* offline */ }
    };
    const id = setInterval(tick, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Cross-page navigation used by SyncStatusPanel + card publish flow.
  const ensureVideoVisible = useCallback((videoId: string, intent?: "publish") => {
    const all = videoStore.getAll();
    const status = all.find(v => v.id === videoId)?.status;
    setFilter(prev => {
      if (intent === "publish") return "Active";
      if (!status) return prev;
      // Simple heuristic — keep the current filter if the record is still
      // matched. If not, expand to All so it becomes visible.
      if (prev === "All" || prev === status) return prev;
      return "All";
    });
    // Defer scroll — the target card might be on /catalog and we're on
    // another route right now. router.push('/catalog') would be nicer
    // but we don't want a full navigation just for this. If already on
    // /catalog the scroll works; otherwise operator sees the filter
    // updated when they navigate back.
    setTimeout(() => {
      const el = document.getElementById(`video-card-${videoId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.style.outline = "2px solid var(--primary, #6366f1)";
        setTimeout(() => { el.style.outline = ""; }, 2000);
      }
    }, 50);
  }, []);

  const { isRunning, lastRun, matchCount, runNow } = useRuleRunner({
    onEvent: addEvent,
    onMutated: refresh,
  });
  useMemoryHealth();

  const bulkApprove = useCallback(() => {
    const inScope = videos.filter((v) => v.status === "InScope");
    const payload = actorCommand(actorState);
    for (const v of inScope) videoStore.mutate(v.id, (r) => r.approve(payload));
    addEvent(`Bulk approved ${inScope.length} InScope videos`);
    refresh();
  }, [videos, actorState, addEvent, refresh]);

  const broadcastPairs = useMemo(() => buildBroadcastPairs(videos), [videos]);
  const exclusionCount = useMemo(() => loadExclusions().length, [videos]);

  const value: AppContextValue = {
    ready,
    videos,
    events,
    broadcastPairs,
    actorState,
    showPaired,
    setShowPaired,
    refresh,
    refreshWithYouTube,
    addEvent,
    ensureVideoVisible,
    bulkApprove,
    exclusionCount,
    ruleRunner: { isRunning, lastRun, matchCount, runNow },
    filter,
    setFilter,
    search,
    setSearch,
    sortBy,
    setSortBy,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
