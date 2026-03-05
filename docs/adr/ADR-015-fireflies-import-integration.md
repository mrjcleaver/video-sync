# ADR-015: Fireflies.ai Import Integration

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-03-05 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

Fireflies.ai is an AI meeting-notes platform that records, transcribes, and summarises video/audio meetings. Unlike Zoom (REST, OAuth2 Server-to-Server), Fireflies exposes a **GraphQL API** authenticated with a simple API key. It has no video download URL suitable for re-publishing; its value in this system is:

1. **Transcript text** — Fireflies auto-transcribes every meeting; this feeds directly into `transcript_text` on the VideoRecord, enabling `transcript_extract` and `transcript_llm` processing rules (ADR-014).
2. **AI summary** — Fireflies generates `overview`, `gist`, `action_items`, and `outline` summaries that can pre-populate `description`.
3. **Speakers / participants** — named speaker list maps to `participants`.
4. **Meeting link** — Fireflies stores a `meeting_link` (e.g. Zoom join URL) and records an `audio_url` / `video_url` for the meeting file hosted on its own CDN.

ADR-011 established the credential-proxy pattern: credentials live in `localStorage`, are sent in the POST body to a same-origin Next.js route, and are never persisted server-side. ADR-005 sketched the Fireflies adapter at an architectural level. This ADR specifies the concrete MVP implementation following the same pattern as the Zoom import (ADR-011).

---

## Decision

### 1. Credential Storage

Fireflies uses a single **API key** (no OAuth exchange). The existing `ConnectionsPanel` already has an `apiKey` field defined for the Fireflies entry. The key is sent in the POST body to `/api/fireflies/transcripts` — identical to how Zoom credentials flow.

No new credential infrastructure is needed.

### 2. API Route: `/api/fireflies/transcripts`

A new Next.js API route accepts:

```ts
POST /api/fireflies/transcripts
Body: {
  apiKey: string;      // Fireflies API key
  from:   string;      // ISO date "YYYY-MM-DD"
  to:     string;      // ISO date "YYYY-MM-DD"
}
```

It calls the Fireflies GraphQL endpoint (`https://api.fireflies.ai/graphql`) with:

```graphql
query GetTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
    id
    title
    date
    duration
    organizer_email
    participants
    speakers { name }
    meeting_link
    audio_url
    video_url
    summary {
      gist
      overview
      action_items
      outline
    }
    sentences {
      speaker_name
      text
      start_time
    }
  }
}
```

Pagination: Fireflies returns a maximum of 50 transcripts per query. The route loops with `skip` increments until fewer than `limit` results are returned (i.e. last page).

Date variables are sent as **millisecond timestamps** (Fireflies requires ms, not ISO strings):
```
fromDate = new Date(from).setHours(0, 0, 0, 0)
toDate   = new Date(to).setHours(23, 59, 59, 999)
```

The route returns normalised records (see §4) ready for direct import — the client does not need to transform them.

### 3. UI: `FirefliesImport` Component

Mirrors `ZoomImport` in structure:

- Date-range pickers (`from` / `to`) defaulting to the last 30 days
- "Fetch Transcripts" button → POST to `/api/fireflies/transcripts`
- Filterable list of results (by title, minimum duration in minutes, day of week)
- Checkbox multi-select → "Import Selected" → creates `WasmVideoRecord` per item
- Integrated into `page.tsx` alongside `ZoomImport`

### 4. Field Mapping

Fireflies and the VideoRecord schema use different field names and conventions. The normalisation happens server-side in the API route before returning to the client.

| Fireflies field | VideoRecord field | Notes |
|----------------|-------------------|-------|
| `id` | `source_id` | Prefixed: `"fireflies-{id}"` |
| *(constant)* | `source_platform` | `"Fireflies"` |
| `title` | `title` | Direct. Fireflies often uses calendar invite title — acceptable as-is. |
| `date` | `recorded_at` | Fireflies `date` is a Unix timestamp in **milliseconds**. Convert: `new Date(date).toISOString()`. |
| `duration` | `duration_seconds` | Fireflies `duration` is in **minutes**. Multiply by 60. |
| `participants` | `participants` | Array of email strings. Direct. |
| `speakers[].name` | *(merged)* | Speaker names (not emails) — merged with `participants` after deduplication; names without matching email kept as-is. |
| `organizer_email` | `participants[0]` (prepended) | Ensures the host appears first in the participants list. |
| `summary.overview` | `description` | Primary choice. Falls back to `summary.gist` if `overview` is absent. |
| `summary.gist` | `description` fallback | One-sentence summary. Used if `overview` is empty. |
| `summary.action_items` | `metadata_extra.action_items` | Not in canonical schema; stored as JSON overflow for future use. |
| `summary.outline` | `metadata_extra.outline` | Same. |
| `sentences[].text` joined | `transcript_text` | All sentence texts joined with `" "` — same plain-text format as Zoom VTT output. Speaker attribution preserved by prepending `"[{speaker_name}] "` before each turn boundary. |
| `audio_url` | `download_url` | Primary. Fireflies CDN URL for the audio file. |
| `video_url` | `download_url` | Preferred over `audio_url` if non-null (video is more useful for YouTube publishing). |
| `meeting_link` | `metadata_extra.meeting_link` | The originating Zoom/Meet/Teams URL — not a download URL. Stored for reference only. |
| *(absent)* | `thumbnail_url` | Fireflies provides no thumbnail. Set to `null`. |
| *(constant)* | `tags` | `["fireflies-import"]` as baseline; ingestion rules (ADR-013) may add more. |

