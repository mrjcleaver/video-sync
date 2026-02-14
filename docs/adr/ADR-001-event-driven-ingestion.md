# ADR-001: Event-Driven Architecture for Video Ingestion

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-02-14 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The Video Bridge must ingest video metadata from three source platforms (Zoom, Loom, Fireflies.ai), each with different API patterns:

- **Zoom** supports webhooks (`recording.completed`) for push-based notification.
- **Loom** provides a REST API requiring pull-based polling.
- **Fireflies.ai** exposes a GraphQL API, also pull-based.

We need an architecture that can handle both push and pull ingestion patterns uniformly, scale to handle bursts of recordings (e.g., end-of-day meeting dumps), and remain decoupled from the downstream indexing and publishing concerns.

## Decision

We will adopt an **event-driven architecture** for the ingestion layer:

1. **Webhook Receiver**: An HTTP endpoint receives Zoom `recording.completed` webhooks and emits a `VideoDiscovered` domain event.
2. **Pollers**: Scheduled cron-based pollers query Loom and Fireflies APIs at configurable intervals and emit the same `VideoDiscovered` event for each new recording found.
3. **Event Bus**: All `VideoDiscovered` events flow through an internal event bus (backed by the job queue — see ADR-003) which decouples ingestion from indexing.
4. **Idempotency**: Each source adapter maintains a `Source_ID` deduplication check to ensure the same recording is not processed twice.

## Consequences

### Positive
- Uniform handling of push and pull sources through a common event contract.
- New source platforms can be added by implementing a new adapter that emits `VideoDiscovered`.
- Ingestion bursts are absorbed by the event bus / job queue rather than overwhelming the indexing engine.

### Negative
- Polling-based sources introduce latency (bounded by poll interval) compared to webhook-based sources.
- The event bus adds infrastructure complexity compared to a simple synchronous pipeline.

### Risks
- Webhook delivery failures from Zoom require a fallback polling mechanism to avoid missed recordings.
- Poll intervals must be tuned per source to balance freshness against API rate limits.
