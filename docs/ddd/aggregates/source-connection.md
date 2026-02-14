# Aggregate: SourceConnection

**Bounded Context:** [Ingestion](../bounded-contexts/ingestion.md)

## Description

The `SourceConnection` aggregate represents a configured integration between the Video Bridge and a source video platform. It holds configuration for polling intervals, webhook secrets, and references to encrypted credentials.

## Entity Diagram

```
SourceConnection (Aggregate Root)
├── id: UUID
├── tenant_id: UUID
├── platform: SourcePlatform [VO]
├── status: ConnectionStatus [VO]
├── poll_interval: Duration
├── last_polled_at: DateTime?
├── credential_id: UUID
├── webhook_secret: String?
└── config: JSONB
```

## Business Rules

1. **One Per Platform**: A tenant may have at most one active `SourceConnection` per `SourcePlatform`.
2. **Minimum Poll Interval**: `poll_interval` must be >= 1 minute to avoid API rate limit violations.
3. **Zoom Webhook Secret**: When `platform` is `ZOOM`, `webhook_secret` must be set for webhook signature verification.
4. **Credential Validity**: Before polling, the system verifies the referenced credential is `VALID` via the Identity context. If `INVALID`, the connection status transitions to `ERROR`.
5. **Error Recovery**: When a connection enters `ERROR` status (e.g., invalid credentials, repeated API failures), it is excluded from polling until an admin resolves the issue and reactivates it.

## Commands

| Command | Description | Preconditions |
|---------|-------------|---------------|
| `CreateConnection` | Configure a new source integration | Admin role, no duplicate platform for tenant |
| `UpdateConnection` | Modify polling interval or config | Connection exists, admin role |
| `PauseConnection` | Temporarily stop polling | Status is ACTIVE |
| `ResumeConnection` | Resume polling | Status is PAUSED |
| `MarkError` | Transition to ERROR on repeated failures | Status is ACTIVE |
| `DeleteConnection` | Remove the integration | Admin role |
