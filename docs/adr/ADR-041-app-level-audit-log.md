# ADR-041: App-Level Audit Log of Access and Mutation Attempts

**Status**: Accepted (implemented 2026-05-01)
**Date**: 2026-05-01
**Deciders**: Architecture Team
**Extends**: ADR-017 (Observability and Structured Logging)
**Related**: ADR-022 (Compliance audit), ADR-035 (Persistence topology), ADR-036 (Workspace authentication)

---

## Context

ADR-017 established structured logging across server routes, but the lines emitted by `withRequestLogging` carried only `method`, `path`, `status`, `duration_ms`, and a request id. They did **not** carry the authenticated user, did **not** distinguish read from write, and were **not** surfaced anywhere the operator could see them in-app — only in Cloud Logging via `gcloud logging read`.

Three operator concerns drove this ADR:

1. **Forensic question** ("Who deleted that record on April 14th at 3pm?") had no answer in the app. Cloud Logging held HTTP-level entries but no actor identity, so reconstructing required cross-referencing `x-goog-iap-jwt-assertion` headers against IAP's own access logs.
2. **Realtime visibility** — the in-app EventLog only showed actions the *current* browser triggered. Two operators working concurrently had no way to see each other's actions until the catalog refreshed or events propagated through unrelated logging surfaces.
3. **Failed-access trail** — unauthenticated or wrongly-scoped attempts (the 401s we hit during the auth-debugging incident on 2026-04-30) had no actor breadcrumb. The HTTP request log showed a 401 with no diagnostic context.

The required fix: every API request gets actor identity attached at the audit layer, mutating versus read-only is explicit, and the resulting trail is visible *both* in Cloud Logging (long-term) and in the in-app EventLog (realtime).

---

## Decision

### Three-layer audit model

| Layer | Who reads it | Retention |
|-------|--------------|-----------|
| **Cloud Logging** (stdout JSON) | Engineers, on-call | 30 days (default), opt-in extension |
| **`data/server.log`** (FUSE-mounted file) | Disaster recovery, ad-hoc grep | Bounded by FUSE-bucket policy |
| **In-memory ring buffer** + `/api/audit/recent` | Operators via the in-app EventLog | 500 entries / per-instance / process lifetime |

All three are populated from the same code path inside `withRequestLogging` so they cannot drift.

### Data shape

Every request emits two `serverLog` lines (`req` and `res`) **and** one ring-buffer entry on `res`. Each carries:

```ts
{
  audit: "access" | "mutation",          // GET/HEAD/OPTIONS vs POST/PUT/PATCH/DELETE
  actor_email: string | null,
  actor_role: "Admin" | "Publisher" | "Viewer" | null,
  actor_user_id: string | null,           // UUID derived from Google sub claim
  actor_error: string | null,             // populated on auth failure
  method: string,
  path: string,
  status: number,
  duration_ms: number,
  rid: string,
}
```

`audit: "access"` covers reads. `audit: "mutation"` covers state-changing methods. `actor_error` is mutually exclusive with the populated `actor_*` triple: an authenticated request gets actor identity; an unauthenticated one gets the failure reason.

### Best-effort actor resolution

`withRequestLogging` calls `getActor(req)` wrapped in a try/catch. Failures *don't* break the request — they become explicit `actor_error` entries. This is the access-attempt audit trail for unauthenticated requests; if we threw, the failure would be invisible to the operator until they noticed a missing log.

JWT verification + Cloud-Identity-fallback role lookup adds ~1-2ms per request after warm-up (JWKS cached, group membership cached for 5 min per ADR-036). Cold-start adds ~1s for the first JWKS fetch. Acceptable overhead for a who-did-what trail.

### In-memory ring buffer

A 500-entry deque in `serverLogger.ts` holds the most recent audit events. `pushAudit` appends and trims; `getRecentAudit(sinceIso?, limit?)` returns events later than a timestamp (used by client poll) or the last N (used for cold initialization). The poll endpoint itself (`/api/audit/recent`) is excluded from the buffer to prevent feedback noise.

### Client poll

The catalog page polls `/api/audit/recent?since=<lastSeenTs>` every 8 seconds. New events with one of these properties are appended to the EventLog:

- `audit === "mutation"` (any state change anywhere in the app)
- `status >= 400` (errors — surface failures in real time)
- `actor_error != null` (failed access attempts)

Routine `audit === "access"` 200 responses are filtered out — they're high-volume and operationally low-value at the EventLog tier. They remain visible in Cloud Logging.

EventLog entries are formatted:

