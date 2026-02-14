# ADR-006: Search Engine for Full-Text Video Search

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-02-14 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The PRD requires full-text search against video titles, descriptions, and transcripts (FR 5.2). Transcripts can be large (multi-hour meetings produce tens of thousands of words). The search must support:

- Full-text search with relevance ranking.
- Filtering by `source_platform`, `created_at` range, and `participants`.
- Fast response times (< 500ms) for dashboard queries.
- Scaling to tens of thousands of indexed videos.

## Decision

We will use **PostgreSQL with full-text search (tsvector/tsquery)** as the primary search engine for the initial release, with a clear migration path to Elasticsearch if scale demands it.

### Rationale

1. **PostgreSQL FTS** is sufficient for the initial scale (tens of thousands of documents) and avoids adding a separate search infrastructure dependency.
2. The `VideoRecord` table will include a `search_vector: tsvector` column that is a weighted composite of:
   - **A weight (highest)**: `title`
   - **B weight**: `description`, `tags`
   - **C weight**: `participants`
   - **D weight (lowest)**: `transcript_text`
3. A GIN index on `search_vector` provides fast full-text lookups.
4. A trigger or application-level hook updates the `search_vector` on insert/update.

### Migration Path to Elasticsearch

If the dataset grows beyond PostgreSQL FTS performance thresholds (estimated at 500K+ records with large transcripts), we will:
- Deploy an Elasticsearch cluster.
- Add a `SearchIndexer` that subscribes to `VideoIndexed` domain events and syncs to ES.
- Swap the search query path behind a `SearchService` interface — no UI or API changes needed.

## Consequences

### Positive
- No additional infrastructure for the initial deployment — PostgreSQL serves both storage and search.
- Weighted search vectors ensure titles rank higher than transcript mentions.
- GIN indexes provide sub-second query performance at moderate scale.

### Negative
- PostgreSQL FTS lacks some advanced features (fuzzy matching, "did you mean", faceted search) available in Elasticsearch.
- Very large transcripts may impact indexing performance and storage.

### Alternatives Considered
- **Elasticsearch from day one**: Rejected for initial release — adds significant infrastructure complexity (cluster management, data synchronization) before we know the actual scale.
- **Meilisearch/Typesense**: Considered as lightweight alternatives. Valid option but PostgreSQL FTS avoids an extra service entirely.
