# Bounded Context: Catalog

## Purpose

The Catalog Context owns the unified video index. It normalizes incoming video discovery events into a searchable `VideoRecord` aggregate and provides full-text search across all indexed content.

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
  status:            VideoStatus                   -- INDEXED | PUBLISHING | PUBLISHED | FAILED
  indexed_at:        DateTime (UTC)
  published_at:      DateTime (UTC, nullable)
  destination_id:    String (nullable)
  destination_url:   String (nullable)
  search_vector:     tsvector                      -- Computed full-text search vector
}
```

**Invariants:**
- `source_id` + `source_platform` is unique (no duplicate indexing).
- `status` transitions follow the lifecycle: `INDEXED -> PUBLISHING -> PUBLISHED` or `INDEXED -> PUBLISHING -> FAILED -> INDEXED` (after retry).
- `search_vector` is recomputed on any change to `title`, `description`, `tags`, `participants`, or `transcript_text`.

### Value Objects

```
SourcePlatform: Enum(ZOOM, LOOM, FIREFLIES)

VideoStatus: Enum(INDEXED, PUBLISHING, PUBLISHED, FAILED)

SearchQuery {
  text:             String                         -- Full-text search term
  source_filter:    SourcePlatform (nullable)
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
2. If new, creates a `VideoRecord` with status `INDEXED`.
3. If existing, updates mutable fields (title, description, transcript, download_url).
4. Recomputes `search_vector`.
5. Emits `VideoIndexed` event.

### SearchService

Executes full-text search queries against the catalog:

1. Translates `SearchQuery` into a PostgreSQL `tsquery` with filters.
2. Ranks results using `ts_rank_cd` against the weighted `search_vector`.
3. Returns paginated `SearchResult`.

## Domain Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `VideoDiscovered` | Consumed (from Ingestion) | Full discovery payload |
| `VideoIndexed` | Produced | `video_record_id`, `source_platform`, `title` |
| `PublishCompleted` | Consumed (from Publishing) | `video_record_id`, `destination_id`, `destination_url` |
| `PublishFailed` | Consumed (from Publishing) | `video_record_id`, `error_message` |

## Read Models

### Dashboard View
A denormalized read model optimized for the dashboard (US-1):
- Recent recordings grouped by source platform.
- Publication status indicators.
- Quick-search bar.

## External Dependencies

- PostgreSQL (storage + full-text search)
- Ingestion Context (via events)
- Publishing Context (via events for status updates)
