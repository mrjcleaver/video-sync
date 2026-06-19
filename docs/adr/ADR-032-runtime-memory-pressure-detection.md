# ADR-032: Runtime Memory Pressure Detection

**Status**: Proposed
**Date**: 2026-04-08

## Context

On 2026-04-03, the Cloud Run production instance was OOM-killed:

```
Memory limit of 512 MiB exceeded with 524 MiB used.
```

The application had no awareness this was happening. The container was terminated by the runtime with no application-level log entry, no warning to the operator, and no opportunity to shed load or surface diagnostics. The only evidence was a Cloud Logging system-level `ERROR` entry from `run.googleapis.com/varlog/system`.

ADR-018 originally set `memory: 512Mi`. On 2026-04-08 the limit was increased to **1 GiB**, then on 2026-04-22 to **4 GiB** (with `cpu=2` per Cloud Run's requirement) after Kaltura uploads in ADR-037 hit memory pressure from `/tmp` being tmpfs. Increasing the limit alone does not provide visibility — it merely shifts the OOM boundary. ADR-017 defines the structured logging framework but neither ADR addresses proactive memory monitoring from within the application.

### Why 512 MiB is tight

| Consumer | Estimated peak |
|----------|---------------|
| Next.js standalone + Node.js baseline | ~120 MiB |
| YouTube upload: streaming a 500 MB file via `fetch` | ~80–200 MiB (depending on backpressure) |
| Multiple API route handlers in flight | ~20–50 MiB each |
| V8 GC overhead / heap fragmentation | ~50 MiB |

A single large YouTube upload can push RSS above 400 MiB, leaving little headroom for concurrent requests or GC pressure.

## Decision

### 1. Periodic memory usage sampling

Add a lightweight memory monitor that runs inside the Node.js process. On each tick it calls `process.memoryUsage()` and compares RSS against the configured memory limit.

```ts
// src/lib/memoryMonitor.ts
const MEMORY_LIMIT_MB = parseInt(process.env.MEMORY_LIMIT_MB || '512', 10);
const WARN_THRESHOLD = 0.80;  // 80% → warn
const CRIT_THRESHOLD = 0.90;  // 90% → error + action

let intervalId: NodeJS.Timeout | null = null;

export function startMemoryMonitor(intervalMs = 10_000): void {
  if (intervalId) return;
  intervalId = setInterval(() => {
    const { rss, heapUsed, heapTotal } = process.memoryUsage();
    const rssMB = rss / (1024 * 1024);
    const ratio = rssMB / MEMORY_LIMIT_MB;

    if (ratio >= CRIT_THRESHOLD) {
      logger.error({
        component: 'runtime:memory',
        msg: 'memory critical',
        rss_mb: Math.round(rssMB),
        heap_used_mb: Math.round(heapUsed / (1024 * 1024)),
        heap_total_mb: Math.round(heapTotal / (1024 * 1024)),
        limit_mb: MEMORY_LIMIT_MB,
        ratio: Math.round(ratio * 100),
      });
    } else if (ratio >= WARN_THRESHOLD) {
      logger.warn({
        component: 'runtime:memory',
        msg: 'memory pressure',
        rss_mb: Math.round(rssMB),
        limit_mb: MEMORY_LIMIT_MB,
        ratio: Math.round(ratio * 100),
      });
    }
  }, intervalMs);
}
```

### 2. Environment variable: `MEMORY_LIMIT_MB`

Cloud Run does not expose its memory limit to the container at runtime. The `MEMORY_LIMIT_MB` env var is set in the Cloud Run service configuration to match the actual limit (currently `1024` after the 2026-04-08 upgrade from 512 MiB). This keeps the monitor accurate without hardcoding.

### 3. Structured log integration

Memory log entries use the existing ADR-017 logger and follow the established field naming conventions:

| Level | Condition | Fields |
|-------|-----------|--------|
| `warn` | RSS >= 80% of limit | `component`, `msg`, `rss_mb`, `limit_mb`, `ratio` |
| `error` | RSS >= 90% of limit | Above + `heap_used_mb`, `heap_total_mb` |

These entries are captured by Cloud Logging (stdout JSON) and are filterable via `jsonPayload.component = "runtime:memory"`.

### 4. Start on server boot

The monitor is started in the Next.js custom server entry point (`server.js` or instrumentation hook). It does **not** run on the client.

### 5. Future: load shedding (not in scope)

When critical threshold is breached, a future enhancement could:
- Reject new upload requests with `503 Service Unavailable` + `Retry-After`
- Force a `global.gc()` if `--expose-gc` is enabled
- Trigger a graceful shutdown to let Cloud Run spin up a fresh instance

These are noted for future work but **not implemented in this ADR** — the immediate goal is visibility.

## Consequences

### Positive

- OOM kills are preceded by application-level warn/error logs with heap breakdown, giving operators seconds-to-minutes of advance notice.
- Cloud Logging alerts can be configured on `jsonPayload.component = "runtime:memory" AND severity = "ERROR"` to page before OOM.
- Zero new dependencies; `process.memoryUsage()` is built-in.
- The 10-second interval adds negligible overhead (~0.1ms per call).

### Negative

- `MEMORY_LIMIT_MB` must be kept in sync with the Cloud Run service spec. If someone changes the Cloud Run memory to 1 GiB but forgets the env var, thresholds will be wrong. Mitigation: document in the deploy checklist; a future `/api/health` endpoint could expose the mismatch.
- RSS as reported by Node.js includes memory-mapped files (GCS FUSE pages). This may cause false warn-level alerts when large files are mapped but not resident. Mitigation: the 80% threshold provides buffer; `heapUsed` is logged alongside RSS for differential diagnosis.

## Alternatives Considered

| Option | Rejected reason |
|--------|----------------|
| Cloud Monitoring memory metric + alert only | No application-level context (heap breakdown); alert fires *after* OOM, not before |
| `--max-old-space-size` V8 flag | Caps heap but doesn't prevent RSS growth from buffers, native allocations, or GCS FUSE pages |
| Sidecar memory watchdog container | Over-engineered for a single-service app; adds cost and complexity |
| Increase memory to 1 GiB and ignore | Done as a complementary measure (2026-04-08), but this alone masks the problem; the monitor is still needed for visibility |

## References

- ADR-017: Observability and Structured Logging
- ADR-018: Google Cloud Hosting (`memory: 512Mi`)
- [Node.js `process.memoryUsage()`](https://nodejs.org/api/process.html#processmemoryusage)
- [Cloud Run memory limits](https://cloud.google.com/run/docs/configuring/memory-limits)
- Incident: 2026-04-03T12:44:05Z, Cloud Logging `insertId: 69cfb615000e01f46e6429ba`
