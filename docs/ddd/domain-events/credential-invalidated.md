# Domain Event: CredentialInvalidated

**Producer:** Identity Context
**Consumer:** Ingestion Context, Publishing Context

## Description

Emitted when a platform credential becomes invalid (e.g., OAuth refresh token revoked by the user, API key deleted on the source platform). Consuming contexts should pause operations that depend on this credential and alert the admin.

## Schema

```
CredentialInvalidated {
  event_id:       UUID
  event_type:     "CredentialInvalidated"
  timestamp:      DateTime (UTC)
  credential_id:  UUID
  platform:       Platform              -- ZOOM | LOOM | FIREFLIES | YOUTUBE | KALTURA
  tenant_id:      UUID
  reason:         String                -- Human-readable reason
}
```

## Side Effects

**Ingestion Context:**
- If the invalidated credential belongs to a `SourceConnection`, set that connection's status to `ERROR`.
- Pause polling for that source until the admin re-authorizes.

**Publishing Context:**
- If the invalidated credential belongs to a `DestinationConnection`, set that connection's status to `ERROR`.
- Reject new PublishJobs targeting that destination.
- In-flight PublishJobs should fail gracefully and not retry (the issue is not transient).

## Example Payload

```json
{
  "event_id": "f6a7b8c9-d0e1-2345-fabc-456789012345",
  "event_type": "CredentialInvalidated",
  "timestamp": "2026-02-14T18:00:00Z",
  "credential_id": "cred-001",
  "platform": "ZOOM",
  "tenant_id": "t-001",
  "reason": "OAuth refresh token rejected by Zoom (HTTP 401: invalid_grant)"
}
```
