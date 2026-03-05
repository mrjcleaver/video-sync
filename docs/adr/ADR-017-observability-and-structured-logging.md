# ADR-017: Observability and Structured Logging

**Date:** 2026-03-05
**Status:** Accepted
**Deciders:** Engineering

---

## Context

The system currently has near-zero observability:

| Layer | Current state |
|-------|--------------|
| Server-side API routes | No request/response logging |
| External API calls (Zoom, Fireflies, YouTube, OpenRouter) | No latency, status, or error logging |
| WASM state machine transitions | No event logging |
| Backfill orchestrator | Status string in UI only; not persisted |
| Client-side errors | React errors silently swallowed |
| EventLog (UI) | In-memory array; lost on page reload |
| Correlation across a request chain | No request IDs |

Concrete gaps exposed in development:

- `/api/zoom/transcript` returned HTML 500 for an extended period before root-cause was found (stale `.next` cache) — a server-side log would have surfaced `Cannot find module './331.js'` immediately.
- WASM heap corruption (`memory access out of bounds in mark_failed`) required reading source code to diagnose; structured transition logs would have shown the `update_metadata` call preceding the crash.
- Backfill quota state is visible only by polling `/api/backfill/state`; no history.
- "Request failed (502)" errors in the UI give users no actionable detail.

### What Observability Means Here

Observability = the ability to answer "what happened?" from outputs alone, without re-running the code. Three pillars:

1. **Logs** — discrete timestamped events with context (who, what, result, duration, error).
2. **Metrics** — counters and histograms over time (uploads today, import success rate, API p95 latency).
3. **Traces** — causal chains linking a browser action → API route → external API call → WASM mutation.

---

## Decision

Implement observability in three tiers aligned with system growth.

---

## Tier 1: Structured Logger + Request Middleware + Persistent Event Log

### 1.1 Structured Logger (`web/src/lib/logger.ts`)

A lightweight logger with no external dependencies. JSON output in production/server; pretty-printed in browser dev console.

**Log record schema:**

```ts
interface LogRecord {
  ts: string;           // ISO-8601 UTC
  level: "debug" | "info" | "warn" | "error";
  component: string;    // "api:zoom/transcript", "store", "backfill", etc.
  msg: string;
  rid?: string;         // correlation request ID (X-Request-ID)
  duration_ms?: number; // for timed operations
  status?: number;      // HTTP status code
  video_id?: string;
  platform?: string;
  error?: string;       // stringified error, never raw stack in prod
  [key: string]: unknown;
}
```

**Log levels:**

| Level | Use |
|-------|-----|
| `debug` | Internal state transitions, WASM calls (dev only) |
| `info` | Request start/end, import completed, upload published |
| `warn` | Retries, quota approaching, non-fatal degraded paths |
| `error` | External API failures, WASM crashes, unhandled rejections |

**Server-side transport:** JSON lines to `stderr` (captured by process supervisor / container runtime). Additionally append to `web/data/server.log` with 10 MB rotation (rename to `.1`, `.2`; keep 3 files).

**Client-side transport:** Structured JSON pushed to a circular buffer in `localStorage["video-sync:eventlog"]` (max 500 entries, FIFO eviction). Also written to `console` in dev mode. The existing `EventLog` UI component reads from this buffer on mount so events survive page reload.

### 1.2 PII / Secret Redaction

The logger **must** redact secrets before any output:

- Fields named `apiKey`, `refreshToken`, `clientSecret`, `access_token`, `password` → replaced with `"[REDACTED]"`.
- Values matching `/^sk-[a-zA-Z0-9\-]{20,}/` (OpenAI/OpenRouter keys) → `"[REDACTED]"`.
- Values matching `/^[A-Za-z0-9+/]{20,}={0,2}$/` (base64-like, >30 chars in credential contexts) → `"[REDACTED]"`.

Redaction is applied recursively on the log record object before serialisation.

### 1.3 Request Middleware (`web/src/lib/requestLogger.ts`)

A Next.js `middleware.ts` (or per-route wrapper) that:

1. Generates a `rid` (UUID v4) if `X-Request-ID` header is absent; echoes it in the response.
2. Logs `info` on request start: `{ component, method, path, rid }`.
3. On completion: `{ status, duration_ms, rid }`.
4. On error (caught exception): `{ level: "error", error: err.message, rid }`.

