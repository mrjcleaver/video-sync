# Domain Event: VideoIndexed

**Producer:** Catalog Context
**Consumer:** (Dashboard/UI for real-time updates)

## Description

Emitted when a `VideoRecord` is successfully created or updated in the catalog. This event signals that the video is now searchable and available in the unified dashboard.

## Schema

```
VideoIndexed {
  event_id:        UUID
  event_type:      "VideoIndexed"
  timestamp:       DateTime (UTC)
  video_record_id: UUID              -- Internal VideoRecord ID
  source_id:       String
  source_platform: SourcePlatform
  tenant_id:       UUID
  title:           String
  is_update:       Boolean           -- true if this was a metadata update, not a new record
}
```

## Example Payload

```json
{
  "event_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "event_type": "VideoIndexed",
  "timestamp": "2026-02-14T15:30:05Z",
  "video_record_id": "vr-001",
  "source_id": "zoom-987654321",
  "source_platform": "ZOOM",
  "tenant_id": "t-001",
  "title": "Weekly Product Standup",
  "is_update": false
}
```
