# ADR-012: YouTube Publish Integration

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-02-15 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The Video Bridge workflow currently transitions videos through `Discovered → Approved → Publishing → Published`, but the `Publishing → Published` step is manual — an operator clicks "Mark Published." There is no automated upload to a destination platform.

YouTube is the primary publish destination (PRD US-4). The system needs to:

1. Download the source recording (e.g., from Zoom's `download_url`).
2. Upload it to YouTube via the YouTube Data API v3.
3. Track upload progress and handle failures with retry.
4. Store the resulting YouTube video URL back on the record.

### Constraints

- YouTube Data API requires **OAuth 2.0 with user consent** (Authorization Code flow). Server-to-Server credentials cannot upload on behalf of a user's channel.
- YouTube enforces a **daily upload quota** (default 10,000 units; a video upload costs ~1,600 units, so roughly 6 uploads/day on default quota).
- Source recordings may be large (multi-GB), requiring streaming download → upload rather than buffering in memory.

## Decision

### 1. Destination Adapter

Implement a `YouTubeDestinationAdapter` behind a `DestinationAdapter` interface, mirroring the source adapter pattern from ADR-005:

```
interface DestinationAdapter {
  name: DestinationPlatform
  initialize(credentials: EncryptedCredentials): Promise<void>
  upload(params: UploadParams): AsyncGenerator<UploadProgress>
  getPublishedUrl(destinationId: string): string
}

interface UploadParams {
  title: string
  description: string
  tags: string[]
  sourceStream: ReadableStream
  privacyStatus: "private" | "unlisted" | "public"
}

interface UploadProgress {
  phase: "downloading" | "uploading" | "processing"
  bytesTransferred: number
  totalBytes: number | null
}
```

### 2. Upload Flow

When a video enters `Publishing` status:

1. **Download phase** — Stream the source recording from `download_url` into a temporary file (ADR-004 temporary storage). For Zoom, this requires a valid access token appended as a query parameter.
2. **Upload phase** — Use the YouTube Data API `videos.insert` endpoint with resumable upload protocol. Stream the file to YouTube in 8 MB chunks.
3. **Processing phase** — Poll `videos.list` until YouTube reports processing complete.
4. **Completion** — Emit `VideoPublished` event with the YouTube video ID and URL. Persist the destination URL and ID on the video record via `mark_published`.

If any phase fails, emit `VideoPublishFailed` and transition to `Failed` status with the error message. The operator can retry from the dashboard.

### 3. OAuth 2.0 for YouTube

YouTube requires user-delegated OAuth (Authorization Code flow with `https://www.googleapis.com/auth/youtube.upload` scope). This differs from Zoom's Server-to-Server flow:

- The `ConnectionsPanel` stores `client_id` and `client_secret` (already configured).
- A new `/api/youtube/auth` route initiates the OAuth consent flow and stores the resulting `refresh_token` server-side (per ADR-007).
- The `TokenManager` handles access token refresh before each upload.

### 4. Quota Management

- Track daily upload count in memory (reset at midnight PT, per YouTube quota cycle).
- Before starting an upload, check remaining quota. If exhausted, queue the video and surface a "quota exhausted" message on the dashboard.
- Log all API unit consumption for monitoring.

### 5. MVP Simplification

For the first iteration:

- Uploads are triggered manually (operator clicks "Publish"), not automatically.
- Privacy status defaults to `unlisted`.
- No concurrent uploads — one at a time to stay within quota.
- Progress is shown on the video card as a simple phase indicator (`Downloading... → Uploading... → Processing...`).
- Quota tracking is best-effort (in-memory counter, no persistence).

## Consequences

### Positive

- Completes the end-to-end ingestion → publish pipeline for the primary destination.
- Resumable upload protocol handles large files and network interruptions gracefully.
- `DestinationAdapter` interface allows future destinations (Kaltura, Vimeo) without changing the orchestrator.

### Negative

- YouTube's daily quota is restrictive on default API credentials; high-volume users need to apply for quota increases.
- User-consent OAuth is more complex than Server-to-Server; requires a browser redirect flow and secure refresh token storage.
- Streaming download → upload adds temporary disk usage proportional to video file size.

### Risks

- YouTube API quota changes or enforcement could break upload capacity without warning. Mitigation: monitor quota usage, alert when approaching limits.
- Zoom download URLs expire; the download must start promptly after entering `Publishing`. Mitigation: fetch a fresh download URL at upload time.
- Large files on slow connections may time out. Mitigation: resumable uploads allow retry from last successful chunk.

---

## Addendum: Privacy Status Tracking (2026-04-20)

### Problem

`privacyStatus` (public / unlisted / private) is sent to YouTube at upload time but never persisted on the `VideoRecord` or `PlatformLocation`. The Overview calendar shows every published video with the same red "YouTube" badge, so operators can't tell at a glance which videos are public vs. unlisted vs. private.

### Decision (MVP)

Add a **browser-side privacy cache** keyed by YouTube video ID:

```ts
// web/src/lib/youtubePrivacyCache.ts
localStorage["video-sync:yt-privacy"] = {
  [youtubeVideoId]: { privacy: "public" | "unlisted" | "private" | "unknown",
                      checked_at: ISO8601 }
}
```

Two endpoints populate the cache:

1. **Per-video**: `/api/youtube/status?videoId=...` — called from **Check Status** on a single VideoCard location. Returns `privacyStatus` alongside upload status. Cost: 1 quota unit per check.
2. **Bulk**: `POST /api/youtube/privacy-batch` with `{ videoIds: string[] }` — called from the **Fill privacy** button on the Overview header. Batches IDs into chunks of 50 (YouTube Data API max for `videos.list`) and returns `{ privacy: {id: status}, missing: string[] }`. Cost: 1 quota unit per 50 videos. Missing IDs (videos YouTube doesn't return) are cached as `unknown` so repeated Fill clicks don't keep re-querying them.

The `BackfillOverview` YouTube link badge reads from the cache and colours by privacy:

| Privacy  | Label     | Colour |
|----------|-----------|--------|
| public   | Public    | green  |
| unlisted | Unlisted  | yellow |
| private  | Private   | red    |
| unknown  | YouTube   | slate  |

### Why not store on PlatformLocation?

Persisting `privacy_status` on the Rust `PlatformLocation` aggregate would be the "proper" solution but requires:
- New Rust field + command + event (`UpdateLocationPrivacy`)
- WASM rebuild and binding regen
- Schema migration on the `VideoRecord` JSON

For MVP visibility the browser-side cache is sufficient. The data is idempotent and can be refreshed at any time by clicking Check Status. If the cache is lost (e.g. browser storage cleared), badges revert to "unknown" until the next status check.

### Future

Promote the cache to a `PlatformLocation.privacy_status` field when the WASM domain model gets its next schema bump. The `api/youtube/status` response path would then write both the cache and the aggregate, with the aggregate as the authoritative source.

## References

- ADR-004: Temporary Storage Strategy
- ADR-005: Source Platform Integration Strategy
- ADR-007: OAuth 2.0 Token Management
- ADR-011: MVP Credential Proxy Pattern
- [YouTube Data API — Resumable Uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
