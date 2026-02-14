# ADR-002: Unified Video Metadata Schema

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-02-14 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

Videos from Zoom, Loom, and Fireflies each have different metadata structures:

- Zoom provides meeting ID, topic, start time, duration, participants, and download URLs for MP4/VTT files.
- Loom provides video ID, title, creation date, owner, and a download URL.
- Fireflies provides meeting ID, title, date, participants, transcript text, and an AI-generated summary.

The indexing engine and publishing workflow need a **single, normalized representation** to avoid coupling downstream consumers to source-specific schemas. The PRD specifies required fields: `Source_ID`, `Source_Platform`, `Created_At`, `Duration`, `Participants`, and `Transcript_Text`.

## Decision

We will define a **Unified Video Metadata** aggregate with the following canonical schema:

```
VideoRecord {
  id:               UUID                          -- Internal identifier
  source_id:        String                        -- Original ID from source (e.g., "zoom-12345")
  source_platform:  Enum(ZOOM, LOOM, FIREFLIES)   -- Origin platform
  title:            String                        -- Video/meeting title
  description:      String (nullable)             -- Description or AI summary
  created_at:       DateTime (UTC)                -- When the recording was made
  duration_seconds: Integer                       -- Duration in seconds
  participants:     List<String>                  -- Participant names/emails
  transcript_text:  Text (nullable)               -- Full transcript content
  download_url:     String                        -- Temporary URL to source media
  thumbnail_url:    String (nullable)             -- Thumbnail if available
  tags:             List<String>                  -- User-assigned or auto-generated tags
  status:           Enum(INDEXED, PUBLISHING, PUBLISHED, FAILED)
  indexed_at:       DateTime (UTC)                -- When we indexed it
  published_at:     DateTime (UTC, nullable)      -- When publishing completed
  destination_id:   String (nullable)             -- ID on the destination platform
  destination_url:  String (nullable)             -- Public URL on destination
}
```

Each source adapter is responsible for mapping its native schema into this canonical form. Fields that a source does not provide are set to null.

## Consequences

### Positive
- All downstream consumers (search, UI dashboard, publishing) work with a single schema.
- Adding a new source platform requires only a new mapper — no schema migration.
- The schema supports the full lifecycle from ingestion through publishing.

### Negative
- Lossy normalization: source-specific fields (e.g., Zoom breakout room info, Fireflies action items) are not captured unless we extend the schema or add a `metadata_extra` JSON field.
- The `download_url` field is ephemeral — source platforms may expire these URLs, requiring re-fetching.

### Mitigations
- Include a `metadata_extra: JSONB` column for source-specific overflow data that does not fit the canonical schema.
- The ingestion layer should refresh `download_url` just before a publish operation begins.