All API route handlers receive `rid` via a helper and include it in downstream `fetch` calls as `X-Request-ID`.

**Example log lines (server, JSON):**

```json
{"ts":"2026-03-05T02:14:01.003Z","level":"info","component":"api:zoom/recordings","msg":"request","method":"POST","path":"/api/zoom/recordings","rid":"a1b2c3d4"}
{"ts":"2026-03-05T02:14:01.847Z","level":"info","component":"api:zoom/recordings","msg":"response","status":200,"duration_ms":844,"rid":"a1b2c3d4","count":12}
{"ts":"2026-03-05T02:14:05.120Z","level":"error","component":"api:zoom/recordings","msg":"Zoom token error","status":401,"rid":"a1b2c3e9","error":"invalid_client"}
```

### 1.4 External API Call Logging

All outbound `fetch` calls to external services (Zoom, Fireflies, YouTube, OpenRouter) are wrapped with timing:

```
info: { component: "ext:zoom-token", duration_ms: 412, status: 200, rid }
error: { component: "ext:youtube-upload-init", duration_ms: 8031, status: 403, error: "...", rid }
```

### 1.5 WASM State Transition Logging

`videoStore.mutate()` wraps every WASM call and logs:

```
debug: { component: "wasm", msg: "transition", video_id, transition: "approve", status_before, status_after, actor_role }
error: { component: "wasm", msg: "transition failed", video_id, transition, error }
```

Transition logging uses `debug` level so it doesn't flood production logs; `error` is always logged.

### 1.6 Backfill Orchestrator Logging

Each tick logs:

```
info: { component: "backfill:tick", msg: "tick", can_upload, uploads_today, quota_limit, window_open, next_id? }
info: { component: "backfill:upload", msg: "started", video_id, title, profile_id }
info: { component: "backfill:upload", msg: "published", video_id, yt_video_id, yt_url, duration_ms }
error: { component: "backfill:upload", msg: "failed", video_id, error, attempts }
```

### 1.7 React Error Boundary

A top-level `<ErrorBoundary>` catches React rendering errors and:
- Logs `error` to the client buffer.
- Renders a fallback UI with the `rid`-style correlation ID so users can report it.
- Does **not** re-throw (prevents blank page).

### 1.8 Persistent EventLog (UI upgrade)

The existing in-memory `events: string[]` array in `page.tsx` is supplemented by:

- `loadEventLog()` / `appendEvent()` helpers reading/writing `localStorage["video-sync:eventlog"]`.
- `EventLog` component renders the most recent 100 entries from the buffer on mount.
- Each entry shows: `[timestamp] [level] component: message`.
- "Clear log" button truncates the buffer.
- "Download log" button exports the full buffer as a `.jsonl` file for support purposes.

---

## Tier 2: OpenTelemetry Integration

When the system needs to be operated in shared/production infrastructure:

- Add `@opentelemetry/sdk-node` (server) and `@opentelemetry/sdk-web` (browser).
- Export traces and logs to an OTLP endpoint (env var `OTEL_EXPORTER_OTLP_ENDPOINT`).
- Instrument all `fetch` calls with `@opentelemetry/instrumentation-fetch`.
- Instrument Next.js routes with `@vercel/otel` or custom `NodeSDK`.
- Recommended backends: **Grafana Cloud** (free tier, Loki + Tempo + Prometheus), **Axiom** (generous free tier), **Honeycomb**.

Tier 1 logger emits JSON that is directly ingestible by Loki's log scraper without changes.

Key spans:

| Span name | Attributes |
|-----------|-----------|
| `video-sync.import.zoom` | `platform`, `count`, `date_from`, `date_to` |
| `video-sync.import.fireflies` | `platform`, `count`, `pages_fetched` |
| `video-sync.upload.youtube` | `video_id`, `privacy`, `duration_s`, `size_bytes` |
| `video-sync.backfill.tick` | `quota_used`, `quota_limit`, `queue_depth` |
| `video-sync.wasm.transition` | `transition`, `video_id` |
| `video-sync.llm.summarize` | `model`, `token_estimate`, `duration_ms` |

---

## Tier 3: Dashboards and Alerting

Self-hosted Grafana (or Grafana Cloud) dashboards:

1. **Upload Pipeline Health** — daily upload count vs quota, success/failure rate, p50/p95 upload duration.
2. **Import Activity** — Zoom/Fireflies imports per day, import error rate.
3. **Video Funnel** — status distribution (Discovered→Published) as a Sankey/funnel.
4. **LLM Cost Tracker** — summarize call count × estimated tokens × model price.

