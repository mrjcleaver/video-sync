# ADR-005: Source Platform Integration Strategy

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-02-14 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

Each source platform (Zoom, Loom, Fireflies.ai) exposes a different API paradigm:

| Platform | API Type | Notification | Auth |
|----------|----------|-------------|------|
| Zoom | REST | Webhooks (`recording.completed`) | OAuth 2.0 (Server-to-Server) |
| Loom | REST | None (polling required) | API Key / OAuth |
| Fireflies.ai | GraphQL | None (polling required) | API Key |

We need a strategy that:
- Maximizes freshness for platforms that support push notifications.
- Provides reliable polling for platforms that do not.
- Isolates source-specific logic so that adding a new source does not affect existing ones.
- Handles OAuth token refresh transparently.

## Decision

We will implement a **Source Adapter pattern** where each source platform is encapsulated as an independent adapter behind a common `SourceAdapter` interface:

```
interface SourceAdapter {
  name: SourcePlatform
  initialize(credentials: EncryptedCredentials): Promise<void>
  fetchNewRecordings(since: DateTime): Promise<VideoDiscoveredEvent[]>
  getDownloadUrl(sourceId: string): Promise<string>
  getTranscript(sourceId: string): Promise<string | null>
}
```

### Per-Platform Strategy

**Zoom Adapter:**
- Registers a webhook endpoint at `/webhooks/zoom` to receive `recording.completed` events.
- Webhook handler validates the Zoom signature, extracts recording metadata, and emits `VideoDiscovered`.
- Fallback: A poller runs every 15 minutes to catch any missed webhooks.
- OAuth 2.0 token refresh is handled via a `TokenManager` that refreshes tokens proactively before expiry.

**Loom Adapter:**
- Poller runs every 10 minutes, calling `GET /v1/videos` with a `created_after` filter.
- Deduplication via `source_id` prevents re-indexing known videos.

**Fireflies Adapter:**
- Poller runs every 10 minutes, querying the GraphQL API for recent meetings.
- Extracts transcript text and AI summary into the `description` and `transcript_text` fields.

### Token Management

All OAuth tokens and API keys are stored encrypted in the database (see ADR-007). A `TokenManager` service handles:
- Automatic refresh of OAuth tokens before expiry (with a 5-minute buffer).
- Credential rotation without service restart.
- Per-tenant credential isolation in multi-tenant deployments.

## Consequences

### Positive
- Clean separation of concerns: each adapter is independently testable and deployable.
- Common interface allows the ingestion orchestrator to be source-agnostic.
- Webhook + fallback poller strategy for Zoom ensures no recordings are missed.

### Negative
- Maintaining three adapters with different API paradigms increases codebase surface area.
- Polling introduces inherent latency (bounded by interval) for Loom and Fireflies.
- Fireflies GraphQL schema changes could break the adapter without compile-time safety.

### Risks
- Zoom webhook delivery is not guaranteed; the fallback poller is essential.
- Loom API rate limits may constrain polling frequency in high-volume accounts.
