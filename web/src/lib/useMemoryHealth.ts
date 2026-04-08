"use client";

import { useEffect, useRef } from "react";
import { clientLog } from "./logger";

const POLL_INTERVAL = 30_000; // 30 seconds

/**
 * Polls /api/health and injects server-side memory alerts into the client
 * EventLog so operators see memory pressure warnings in the UI.
 */
export function useMemoryHealth() {
  const lastSeen = useRef<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;

    async function poll() {
      try {
        const qs = lastSeen.current ? `?since=${encodeURIComponent(lastSeen.current)}` : "";
        const res = await fetch(`/api/health${qs}`);
        if (!res.ok) return;
        const data = await res.json();

        // Surface new alerts into the client-side structured log
        if (Array.isArray(data.alerts)) {
          for (const a of data.alerts) {
            const level = a.level === "error" ? "error" : "warn";
            clientLog(level, "runtime:memory", a.msg, {
              rss_mb: a.rss_mb,
              limit_mb: a.limit_mb,
              ratio: a.ratio,
            });
            lastSeen.current = a.ts;
          }
        }
      } catch {
        // Network failure — silently skip
      }
    }

    poll();
    timer = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, []);
}
