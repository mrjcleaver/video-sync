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
import { usePathname, useRouter } from "next/navigation";
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
import { loadQueue, readyQueue } from "../../lib/backfill";
import { getCurrentPromptVersion } from "../../lib/summaryPromptClient";
import { getSeriesRegistry } from "../../lib/seriesRegistryClient";
import type { SeriesRegistryEntry } from "../../lib/youtubeTitleAlign";

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
  /** Async-hydrated bits the sidebar needs to compute count badges
   *  (Maintain aggregate work, Import backfill queue). Values are
   *  cached once at layout mount so the sidebar's badge renders
   *  cheaply on every route change. Null before hydration. */
  currentPromptVersion: number | null;
  seriesRegistry: SeriesRegistryEntry[];
  backfillQueueSize: number;
  backfillReadySize: number;
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
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [videos, setVideos] = useState<VideoRecordJSON[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>("Active");
  const [search, setSearch] = useState<string>("");
  const [sortBy, setSortBy] = useState<"recorded" | "updated">("recorded");
  const [showPaired, setShowPaired] = useState(false);
  const [currentPromptVersion, setCurrentPromptVersion] = useState<number | null>(null);
  const [seriesRegistry, setSeriesRegistry] = useState<SeriesRegistryEntry[]>([]);
  const [backfillQueueSize, setBackfillQueueSize] = useState(0);
  const [backfillReadySize, setBackfillReadySize] = useState(0);

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

  // Sidebar-badge inputs — fetched once at layout mount, cached.
  useEffect(() => {
    let cancelled = false;
    getCurrentPromptVersion().then(v => { if (!cancelled) setCurrentPromptVersion(v); });
    getSeriesRegistry().then(r => { if (!cancelled) setSeriesRegistry(r); });
    return () => { cancelled = true; };
  }, []);

  // Backfill queue size — recomputed whenever videos change (queue
  // mutations trigger a videoStore refresh via the mutate hook).
  useEffect(() => {
    try {
      const q = loadQueue();
      setBackfillQueueSize(q.length);
      setBackfillReadySize(readyQueue(q).length);
    } catch {
      setBackfillQueueSize(0);
      setBackfillReadySize(0);
    }
  }, [videos]);

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

  // Cross-page navigation used by SyncStatusPanel (Overview + Calendar
  // → jump-to-catalog-item links) + card publish transitions.
  // Bug fix 2026-07-26: jump links broke after ADR-057 landed because
  // /overview and /calendar aren't mounted with the /catalog card grid,
  // so document.getElementById() returned null. Now we router.push to
  // /catalog first when the caller isn't already there.
  const ensureVideoVisible = useCallback((videoId: string, intent?: "publish") => {
    const all = videoStore.getAll();
    const status = all.find(v => v.id === videoId)?.status;
    setFilter(prev => {
      if (intent === "publish") return "Active";
      if (!status) return prev;
      // Prefer the wider filter that keeps the card in view.
      if (prev === "All" || prev === status) return prev;
      return "All";
    });
    const notOnCatalog = pathname !== "/catalog";
    if (notOnCatalog) router.push("/catalog");
    // Defer scroll long enough for the /catalog page to mount +
    // render the video grid. 50ms is enough same-route; ~350ms
    // covers the route transition + initial VideoCard render.
    setTimeout(() => {
      const el = document.getElementById(`video-card-${videoId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.style.outline = "2px solid var(--primary, #6366f1)";
        setTimeout(() => { el.style.outline = ""; }, 2000);
      }
    }, notOnCatalog ? 350 : 50);
  }, [pathname, router]);

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
    currentPromptVersion,
    seriesRegistry,
    backfillQueueSize,
    backfillReadySize,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
