# ADR-027: YouTube as a Source for Video Ingestion

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-03-14 |
| **Deciders** | Engineering |
| **Project** | VID-BRIDGE-01 |

## Context

The current source adapters (ADR-005) cover Zoom, Loom, and Fireflies — all recording-first platforms where the operator owns the video and wants to republish it. A new requirement has emerged: ingest videos that are **already hosted publicly on YouTube** (e.g. `https://www.youtube.com/live/jcipFgphFfI`). This includes live stream replays, channel uploads, and shared videos that the operator did not originate but wants to catalogue and re-process (trim, describe, republish to another destination).

This is meaningfully different from the existing YouTube integration (ADR-012), which treats YouTube as a **publish destination**. Here YouTube is a **source**.

### Key Constraints

| Constraint | Detail |
|-----------|--------|
| **API access** | YouTube Data API v3 `videos.list` retrieves metadata; actual video download is not provided by the official API |
| **Download** | `yt-dlp` (open source, actively maintained) is the de facto standard for downloading YouTube video streams |
| **Auth** | Public videos require no OAuth; unlisted/private videos require the channel owner's OAuth token |
| **Quota** | `videos.list` costs 1 unit per call; well within the 10,000 unit/day default |
| **Terms of service** | YouTube ToS §4B restricts automated download; operators must ensure they have rights to the content before ingesting |

---

## Decision

Implement a **YouTubeSourceAdapter** following the `SourceAdapter` interface from ADR-005. Ingestion is initiated manually by the operator pasting a YouTube URL — there is no background poller (YouTube does not offer a webhook for "new video on a channel I care about" without a PubSubHubbub subscription, which is deferred to Tier 2).

### 1. URL Parsing

Accept any of the standard YouTube URL formats:

| Format | Example |
|--------|---------|
| Standard watch | `https://www.youtube.com/watch?v=VIDEO_ID` |
| Short | `https://youtu.be/VIDEO_ID` |
| Live replay | `https://www.youtube.com/live/VIDEO_ID` |
| Embed | `https://www.youtube.com/embed/VIDEO_ID` |

Extract the `VIDEO_ID` from the URL on the client before making any API call.

### 2. Metadata Retrieval — YouTube Data API v3

Call `videos.list` with `part=snippet,contentDetails,status` to populate the video record:

| YouTube field | Maps to |
|--------------|---------|
| `snippet.title` | `title` |
| `snippet.description` | `description` |
| `snippet.publishedAt` | `recorded_at` |
| `snippet.channelTitle` | `source_metadata.channel` |
| `snippet.thumbnails.high.url` | `thumbnail_url` |
| `contentDetails.duration` | `duration_seconds` (ISO 8601 → seconds) |
| `status.privacyStatus` | `source_metadata.privacy` |
| `id` | `source_id` |

The API key used is the same server-side `GOOGLE_API_KEY` (or `GEMINI_API_KEY` if shared) already in Secret Manager. No OAuth is required for public videos.

### 3. Video Download — yt-dlp

The `download_url` field in the video record is set to the original YouTube URL. At publish time the system invokes `yt-dlp` server-side to download the video stream before passing it to the destination adapter upload pipeline (ADR-012):

```
yt-dlp --format "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]" \
       --output "/tmp/%(id)s.%(ext)s" \
       --no-playlist \
       "https://www.youtube.com/watch?v=VIDEO_ID"
```

`yt-dlp` is added as a system dependency in the Dockerfile:

```dockerfile
RUN apk add --no-cache yt-dlp ffmpeg
```

`ffmpeg` is required by `yt-dlp` to merge separate video and audio streams.

### 4. Ingestion UX

The existing "Import" panel gains a **YouTube URL** input field alongside the existing Zoom/Loom/Fireflies import flows. On paste:

1. Client parses the video ID from the URL.
2. Client calls `GET /api/youtube/video-info?videoId=VIDEO_ID`.
3. API route calls `videos.list`, returns title, thumbnail, duration, channel.
4. A preview card is shown (matching ADR-020 import preview pattern).
5. Operator confirms → record created in `Discovered` state.

### 5. Deduplication

`source_id` is set to the YouTube video ID. If a record with the same `source_id` and `source = "youtube"` already exists, the import is rejected with a "already in catalogue" message.

### 6. Out of Scope (Tier 2)

- **Channel polling**: automatically discover new uploads from a subscribed channel via PubSubHubbub.
- **Playlist import**: bulk-import all videos from a playlist URL.
- **Private/unlisted video support**: requires channel owner OAuth token flow.
- **Transcript import**: YouTube auto-captions are available via `yt-dlp --write-auto-sub`; deferred pending ADR-009 search integration.

---

## Consequences

### Positive

- Unlocks a large corpus of existing YouTube content as a source without requiring re-upload from the operator.
- `yt-dlp` handles format negotiation, throttling, and geo-restriction workarounds automatically.
- Metadata preview (ADR-020 pattern) gives the operator a confirmation step before committing a record.
- No new OAuth flow for public videos — the existing API key covers metadata lookup.

### Negative

- `yt-dlp` is a third-party binary dependency; YouTube periodically changes their internal API, requiring `yt-dlp` updates. Pin to a specific version in the Dockerfile and set a Dependabot alert.
- Download time for long videos (livestream replays can be hours) blocks the Cloud Run request. Mitigation: move download to an async job (ADR-003 queue, Tier 2); for MVP download is triggered at publish time, consistent with the existing Zoom flow.
- Adding `yt-dlp` + `ffmpeg` to the Docker image increases image size by ~60 MB.

### Risks

- **ToS compliance**: operators must have rights to the content they ingest. The UI should display a confirmation checkbox: _"I have the rights to download and republish this video."_
- **Rate limiting / bot detection**: YouTube may throttle or block the Cloud Run egress IP. Mitigation: `yt-dlp` supports cookies and proxy configuration; expose as advanced operator settings if needed.
- **URL rot**: YouTube video IDs are stable, but videos can be deleted or made private after ingestion. The `download_url` (YouTube URL) should be validated at publish time, not stored as a permanent download link.

---

## Implementation Steps

| Step | Action | Owner |
|------|--------|-------|
| 1 | Add `yt-dlp` and `ffmpeg` to `Dockerfile` | Engineering |
| 2 | Implement `GET /api/youtube/video-info` route using `videos.list` | Engineering |
| 3 | Add YouTube URL input + preview card to Import panel (ADR-020 pattern) | Engineering |
| 4 | Implement `YouTubeSourceAdapter.fetchMetadata(videoId)` | Engineering |
| 5 | Wire `source = "youtube"` deduplication check on import | Engineering |
| 6 | At publish time, replace `download_url` fetch with `yt-dlp` subprocess call | Engineering |
| 7 | Add ToS acknowledgement checkbox to import confirmation | Engineering |
| 8 | Update Dockerfile, rebuild and redeploy to Cloud Run (ADR-018/ADR-026) | Engineering |

---

## References

- ADR-005: Source Platform Integration Strategy
- ADR-012: YouTube Publish Integration (YouTube as destination — complementary)
- ADR-018: Google Cloud Hosting
- ADR-020: Import UX — Preview, Title, and Destination
- ADR-026: Production Domain (videosync.agentics.org)
- [YouTube Data API v3 — videos.list](https://developers.google.com/youtube/v3/docs/videos/list)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
