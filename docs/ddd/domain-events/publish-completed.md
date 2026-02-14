# Domain Event: PublishCompleted

**Producer:** Publishing Context
**Consumer:** Catalog Context

## Description

Emitted when a `PublishJob` successfully completes the upload to the destination platform. The Catalog context uses this event to update the `VideoRecord` status to `PUBLISHED` and store the destination URL.

## Schema

```
PublishCompleted {
  event_id:         UUID
  event_type:       "PublishCompleted"
  timestamp:        DateTime (UTC)
  publish_job_id:   UUID
  video_record_id:  UUID
  tenant_id:        UUID
  destination:      DestinationPlatform
  destination_id:   String             -- Video ID on the destination platform
  destination_url:  String             -- Public/accessible URL on destination
}
```

## Side Effects

When the Catalog context processes this event:
1. `VideoRecord.status` is set to `PUBLISHED`.
2. `VideoRecord.published_at` is set to the event timestamp.
3. `VideoRecord.destination_id` is set.
4. `VideoRecord.destination_url` is set.

## Example Payload

```json
{
  "event_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
  "event_type": "PublishCompleted",
  "timestamp": "2026-02-14T16:15:00Z",
  "publish_job_id": "pj-001",
  "video_record_id": "vr-001",
  "tenant_id": "t-001",
  "destination": "YOUTUBE",
  "destination_id": "dQw4w9WgXcQ",
  "destination_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```
