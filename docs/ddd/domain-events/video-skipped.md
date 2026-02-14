# Domain Event: VideoSkipped

**Producer:** Catalog Context (user curation action)
**Consumer:** (Dashboard/UI for real-time updates)

## Description

Emitted when a curator skips a video from the checklist, indicating it should not be published. The video remains in the catalog for search but is excluded from the publish-ready view. This action is reversible -- a skipped video can be approved later.

See [ADR-009](../../adr/ADR-009-checklist-curation.md) for the curation workflow design.

## Schema

```
VideoSkipped {
  event_id:        UUID
  event_type:      "VideoSkipped"
  timestamp:       DateTime (UTC)
  video_record_id: UUID
  tenant_id:       UUID
  skipped_by:      UUID              -- User ID of the curator
  reason:          String?           -- Optional reason for skipping
}
```

## Business Rules

- Only users with ADMIN or PUBLISHER role may skip videos.
- The video must be in `DISCOVERED` status.
- Skipping is reversible -- a subsequent `VideoApproved` event can transition it back.

## Example Payload

```json
{
  "event_id": "h8i9j0k1-l2m3-4567-hijk-678901234567",
  "event_type": "VideoSkipped",
  "timestamp": "2026-02-14T16:05:00Z",
  "video_record_id": "vr-002",
  "tenant_id": "t-001",
  "skipped_by": "u-001",
  "reason": "Internal retrospective - not for external distribution"
}
```
