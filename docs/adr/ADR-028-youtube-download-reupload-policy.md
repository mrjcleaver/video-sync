# ADR-028: YouTube Download and Re-upload Policy

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-03-15 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-012 (YouTube publish), ADR-027 (YouTube source ingestion), ADR-025 (Loom source) |

---

## Context

The system needs to move videos that were published to YouTube on the *wrong channel* — typically a team member who livestreamed or uploaded to a personal or incorrect organisational channel. The canonical workflow is:

1. Discover the video on YouTube (ADR-027 — source ingestion via URL).
2. Download the video file to ephemeral storage.
3. Optionally apply pre-processing rules (e.g. trim to boundary — ADR-023).
4. Re-upload to the correct destination channel or platform (ADR-012).
5. Record full provenance of the move (ADR-019, ADR-022).

This ADR governs the download step — the rights model, tooling choice, compliance gates, and provenance requirements.

---

## Decision

### 1. Rights Model

Downloads are only performed when the operator holds an **explicit licence or ownership right** over the content. The primary use case is *own content published to the wrong channel*; the secondary use case is *content for which a written licence grant exists*.

The system does not adjudicate rights. It exposes a **ToS/rights checkbox** that the operator must tick before any download-then-reupload pipeline is initiated. No free-text justification field is required — the checkbox serves as the operator's affirmative assertion.

### 2. Scope — YouTube only

This policy covers **YouTube as source** only.

- **Loom**: supports direct URL-based re-upload (no download needed) — governed by ADR-025.
- **Zoom, Fireflies, Kaltura**: use native API downloads authenticated by the operator's own credentials — no separate policy needed.
- **Other platforms** (e.g. Vimeo, VEED.io integration): to be addressed in future ADRs as needs emerge.

### 3. Download Tooling — yt-dlp with Netscape Cookies

**yt-dlp** is the accepted download tool. Rationale:

| Concern | Resolution |
|---------|------------|
| YouTube bot-detection blocks automated IPs | Operator supplies their own Netscape-format session cookies (`ytCookies` credential field). yt-dlp passes `--cookies <tmpfile>`. |
| YouTube Data API does not provide a download URL | API is used only for metadata (title, duration, channel); yt-dlp handles the actual download. |
| Cloud Run egress IPs are rate-limited / flagged | Mitigated by operator cookies which authenticate the download to a real account. |

The cookies field is treated as a secret: stored in browser localStorage only (never logged), written to a temp file for yt-dlp execution, and deleted in a `finally` block.

This is the **accepted pattern**, not a temporary workaround. Online video processing tools (VEED.io, Kapwing, etc.) also rely on download-then-process pipelines; this is an inherent property of operating on online video at scale.

### 4. Pre-processing During Transit

Downloaded videos may pass through the pre-processing rules pipeline before re-upload:

- **Trim to boundary** (ADR-023) — e.g. strip pre-roll or post-roll.
- **Intro/outro injection** — planned capability; will be governed by a future ADR when implemented.
- Transcode/remux as required by the destination platform's ingest requirements.

Processing is non-destructive: the ephemeral download is deleted after upload completes; the original YouTube video is never modified.

### 5. Destination Flexibility

The destination is not constrained to YouTube. A video sourced from YouTube may be re-uploaded to:

- A different YouTube channel (primary use case).
- Kaltura (enterprise archive).
- Any future destination platform added to the system.

The source platform recorded in the catalogue entry remains `YouTube`; the destination is recorded separately in the publish event.

### 6. Provenance Requirements

Every download-then-reupload creates a **provenance chain** (ADR-019) with the following mandatory fields:

| Field | Value |
|-------|-------|
| `source_id` | `youtube-{VIDEO_ID}` |
| `source_platform` | `YouTube` |
| `download_url` | `youtube://{VIDEO_ID}` (internal scheme) |
| `metadata_extra.youtube_url` | `https://www.youtube.com/watch?v={VIDEO_ID}` |
| `metadata_extra.channel` | Original channel name |

The re-uploaded video's YouTube description **must** include the provenance footer defined in ADR-022, linking back to the original video.

### 7. What this ADR Does Not Cover

- **VEED.io integration**: downloading from YouTube to process via VEED.io and re-upload is a viable workflow but involves a third-party SaaS intermediary. This will be addressed in a dedicated ADR (planned ADR-029) covering: data residency, VEED.io API vs manual upload, and credit/cost model.
- **Bulk/scheduled downloads**: currently all downloads are operator-initiated (one video at a time via the UI). Scheduled/automated bulk download of YouTube content is out of scope and would require additional compliance review.
- **DRM-protected content**: yt-dlp will not be used to circumvent DRM. If a video is DRM-protected, the pipeline must abort with an explicit error.

---

## Consequences

**Positive:**
- Corrects the common operational problem of content published to the wrong channel without manual re-upload.
- Preserves full provenance so the destination video links back to the original.
- Uses operator-authenticated cookies, keeping the download within the operator's own account session.
- Pre-processing rules apply uniformly whether source is Zoom, Loom, or YouTube.

**Negative / Risks:**
- Cookie expiry: Netscape cookies have a limited lifetime. Operators must refresh them periodically; the system will surface yt-dlp auth errors clearly so the operator knows to update the cookie.
- Cloud Run ephemeral disk: large videos (>500 MB) may exceed the default Cloud Run instance disk limit. Mitigation: configure adequate ephemeral storage in the Cloud Run service definition, and impose a duration limit (e.g. reject videos >4 hours).
- YouTube ToS §4.B: automation that accesses YouTube "by means other than YouTube's API" is restricted. The operator's cookie authentication anchors the session to a consenting human account. This does not eliminate ToS risk — operators must assess their own compliance posture.

---

## Alternatives Considered

| Alternative | Reason Rejected |
|-------------|-----------------|
| YouTube Data API download URL | API does not provide download URLs for standard videos; only YouTube Studio export (manual) does. |
| Ask uploader to re-upload manually | Defeats the purpose of automation; impractical for backlog of misrouted videos. |
| Store original file before YouTube upload | Would require changes to the upstream recording workflow; not feasible for already-published content. |
| Loom-style URL pass-through | YouTube does not accept a YouTube URL as an upload source; a local file is required. |