```
[mutation] POST /api/youtube/upload 200 (1850ms) by alice@agentics.org
[error]    PUT  /api/artifacts/<id>/transcript 503 (210ms) by bob@agentics.org
[access]   GET  /api/admin/migrate-transcripts 403 (8ms) by unauth (Admin role required)
```

---

## Consequences

### Positive

- **Forensic answer in seconds**, not hours. "Who deleted record X?" → grep the audit buffer or Cloud Logging by `actor_email` + `path`.
- **Realtime cross-operator visibility**. Two operators working concurrently see each other's mutations within ~8s.
- **Auth failures visible to operators**, not just engineers. The 401 from a wrongly-scoped account surfaces with the failure reason ("not a member of any video-sync group"), which would have shortened the 2026-04-30 auth incident materially.
- **No per-route changes**. `withRequestLogging` is the central gate every API route already uses — auditing was added once.

### Negative

- **Per-request JWT verification overhead**. ~1-2ms typical, ~1s cold-start. Acceptable for the value but not zero.
- **In-memory buffer is per-instance**. With `max-instances=3`, three operators on three instances see only their own instance's audit until a poll lands on each. Cloud Logging is the cross-instance source of truth.
- **EventLog noise**. Mutating actions appear twice in the EventLog: once from the client-side `addEvent` (domain-level: "VideoPublished: …") and once from the audit poll (HTTP-level: "[mutation] POST /api/youtube/upload 200 …"). Deliberate — they're complementary views.
- **Email visibility across users**. Any authenticated operator can see other operators' actions. Acceptable for a small team; revisit if the user model expands beyond ~10 trusted operators.

### Risks

- **Buffer overflow under burst**. 500 entries cover ~15 minutes of normal traffic, ~2 minutes of bulk-import bursts. The client poll's `since` filter handles steady-state; bursts may drop events from the in-memory view. Cloud Logging retains everything, so no actual data loss — only the in-app EventLog can lag.
- **Polling cost**. Every authenticated browser polls every 8s. At three concurrent operators, ~22 reqs/min on `/api/audit/recent`. Trivial; if it ever matters we'd switch to Server-Sent Events.
- **`actor_error` content in audit logs**. Auth failure reasons can include the email IAP claimed for a user (the `not a member of any video-sync group` message). Operators see this in their EventLog. Same blast radius as the existing IAP access logs in Cloud Logging, but at a more visible tier.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **Server-Sent Events / WebSocket push** | More infrastructure (long-lived connections, reconnect logic) for a feature that doesn't need sub-second latency. Polling at 8s suffices. |
| **Persist audit to a database table** | The existing two-tier persistence (Cloud Logging + `server.log`) already covers durable audit. A separate table would add migrations, retention policy, and a query API for marginal benefit. |
| **Filter audit log by role** (e.g. Viewers see only their own) | Out of scope. Today the operator team is small and trusted. Add when the user model expands. |
| **Surface every access (`audit: "access"`) in EventLog** | High volume / low signal. Routine GETs aren't operator-relevant; surfacing them clutters the EventLog enough that real signals (mutations / errors / auth failures) get lost. They remain in Cloud Logging. |
| **Embed audit trail inside the WASM event log** | The WASM record's `events` field is a domain history (VideoIndexed, StatusChanged, etc.). HTTP-level audit is a different abstraction. Mixing them would confuse the domain model. |

---

## Open questions

1. **Long-term durability of in-app audit**. The 500-entry buffer is per-instance and process-lifetime-bounded. If operators want a true "last 30 days" view in the EventLog, a daily snapshot to `data/audit-{YYYY-MM-DD}.jsonl` would be the simplest extension. Defer until requested.
2. **Filter chips on the EventLog itself**. As audit traffic grows, the EventLog might need its own chips (Mine / Mutations / Errors / All) similar to the Sync Status legend. Not built yet; out of scope here.
3. **Mutation metadata correlation**. An audit entry says "POST /api/youtube/upload" but doesn't include the catalog-record id being uploaded. Per-handler `serverLog` calls already include record ids; correlating across the two requires the `rid` (request id) which IS present in both.

---

## References

- ADR-017: Observability and Structured Logging — established `serverLog`, `withRequestLogging`, Cloud Logging integration
- ADR-022: Compliance audit (provenance footers, attribution) — domain-level audit; this ADR is HTTP-level audit
- ADR-035: Persistence topology — `server.log` lives on the FUSE-mounted GCS bucket
- ADR-036: Workspace authentication — actor identity comes from the IAP JWT, role from Cloud Identity Groups
