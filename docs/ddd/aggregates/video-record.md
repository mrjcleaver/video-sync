# Aggregate: VideoRecord

**Bounded Context:** [Catalog](../bounded-contexts/catalog.md)

## Description

The `VideoRecord` is the central aggregate root of the Catalog context. It represents a normalized view of a video from any source platform and tracks its lifecycle from indexing through publishing.

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
├── metadata_extra: JSONB?
├── status: VideoStatus [VO]
├── indexed_at: DateTime
├── published_at: DateTime?
├── destination_id: String?
├── destination_url: String?
└── search_vector: tsvector (computed)
```

## State Machine

```
                 ┌──────────────┐
                 │   INDEXED    │ <───────────────────┐
                 └──────┬───────┘                     │
                        │ PublishRequested             │ retry
                        v                             │
                 ┌──────────────┐              ┌──────┴───────┐
                 │  PUBLISHING  │ ────────────>│    FAILED     │
                 └──────┬───────┘              └──────────────┘
                        │ PublishCompleted
                        v
                 ┌──────────────┐
                 │  PUBLISHED   │
                 └──────────────┘
```

## Business Rules

1. **Uniqueness**: `(source_id, source_platform)` must be unique. Attempting to index a duplicate triggers an update of mutable fields instead.
2. **Status Transitions**:
   - `INDEXED -> PUBLISHING`: Only when a `PublishRequested` command is received.
   - `PUBLISHING -> PUBLISHED`: Only when a `PublishCompleted` event is received.
   - `PUBLISHING -> FAILED`: When a `PublishFailed` event is received.
   - `FAILED -> INDEXED`: When a user retries or the error is resolved.
3. **Search Vector**: Must be recomputed whenever `title`, `description`, `tags`, `participants`, or `transcript_text` changes.
4. **Download URL Freshness**: The `download_url` may expire. Before publishing, the system must verify or refresh it via the source adapter.

## Commands

| Command | Description | Preconditions |
|---------|-------------|---------------|
| `IndexVideo` | Create or update a VideoRecord from a `VideoDiscovered` event | Valid `VideoDiscovered` payload |
| `RequestPublish` | Transition to PUBLISHING state and create a PublishJob | Status is INDEXED or FAILED |
| `MarkPublished` | Record destination info and transition to PUBLISHED | Status is PUBLISHING, valid destination data |
| `MarkFailed` | Record failure and transition to FAILED | Status is PUBLISHING |
| `UpdateMetadata` | Update mutable fields (title, description, tags) | Record exists |

## Queries

| Query | Description |
|-------|-------------|
| `SearchVideos(SearchQuery)` | Full-text search with filters, returns paginated results |
| `GetVideoById(id)` | Retrieve a single VideoRecord |
| `GetRecentVideos(limit, offset)` | Dashboard view of latest indexed videos |
| `GetVideosByPlatform(platform)` | Filter by source platform |