#### Alignment notes

**`duration` units mismatch** — Fireflies returns minutes; Zoom returns minutes too (same); VideoRecord stores seconds. Both adapters multiply by 60. Consistent.

**`date` as milliseconds vs ISO string** — Fireflies `date` is a Unix ms timestamp (e.g. `1707004800000`). Zoom uses ISO strings (`"2026-02-03T14:00:00Z"`). The route converts Fireflies ms → ISO string so `recorded_at` is always an ISO 8601 string. Consistent.

**Transcript already populated at import** — Unlike Zoom (where transcript requires a separate "Load Transcript" API call), Fireflies returns full sentence data in the listing query. `transcript_text` is populated at import time with no follow-up step needed. The "Load Transcript" button visible on Zoom cards should not appear on Fireflies cards (controlled by `source_platform`).

**Description pre-populated** — Fireflies `summary.overview` fills `description` immediately. This means `transcript_extract` processing rules provide marginal additional value; `transcript_llm` is still useful for a higher-quality rewrite of the Fireflies-generated summary.

**`speakers` vs `participants`** — Fireflies distinguishes *participants* (email addresses of invitees) from *speakers* (names of people who actually spoke, identified by voice). In practice, not all speakers have matching emails. The mapping strategy:
1. Start with `organizer_email` as `participants[0]`.
2. Append remaining `participants` (email strings).
3. Append any `speakers[].name` values not already represented by an email match (best-effort deduplication by lowercased name substring).

**`metadata_extra`** — The VideoRecord Rust aggregate currently has no `metadata_extra` field. The `action_items` and `outline` fields are high-value (for YouTube description enrichment and rule matching) but out of scope for this ADR. A follow-up ADR or minor schema extension will add `metadata_extra: Option<serde_json::Value>` to the aggregate. For the MVP, these fields are silently dropped.

### 5. No Re-Publish of Fireflies Audio

Fireflies CDN URLs (`audio_url`, `video_url`) are time-limited and are not suitable for direct YouTube upload without a server-side download-and-re-upload pipeline. For the MVP, the `download_url` is stored for reference but the VideoCard publish flow should warn if a Fireflies record is selected for YouTube upload:

> "Fireflies audio/video URLs expire. Download the file from Fireflies and upload manually, or connect the source Zoom meeting instead."

YouTube publishing of Fireflies-originated content is deferred to Tier 2 (server-side download buffer — ADR-004).

### 6. Credential Proxy Pattern (same as ADR-011)

```
Browser                     Next.js route              Fireflies API
  │── POST /api/fireflies/ ─►│── POST /graphql ────────►│
  │   { apiKey, from, to }   │   Authorization: Bearer   │
  │◄── normalised records ───│◄── raw transcript data ───│
```

The API key is not logged, not stored, and not forwarded outside the same-origin pair. Same XSS caveat as ADR-011 applies.

---

## Consequences

### Positive

- Operators with Fireflies accounts get immediate import with transcript + summary pre-filled — zero additional "Load Transcript" clicks.
- Reuses the same date-range import UX as Zoom; minimal learning curve.
- Processing rules (ADR-014) work immediately against Fireflies records since `transcript_text` is populated at import.
- No OAuth exchange — simpler authentication flow than Zoom.

### Negative

- Fireflies CDN URLs for audio/video expire; direct YouTube publish is not possible without a download buffer.
- The GraphQL `sentences` join to produce `transcript_text` can be large (many thousands of words). Transferring this through the Next.js route for every import is acceptable at MVP scale but should be lazy-loaded or cached at Tier 2.
- Speaker attribution in `transcript_text` (e.g. `"[Alice] Hello, today we …"`) may appear verbatim in YouTube descriptions if `transcript_extract` mode is used. The operator should preview before publishing.
- `metadata_extra` (action items, outline) is dropped in the MVP — a known limitation.

### Risks

- **Fireflies GraphQL schema changes** — no compile-time safety. Mitigate with a response validator that checks required fields before normalisation.
- **API key exposure via XSS** — same risk as ADR-011; mitigated at Tier 2 by moving credentials server-side (ADR-007).
- **Rate limits** — Fireflies imposes undocumented rate limits on the GraphQL API. Pagination with `skip` may fail for large date ranges. Mitigate by showing per-page import rather than fetching all at once if the result count is high.

---

## Implementation Plan

| Step | Scope |
|------|-------|
| **1** | `/api/fireflies/transcripts` route — GraphQL query, pagination, normalisation |
| **2** | `FirefliesImport` component — date range, fetch, filter, multi-select, import |
| **3** | Add `source_platform === "Fireflies"` guard to hide "Load Transcript" button in VideoCard |
| **4** | Warn on VideoCard if Fireflies record is sent to YouTube publish |
| **5** | *(Tier 2)* Add `metadata_extra` to VideoRecord aggregate for action items / outline |
| **6** | *(Tier 2)* Server-side download buffer for Fireflies CDN video files → YouTube upload |

---

## References

- [Fireflies GraphQL API docs](https://docs.fireflies.ai/)
- ADR-002: Unified Video Metadata Schema
- ADR-004: Temporary Storage Strategy (server-side download buffer)
- ADR-005: Source Platform Integration Strategy
- ADR-007: OAuth2 Token Management
- ADR-011: MVP Credential Proxy Pattern
- ADR-013: Batch Ingestion Rules Engine
- ADR-014: Publishing Attribute Processing Rules
