I# ADR-022: YouTube Description Provenance Footer

Date: 2026-03-06
Status: Accepted

## Context

When a video is published to YouTube, the provenance chain (which Fireflies transcript it came from, which Zoom recording that matched, the session UUID in our catalog) exists only in our local catalog. If the catalog is lost, reset, or accessed from a different device, that linkage is gone.

YouTube's Data API v3 does **not** offer a dedicated custom metadata / properties field on video resources. The available fields are:

| Field | Max length | Visible to viewers | Usable for metadata |
|---|---|---|---|
| `snippet.title` | 100 chars | Yes | No — audience-facing |
| `snippet.description` | 5,000 chars | Collapsed after first line | **Yes — footer approach** |
| `snippet.tags[]` | 500 chars total | Shown in search/studio | Limited — short tokens only |
| `recordingDetails.locationDescription` | free text | Studio only | Possible but semantically wrong |
| `localizations` | per-language title+description | No | No |

The `description` field is the standard convention across the YouTube ecosystem for embedding structured metadata (chapters, credits, links). Content past the first ~125 characters is hidden behind a "Show more" fold, so a machine-readable footer has no impact on viewer experience.

Other platforms use the same pattern:
- YouTube chapters use `0:00 Title` lines in the description
- Creator tools embed affiliate codes, social links, and timestamps as structured text blocks

## Decision

When publishing a video via `/api/youtube/upload`, append a provenance footer to the description. The footer is separated from the user-facing description by a horizontal rule and contains:

```
---
video-sync provenance
catalog_id: a550179a-f809-4c7c-9455-4f345ab31c5c
source: Fireflies · fireflies-abc123def456
upstream: Zoom · zoom-//abcd==
published: 2026-03-06T17:00:00Z
```

The footer is built client-side in `VideoCard.publishToYouTube()` from the video record's `id`, `source_id`, `source_platform`, and `upstream_links` before the upload body is sent to the server. The server route receives it as part of the `description` field — no server changes are needed.

### What this enables

1. **Re-import from YouTube**: A future tool can read a video's description, parse the footer, and reconstruct the catalog entry including provenance links.
2. **Audit trail**: The YouTube video itself documents where it came from, independent of our local store.
3. **Deduplication**: Before uploading, we can search for existing YouTube videos whose description footer contains our `catalog_id` to detect prior uploads without querying our local store.

### What this does not replace

The local catalog remains the authoritative source. The footer is a durable hint, not the primary record. The `locations` array and `upstream_links` in the domain model (ADR-019) continue to be the source of truth.

## Format

```
\n\n---\nvideo-sync | catalog:{id} | source:{platform}:{source_id}{upstream_line}
```

Where `upstream_line` is omitted if no upstream links exist, or:
```
 | upstream:{platform}:{external_id}
```
for each upstream link (one per line if multiple).

The `---` separator ensures the footer is visually distinct in YouTube Studio and in any plain-text view of the description.

## Consequences

- Descriptions longer than 5,000 characters (after appending the footer) will be silently truncated by YouTube. The footer is appended last, so if the user description is very long, the footer may be dropped. This is acceptable — the catalog is the primary record.
- The footer is visible to anyone who clicks "Show more" on the YouTube video. This is intentional — provenance should be transparent.
- Tags remain unchanged. We do not embed source IDs in tags (they are audience-facing and would appear in search).
