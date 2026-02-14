# Domain Event: PublishFailed

**Producer:** Publishing Context
**Consumer:** Catalog Context

## Description

Emitted when a `PublishJob` has exhausted all retry attempts and permanently failed. The Catalog context uses this event to update the `VideoRecord` status to `FAILED`.

Note: Transient failures that are retried do **not** emit this event. This event is only emitted when `attempt_count >= max_attempts`.

## Schema

```
PublishFailed {
  event_id:         UUID
  event_type:       "PublishFailed"
  timestamp:        DateTime (UTC)
  publish_job_id:   UUID
  video_record_id:  UUID
  tenant_id:        UUID
  destination:      DestinationPlatform
  error_message:    String
  attempt_count:    Integer
  failure_phase:    String             -- "downloading" | "uploading"
}
```

## Side Effects

When the Catalog context processes this event:
1. `VideoRecord.status` is set to `FAILED`.
2. The failure is logged for admin review.
3. The user who requested publishing is notified (via UI notification or email).

## Example Payload

```json
{
  "event_id": "e5f6a7b8-c9d0-1234-efab-345678901234",
  "event_type": "PublishFailed",
  "timestamp": "2026-02-14T17:30:00Z",
  "publish_job_id": "pj-002",
  "video_record_id": "vr-003",
  "tenant_id": "t-001",
  "destination": "KALTURA",
  "error_message": "Kaltura API returned 503 Service Unavailable after 4 attempts",
  "attempt_count": 4,
  "failure_phase": "uploading"
}
```
