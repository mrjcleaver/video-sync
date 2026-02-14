# Domain Event: VideoDiscovered

**Producer:** Ingestion Context
**Consumer:** Catalog Context

## Description

Emitted when a source adapter detects a new video recording on a source platform, either via webhook reception (Zoom) or scheduled polling (Loom, Fireflies).

## Schema

```
VideoDiscovered {
  event_id:        UUID              -- Unique event identifier
  event_type:      "VideoDiscovered"
  timestamp:       DateTime (UTC)
  source_id:       String            -- Original ID on source platform
  source_platform: SourcePlatform    -- ZOOM | LOOM | FIREFLIES
  tenant_id:       UUID
  title:           String
  description:     String?           -- AI summary for Fireflies
  created_at:      DateTime (UTC)    -- When the recording was made
  duration_seconds: Integer
  participants:    List<String>
  download_url:    String            -- URL to download the video file
  transcript_url:  String?           -- URL to download transcript (VTT/text)
  thumbnail_url:   String?
  metadata_extra:  Map<String, Any>? -- Source-specific overflow data
}
```

## Idempotency

This event is idempotent. If a `VideoRecord` with the same `(source_id, source_platform)` already exists in the Catalog, the consumer updates mutable fields rather than creating a duplicate.

## Example Payload

```json
{
  "event_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "event_type": "VideoDiscovered",
  "timestamp": "2026-02-14T15:30:00Z",
  "source_id": "zoom-987654321",
  "source_platform": "ZOOM",
  "tenant_id": "t-001",
  "title": "Weekly Product Standup",
  "description": null,
  "created_at": "2026-02-14T15:00:00Z",
  "duration_seconds": 1800,
  "participants": ["alice@example.com", "bob@example.com"],
  "download_url": "https://zoom.us/rec/download/...",
  "transcript_url": "https://zoom.us/rec/download/...vtt",
  "thumbnail_url": null,
  "metadata_extra": {
    "zoom_meeting_id": "123456789",
    "recording_type": "shared_screen_with_speaker_view"
  }
}
```