Alerting rules:

| Alert | Condition |
|-------|-----------|
| Quota exhausted | `uploads_today >= max_uploads_per_day` before 18:00 UTC |
| High failure rate | >20% of uploads failed in last hour |
| WASM crash | Any `error` log from `component: "wasm"` |
| External API degraded | p95 latency > 5s for Zoom/YouTube over 10-minute window |

---

## Field Naming Conventions

All log records follow these naming conventions for future cardinality/indexing:

| Field | Type | Notes |
|-------|------|-------|
| `ts` | ISO-8601 string | UTC always |
| `level` | enum | debug/info/warn/error |
| `component` | string | `layer:subcomponent`, e.g. `api:backfill/tick`, `ext:youtube`, `wasm`, `store` |
| `msg` | string | Short human-readable description |
| `rid` | UUID string | Correlation ID for request chain |
| `video_id` | UUID string | When log pertains to a specific video |
| `platform` | string | YouTube/Zoom/Fireflies/Loom |
| `duration_ms` | integer | Elapsed time in milliseconds |
| `status` | integer | HTTP status code |
| `error` | string | `err.message` only — no stack traces in production |
| `count` | integer | Number of items processed |

---

## What Is Explicitly Out of Scope

- **Full distributed tracing at Tier 1** — correlation IDs give "poor man's tracing" without the OpenTelemetry SDK weight.
- **Server-side metrics endpoint** (`/metrics` Prometheus scrape) — deferred to Tier 2.
- **Log aggregation infrastructure** at Tier 1 — JSON lines to disk is sufficient for single-machine MVP.
- **Session replay / RUM** (e.g. Sentry Replay, LogRocket) — high data volume, not warranted yet.
- **Log encryption at rest** — logs must not contain secrets (enforced by redaction); encryption is an ops concern.

---

## Consequences

### Positive

- Any "Request failed (502)" in the UI can now be correlated to a server log entry showing the exact external API error and the full `rid` chain.
- WASM crashes produce a log entry with the preceding transition, enabling post-mortem without source-code archaeology.
- Backfill quota history is queryable from the structured log (filter `component: "backfill:tick"`).
- Tier 1 has zero new npm dependencies (logger is ~60 lines of TypeScript).
- Log records from Tier 1 are directly ingestible by Loki, making the Tier 2 upgrade additive.

### Negative

- `localStorage["video-sync:eventlog"]` adds ~200–500 KB of storage use (500 entries × ~400 bytes each).
- JSON log lines are slightly more verbose than plaintext; mitigated by log rotation.
- Developers must remember to include `rid` in new API routes — requires code review discipline.

---

## Implementation Plan

### Tier 1 (current sprint)

1. `web/src/lib/logger.ts` — Logger class with level filter, redaction, JSON serialiser, dual transport (console + localStorage on client; console + file on server).
2. `web/src/lib/requestLogger.ts` — Middleware factory: `withRequestLogging(handler)` wrapper for API routes.
3. Retrofit all 8 existing API routes with `withRequestLogging`.
4. Add external-call timing wrappers inside Zoom, Fireflies, YouTube, and summarize routes.
5. Update `videoStore.mutate()` in `store.ts` to log WASM transitions.
6. Add `<ErrorBoundary>` in `page.tsx`.
7. Extend `EventLog` component: persistent buffer, download button, clear button.

### Tier 2

- Add OpenTelemetry SDK when deploying to shared infrastructure.
- Configure OTLP exporter via env var.

### Tier 3

- Import Grafana dashboard JSON definitions into repo under `docs/dashboards/`.
- Add alerting rules as code (Grafana Alerting JSON or Prometheus recording rules).

---

## Alternatives Considered

| Option | Rejected reason |
|--------|----------------|
| `pino` / `winston` npm package | Adds dependency; the core schema is simple enough to own; can adopt later |
| Sentry SDK | Too broad for Tier 1; SDK is 80 KB gzipped; PII handling complex |
| Vercel Analytics | Cloud-only; not available in self-hosted / devcontainer |
| Storing logs in WASM heap | WASM heap is explicitly kept lean (ADR-017 context); JS side is correct home for logs |
| Per-component log files | One unified file is simpler to tail, rotate, and ingest |
