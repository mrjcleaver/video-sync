# Bounded Context: Ingestion

## Purpose

The Ingestion Context is responsible for discovering new video content on source platforms and emitting normalized discovery events for downstream processing.

## Aggregates

### SourceConnection

Represents a configured integration with a single source platform for a specific tenant.

```
SourceConnection {
  id:             UUID
  tenant_id:      UUID
  platform:       SourcePlatform          -- ZOOM | LOOM | FIREFLIES
  status:         ConnectionStatus        -- ACTIVE | PAUSED | ERROR
  poll_interval:  Duration                -- e.g., PT10M (10 minutes)
  last_polled_at: DateTime (nullable)
  credential_id:  UUID                    -- FK to Identity.PlatformCredential
  webhook_secret: String (nullable)       -- For Zoom webhook verification
  config:         JSONB                   -- Platform-specific config
}
```

**Invariants:**
- A tenant may have at most one active SourceConnection per platform.
- `poll_interval` must be >= 1 minute to respect API rate limits.
- `webhook_secret` is required when platform is ZOOM.

### IngestionJob

Tracks an individual polling or webhook processing run.

```
IngestionJob {
  id:                UUID
  source_connection_id: UUID
  started_at:        DateTime
  completed_at:      DateTime (nullable)
  status:            JobStatus             -- RUNNING | COMPLETED | FAILED
  videos_discovered: Integer               -- Count of new videos found
  error_message:     String (nullable)
}
```

## Domain Services

### SourceAdapterRegistry

Maintains a registry of `SourceAdapter` implementations. Given a `SourcePlatform`, returns the appropriate adapter.

### IngestionOrchestrator

Coordinates scheduled polling:
1. Queries all `ACTIVE` SourceConnections.
2. For each, obtains a valid token via `Identity.TokenManager`.
3. Invokes the appropriate `SourceAdapter.fetchNewRecordings()`.
4. Emits `VideoDiscovered` events for each new recording.
5. Updates `SourceConnection.last_polled_at`.

### WebhookHandler

Receives inbound webhooks (Zoom `recording.completed`):
1. Validates the webhook signature using `SourceConnection.webhook_secret`.
2. Parses the payload into a `VideoDiscovered` event.
3. Emits the event to the Catalog context.

## Domain Events Produced

| Event | Trigger | Payload |
|-------|---------|---------|
| `VideoDiscovered` | New recording found via poll or webhook | `source_id`, `source_platform`, `title`, `created_at`, `duration`, `participants`, `download_url`, `transcript_url` |

## Anti-Corruption Layer

Each `SourceAdapter` acts as an anti-corruption layer, translating the source platform's native data model into the `VideoDiscovered` event schema. Source-specific fields that don't map to the canonical schema are placed in a `metadata_extra` bag.

## External Dependencies

- Zoom REST API + Webhooks
- Loom REST API
- Fireflies.ai GraphQL API
- Identity Context (for credentials)
