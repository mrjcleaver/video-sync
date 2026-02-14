# Bounded Context: Catalog

## Purpose

The Catalog Context owns the unified video index and the **curation checklist** (see [ADR-009](../../adr/ADR-009-checklist-curation.md)). It normalizes incoming video discovery events into a searchable `VideoRecord` aggregate, presents them in a checklist for curator review, and provides full-text search across all indexed content. Only videos that have been explicitly **approved** through the checklist are eligible for publishing.

## Aggregates

### VideoRecord

The central entity representing a video in the system. This is the aggregate root.

```
VideoRecord {
  id:                UUID                          -- Internal identifier
  source_id:         String                        -- Original ID from source
  source_platform:   SourcePlatform                -- ZOOM | LOOM | FIREFLIES
  title:             String
  description:       String (nullable)
  created_at:        DateTime (UTC)
  duration_seconds:  Integer
  participants:      List<String>
  transcript_text:   Text (nullable)
  download_url:      String
  thumbnail_url:     String (nullable)
  tags:              List<String>
  metadata_extra:    JSONB (nullable)              -- Source-specific overflow
  status:            VideoStatus                   -- DISCOVERED | APPROVED | SKIPPED | PUBLISHING | PUBLISHED | FAILED
  curated_by:        UUID (nullable)               -- User who approved/skipped
  curated_at:        DateTime (UTC, nullable)       -- When curation action occurred
  indexed_at:        DateTime (UTC)
  published_at:      DateTime (UTC, nullable)
  destination_id:    String (nullable)
  destination_url:   String (nullable)
  search_vector:     tsvector                      -- Computed full-text search vector
}
```

**Invariants:**
- `source_id` + `source_platform` is unique (no duplicate indexing).
- `status` transitions follow the curation lifecycle (ADR-009): `DISCOVERED -> APPROVED -> PUBLISHING -> PUBLISHED`, with `DISCOVERED -> SKIPPED` (reversible) and `PUBLISHING -> FAILED -> APPROVED` (retry).
- Only videos in `APPROVED` status may be published.
- `search_vector` is recomputed on any change to `title`, `description`, `tags`, `participants`, or `transcript_text`.

### Value Objects

```
SourcePlatform: Enum(ZOOM, LOOM, FIREFLIES)

VideoStatus: Enum(DISCOVERED, APPROVED, SKIPPED, PUBLISHING, PUBLISHED, FAILED)

SearchQuery {
  text:             String                         -- Full-text search term
  source_filter:    SourcePlatform (nullable)
  status_filter:    VideoStatus (nullable)         -- Filter by curation status
  date_from:        DateTime (nullable)
  date_to:          DateTime (nullable)
  participant:      String (nullable)
  page:             Integer (default: 1)
  page_size:        Integer (default: 20, max: 100)
}

SearchResult {
  records:          List<VideoRecord>
  total_count:      Integer
  page:             Integer
  page_size:        Integer
}
```

## Domain Services

### VideoIndexer

Consumes `VideoDiscovered` events and creates or updates `VideoRecord` entries:

1. Checks for existing record by `source_id` + `source_platform`.
2. If new, creates a `VideoRecord` with status `DISCOVERED` (lands in the curation checklist).
3. If existing, updates mutable fields (title, description, transcript, download_url).
4. Recomputes `search_vector`.
5. Emits `VideoIndexed` event.

### CurationService

Manages the checklist workflow (ADR-009):

1. **Approve**: Transitions a video from `DISCOVERED` / `SKIPPED` / `FAILED` to `APPROVED`. Optionally applies metadata edits (title, description, tags). Emits `VideoApproved`.
2. **Skip**: Transitions a video from `DISCOVERED` to `SKIPPED`. Emits `VideoSkipped`.
3. **Bulk Approve/Skip**: Applies the same action to multiple selected videos in one operation.
4. Only users with ADMIN or PUBLISHER role may curate.

### SearchService

Executes full-text search queries against the catalog:

1. Translates `SearchQuery` into a PostgreSQL `tsquery` with filters.
2. Ranks results using `ts_rank_cd` against the weighted `search_vector`.
3. Returns paginated `SearchResult`.
4. Supports filtering by `status_filter` to show checklist views (e.g., only `DISCOVERED` for the review queue).

## Domain Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `VideoDiscovered` | Consumed (from Ingestion) | Full discovery payload |
| `VideoIndexed` | Produced | `video_record_id`, `source_platform`, `title` |
| `VideoApproved` | Produced (curation action) | `video_record_id`, `approved_by`, `metadata_edits` |
| `VideoSkipped` | Produced (curation action) | `video_record_id`, `skipped_by`, `reason` |
| `PublishCompleted` | Consumed (from Publishing) | `video_record_id`, `destination_id`, `destination_url` |
| `PublishFailed` | Consumed (from Publishing) | `video_record_id`, `error_message` |

## Read Models

### Curation Checklist View
The primary read model, optimized for the checklist workflow (ADR-009):
- **Needs Review**: Videos in `DISCOVERED` status, sorted by `created_at` descending.
- **Approved**: Videos in `APPROVED` status, ready to publish.
- **Published**: Videos in `PUBLISHED` status, with destination links.
- **Skipped**: Collapsed section of `SKIPPED` videos (reversible).
- Counts per section for at-a-glance triage.
- Bulk selection controls for approve/skip/publish actions.

### Dashboard View
A denormalized read model optimized for the dashboard (US-1):
- Recent recordings grouped by source platform.
- Curation status distribution (how many need review, approved, published).
- Quick-search bar.

## External Dependencies

- PostgreSQL (storage + full-text search)
- Ingestion Context (via events)
- Publishing Context (via events for status updates)
