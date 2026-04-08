/**
 * Runtime memory pressure detection — ADR-032
 *
 * Periodically samples process.memoryUsage() and logs warnings/errors
 * when RSS approaches the container memory limit.
 *
 * Also exposes a snapshot for the /api/health endpoint so the client
 * can surface memory pressure in the UI EventLog.
 *
 * Server-side only — do not import from client components.
 */

import { serverLog } from "./serverLogger";

const WARN_THRESHOLD = 0.80;
const CRIT_THRESHOLD = 0.90;
const MAX_ALERTS = 20;

export interface MemorySnapshot {
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  limit_mb: number;
  ratio: number;          // 0–100
  level: "ok" | "warn" | "critical";
  ts: string;
}

export interface MemoryAlert {
  level: "warn" | "error";
  msg: string;
  rss_mb: number;
  limit_mb: number;
  ratio: number;
  ts: string;
}

/** Ring buffer of recent memory alerts, readable by /api/health */
const recentAlerts: MemoryAlert[] = [];
let latestSnapshot: MemorySnapshot | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;

export function getMemorySnapshot(): MemorySnapshot | null {
  return latestSnapshot;
}

/** Returns alerts newer than `since` (ISO string). */
export function getMemoryAlerts(since?: string): MemoryAlert[] {
  if (!since) return [...recentAlerts];
  return recentAlerts.filter((a) => a.ts > since);
}

export function startMemoryMonitor(intervalMs = 10_000): void {
  if (intervalId) return;

  const limitMb = parseInt(process.env.MEMORY_LIMIT_MB || "1024", 10);

  intervalId = setInterval(() => {
    const { rss, heapUsed, heapTotal } = process.memoryUsage();
    const rssMb = rss / (1024 * 1024);
    const ratio = rssMb / limitMb;
    const ts = new Date().toISOString();

    const level: MemorySnapshot["level"] =
      ratio >= CRIT_THRESHOLD ? "critical" : ratio >= WARN_THRESHOLD ? "warn" : "ok";

    latestSnapshot = {
      rss_mb: Math.round(rssMb),
      heap_used_mb: Math.round(heapUsed / (1024 * 1024)),
      heap_total_mb: Math.round(heapTotal / (1024 * 1024)),
      limit_mb: limitMb,
      ratio: Math.round(ratio * 100),
      level,
      ts,
    };

    if (ratio >= CRIT_THRESHOLD) {
      const fields = {
        rss_mb: latestSnapshot.rss_mb,
        heap_used_mb: latestSnapshot.heap_used_mb,
        heap_total_mb: latestSnapshot.heap_total_mb,
        limit_mb: limitMb,
        ratio: latestSnapshot.ratio,
      };
      serverLog("error", "runtime:memory", "memory critical", fields);
      pushAlert({ level: "error", msg: "memory critical", rss_mb: fields.rss_mb, limit_mb: limitMb, ratio: fields.ratio, ts });
    } else if (ratio >= WARN_THRESHOLD) {
      const fields = {
        rss_mb: latestSnapshot.rss_mb,
        heap_used_mb: latestSnapshot.heap_used_mb,
        heap_total_mb: latestSnapshot.heap_total_mb,
        limit_mb: limitMb,
        ratio: latestSnapshot.ratio,
      };
      serverLog("warn", "runtime:memory", "memory pressure", fields);
      pushAlert({ level: "warn", msg: "memory pressure", rss_mb: fields.rss_mb, limit_mb: limitMb, ratio: fields.ratio, ts });
    }
  }, intervalMs);

  intervalId.unref();

  serverLog("info", "runtime:memory", "monitor started", {
    limit_mb: limitMb,
    warn_pct: WARN_THRESHOLD * 100,
    crit_pct: CRIT_THRESHOLD * 100,
    interval_ms: intervalMs,
  });
}

export function stopMemoryMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function pushAlert(alert: MemoryAlert) {
  recentAlerts.push(alert);
  if (recentAlerts.length > MAX_ALERTS) recentAlerts.shift();
}
