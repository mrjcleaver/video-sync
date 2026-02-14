# Domain Event: VideoApproved

**Producer:** Catalog Context (user curation action)
**Consumer:** (Dashboard/UI for real-time updates)

## Description

Emitted when a curator approves a video from the checklist, transitioning it from `DISCOVERED` (or `SKIPPED` / `FAILED`) to `APPROVED`. This makes the video eligible for publishing to destination platforms.

See [ADR-009](../../adr/ADR-009-checklist-curation.md) for the curation workflow design.

## Schema

```
VideoApproved {
  event_id:        UUID
  event_type:      "VideoApproved"
  timestamp:       DateTime (UTC)
  video_record_id: UUID
  tenant_id:       UUID
  approved_by:     UUID              -- User ID of the curator
  previous_status: VideoStatus       -- DISCOVERED | SKIPPED | FAILED
  metadata_edits:  MetadataEdits?    -- Optional edits made during approval
}

MetadataEdits {
  title:       String?              -- New title (if changed)
  description: String?              -- New description (if changed)
  tags:        List<String>?        -- New tags (if changed)
  notes:       List<String>?        -- Notes to add during approval
  owners:      List<UUID>?          -- Owners to assign (if changed)
  moderators:  List<UUID>?          -- Moderators to assign (if changed)
}
```

## Business Rules

- Only users with ADMIN or PUBLISHER role may approve videos.
- The video must be in `DISCOVERED`, `SKIPPED`, or `FAILED` status.
- If `metadata_edits` is provided, the VideoRecord fields are updated before transitioning to `APPROVED`.

## Example Payload

```json
{
  "event_id": "g7h8i9j0-k1l2-3456-ghij-567890123456",
  "event_type": "VideoApproved",
  "timestamp": "2026-02-14T16:00:00Z",
  "video_record_id": "vr-001",
  "tenant_id": "t-001",
  "approved_by": "u-001",
  "previous_status": "DISCOVERED",
  "metadata_edits": {
    "title": "Weekly Product Standup - Feb 14, 2026",
    "description": "Sprint 42 progress review and blocker discussion.",
    "tags": ["standup", "product", "sprint-42"],
    "notes": ["Approved for external sharing - covers public roadmap items only"],
    "owners": ["u-001"],
    "moderators": ["u-001", "u-003"]
  }
}
```
