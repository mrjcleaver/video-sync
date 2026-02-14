# Aggregate: VideoRecord

**Bounded Context:** [Catalog](../bounded-contexts/catalog.md)

## Description

The `VideoRecord` is the central aggregate root of the Catalog context. It represents a normalized view of a video from any source platform and tracks its lifecycle from discovery through curation and publishing. All videos land initially as checklist items awaiting curator review (see [ADR-009](../../adr/ADR-009-checklist-curation.md)).

## Entity Diagram

```
VideoRecord (Aggregate Root)
├── id: UUID
├── source_id: String
├── source_platform: SourcePlatform [VO]
├── title: String
├── description: String?
├── created_at: DateTime
├── duration_seconds: Integer
├── participants: List<String>
├── transcript_text: Text?
├── download_url: String
├── thumbnail_url: String?
├── tags: List<String>
├── notes: List<Note>                   -- Internal annotations added by curators
├── owners: List<UUID>                  -- Users responsible for this video's content
├── moderators: List<UUID>              -- Users who can manage/curate this video
├── metadata_extra: JSONB?
├── status: VideoStatus [VO]
├── curated_by: UUID?
├── curated_at: DateTime?
├── indexed_at: DateTime
├── published_at: DateTime?
├── destination_id: String?
├── destination_url: String?
└── search_vector: tsvector (computed)
```

## State Machine

```
  ┌──────────────┐   approve    ┌──────────────┐  PublishRequested  ┌──────────────┐
  │  DISCOVERED  │ ────────────>│   APPROVED   │ ─────────────────> │  PUBLISHING  │
  └──────┬───────┘              └──────────────┘                    └──────┬───────┘
         │                           ^     ^                               │
         │ skip                      │     │                               │
         v                           │     │ re-approve                    │
  ┌──────────────┐   approve         │     │                               │
  │   SKIPPED    │ ──────────────────┘     │                               │
  └──────────────┘                         │                               │
                                    ┌──────┴───────┐    PublishFailed      │
                                    │    FAILED    │ <─────────────────────┘
                                    └──────────────┘
                                                          PublishCompleted
                                                                │
  ┌──────────────┐                                              │
  │  PUBLISHED   │ <────────────────────────────────────────────┘
  └──────────────┘
```

### Status Definitions

| Status | Description |
|--------|-------------|
| `DISCOVERED` | Newly ingested from a source platform. Appears in the checklist awaiting curator review. |
| `APPROVED` | Curator has reviewed and approved for publishing. Eligible to be pushed to destinations. |
| `SKIPPED` | Curator has decided not to publish. Remains searchable but excluded from publish-ready views. Reversible. |
| `PUBLISHING` | Active transfer in progress (downloading from source, uploading to destination). |
| `PUBLISHED` | Successfully delivered to a destination platform. |
| `FAILED` | Transfer failed after exhausting retries. Can be re-approved to try again. |

## Business Rules

1. **Uniqueness**: `(source_id, source_platform)` must be unique. Attempting to index a duplicate triggers an update of mutable fields instead.
2. **Status Transitions**:
   - `DISCOVERED -> APPROVED`: When a curator approves the video.
   - `DISCOVERED -> SKIPPED`: When a curator skips the video.
   - `SKIPPED -> APPROVED`: When a curator reverses the skip decision.
   - `APPROVED -> PUBLISHING`: When a `PublishRequested` command is received.
   - `PUBLISHING -> PUBLISHED`: When a `PublishCompleted` event is received.
   - `PUBLISHING -> FAILED`: When a `PublishFailed` event is received.
   - `FAILED -> APPROVED`: When a curator re-approves for retry.
3. **Publish Gate**: Only videos in `APPROVED` status may be published. Attempting to publish a `DISCOVERED` or `SKIPPED` video is rejected.
4. **Search Vector**: Must be recomputed whenever `title`, `description`, `tags`, `participants`, `transcript_text`, or `notes` changes.
5. **Download URL Freshness**: The `download_url` may expire. Before publishing, the system must verify or refresh it via the source adapter.
6. **Ownership**: A video must have at least one owner. Owners are initially set from the meeting organizer or uploader from the source platform. Owners and moderators can be edited by any user with ADMIN role or by an existing owner/moderator of the video.
7. **Moderation**: Moderators can approve, skip, add notes, and edit metadata on videos they moderate. ADMIN users can moderate any video.

## Commands

| Command | Description | Preconditions |
|---------|-------------|---------------|
| `IndexVideo` | Create a VideoRecord with `DISCOVERED` status from a `VideoDiscovered` event | Valid `VideoDiscovered` payload |
| `ApproveVideo` | Transition to `APPROVED`, optionally edit metadata | Status is `DISCOVERED`, `SKIPPED`, or `FAILED`; user is ADMIN or PUBLISHER |
| `SkipVideo` | Transition to `SKIPPED` | Status is `DISCOVERED`; user is ADMIN or PUBLISHER |
| `BulkApprove` | Approve multiple videos in one operation | All videos in valid status for approval |
| `BulkSkip` | Skip multiple videos in one operation | All videos in `DISCOVERED` status |
| `RequestPublish` | Transition to `PUBLISHING` and create a PublishJob | Status is `APPROVED` |
| `MarkPublished` | Record destination info and transition to `PUBLISHED` | Status is `PUBLISHING`, valid destination data |
| `MarkFailed` | Record failure and transition to `FAILED` | Status is `PUBLISHING` |
| `UpdateMetadata` | Update mutable fields (title, description, tags) | Record exists, user is ADMIN or PUBLISHER |
| `AddNote` | Append an internal note to the video | Record exists, user is ADMIN, PUBLISHER, owner, or moderator |
| `AssignOwners` | Set or update the owners list | User is ADMIN or an existing owner |
| `AssignModerators` | Set or update the moderators list | User is ADMIN, or an existing owner/moderator |

## Queries

| Query | Description |
|-------|-------------|
| `GetChecklist(status_filter, page, page_size)` | Checklist view filtered by curation status |
| `GetChecklistCounts()` | Count of videos per status (for checklist section headers) |
| `SearchVideos(SearchQuery)` | Full-text search with filters, returns paginated results |
| `GetVideoById(id)` | Retrieve a single VideoRecord |
| `GetRecentVideos(limit, offset)` | Dashboard view of latest indexed videos |
| `GetVideosByPlatform(platform)` | Filter by source platform |
| `GetApprovedVideos(limit, offset)` | Videos ready to be pushed to destinations |
| `GetVideosByOwner(owner_id)` | All videos owned by a specific user |
| `GetVideosByModerator(moderator_id)` | All videos moderated by a specific user |
