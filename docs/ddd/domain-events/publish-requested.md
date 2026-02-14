# Domain Event: PublishRequested

**Producer:** UI / API Gateway (user action)
**Consumer:** Publishing Context

## Description

Emitted when a user selects a video from the catalog and initiates a publish operation to a destination platform. This event triggers the creation of a `PublishJob`.

## Schema

```
PublishRequested {
  event_id:          UUID
  event_type:        "PublishRequested"
  timestamp:         DateTime (UTC)
  video_record_id:   UUID
  tenant_id:         UUID
  requested_by:      UUID              -- User ID
  destination:       DestinationPlatform  -- YOUTUBE | KALTURA
  destination_conn_id: UUID
  metadata_override: PublishMetadata
  privacy_setting:   PrivacySetting?   -- Required for YouTube
  kaltura_category:  String?           -- Optional for Kaltura
}
```

## Validation Rules

- `video_record_id` must reference an existing VideoRecord with status `APPROVED` (see [ADR-009](../../adr/ADR-009-checklist-curation.md)).
- `requested_by` must be a user with ADMIN or PUBLISHER role.
- `destination_conn_id` must reference an active DestinationConnection.
- `metadata_override.title` must be non-empty.
- If `destination` is `YOUTUBE`, `privacy_setting` must be provided.

## Example Payload

```json
{
  "event_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
  "event_type": "PublishRequested",
  "timestamp": "2026-02-14T16:00:00Z",
  "video_record_id": "vr-001",
  "tenant_id": "t-001",
  "requested_by": "u-001",
  "destination": "YOUTUBE",
  "destination_conn_id": "dc-001",
  "metadata_override": {
    "title": "Weekly Product Standup - Feb 14, 2026",
    "description": "Product team weekly standup covering sprint progress and blockers.",
    "tags": ["standup", "product", "weekly"]
  },
  "privacy_setting": "UNLISTED"
}
```
