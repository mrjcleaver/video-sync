# ADR-031: Server-Side Rule Persistence

**Status**: Accepted
**Date**: 2026-03-30

## Context

Processing rules (and post-processing rules) are currently stored only in browser localStorage. This means:

1. Rules are lost when accessing from a different browser or device.
2. Rules cannot be inspected or recovered via API.
3. There is no canonical source of truth — each browser session may diverge.

The app already has a `data/` directory used for server-side JSON files (e.g. `backfill-state.json`). Cloud Run's `/app/data` is ephemeral without a GCS FUSE mount, but the pattern supports durable storage once the mount is configured (ADR-018).

## Decision

Add `GET /api/rules` and `POST /api/rules` endpoints that read/write `data/processing-rules.json` and `data/post-processing-rules.json` on the server filesystem.

The client syncs bidirectionally:
- **On boot**: fetch server rules; if non-empty, merge over localStorage (server wins).
- **On save**: write to localStorage AND POST to server.

This makes the server the canonical store while keeping localStorage as a fast local cache.

## Storage format

```json
{
  "processingRules": [...],
  "postProcessingRules": [...]
}
```

## Consequences

- Rules survive browser changes and are readable/restorable via `GET /api/rules`.
- Without GCS FUSE the `data/` directory is ephemeral on Cloud Run restarts; rules are lost on cold starts until the mount is configured.
- The endpoint is unauthenticated (consistent with the rest of the API — ADR-010 defers auth to the network layer).
