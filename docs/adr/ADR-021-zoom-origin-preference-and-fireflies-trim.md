# ADR-021: Zoom Origin Preference and Fireflies Pre-Run Trim

Date: 2026-03-06
Status: Accepted (policy) / Proposed (trim feature)

## Context

When both Zoom and Fireflies recordings exist for the same session (linked via ADR-019 provenance), they are **not equivalent sources**:

- **Zoom** recording starts when the host explicitly clicks "Record". This is typically at or just after the meeting officially begins.
- **Fireflies** joins the Zoom call automatically via a bot the moment anyone enters the meeting room. This means the recording begins during pre-meeting coordination — e.g. the organiser opening the room at 11:45 to check slides and sound before a noon broadcast, or a 10-minute "green room" discussion before going live.

Publishing Fireflies-originated content without trimming therefore risks exposing internal coordination, off-the-record remarks, or simply dead air / background noise that was never intended for the audience.

This affects:
1. **Publish quality** — audiences see content that was never meant to be public.
2. **Title mismatch** — the Fireflies transcript duration includes the pre-run, so duration metadata overstates the actual programme length.
3. **Processing rules** — transcript-based summarisation (ADR-014) will include the pre-run chatter, polluting the AI-generated description.

## Decision

### Policy: prefer Zoom-originated content for publishing

When a session has both a Zoom recording and a Fireflies transcript linked by provenance (ADR-019), the **Zoom recording should be used as the `download_url`** for YouTube upload. Fireflies content is still valuable for its transcript and summary, but the Zoom MP4 is the preferred video source.

This preference is surfaced in the UI:
- In `UnifiedImport`, sessions that are **Fireflies-only** (no matched Zoom recording) display an amber warning: *"Fireflies only — may include pre-run content. Consider trimming before publishing."*
- In `VideoCard`, if `source_platform === "Fireflies"` and the video has no upstream Zoom link, the publish preview shows a similar advisory.

### Proposed feature: `trim_start_seconds`

To handle cases where Fireflies is the only available source, or where the Zoom recording also contains pre-run content, a **trim offset** field is proposed:

#### Storage
A `trim_start_seconds` integer is stored in `metadata_extra` on the `VideoRecord`. This requires no Rust domain changes — it is a transparent metadata field.

```json
{
  "metadata_extra": {
    "trim_start_seconds": "420"
  }
}
```

#### UI
- A **"Trim start"** input (minutes : seconds) appears in the publish preview modal (`VideoCard`), pre-populated from `metadata_extra.trim_start_seconds` if set, defaulting to 0.
- Users can scrub the Fireflies transcript to find the phrase marking the real start (e.g. *"going live"*, *"we're on air"*) and enter the timestamp manually.

#### Auto-suggest heuristic (future)
A server-side helper at `/api/process/detect-trim` can scan the transcript for signals:
1. **Keyword scan**: phrases like *"going live"*, *"we're live"*, *"starting now"*, *"welcome everyone"* after an initial quiet period.
2. **Participant count step**: if the Fireflies transcript includes speaker labels, detect the point at which the speaker count increases from 1-2 (organiser + co-host) to 3+ (audience/guests).
3. **Silence gap**: a gap of > 30 seconds with no speech near the beginning, after which speech resumes — the post-gap start is a good trim candidate.

The endpoint returns a suggested `trim_start_seconds` value and the matching transcript excerpt for user confirmation. It does not auto-apply — the user must confirm.

#### Publish integration
When `trim_start_seconds > 0`, the upload route (`/api/youtube/upload`) prepends an ffmpeg `-ss {seconds}` seek to the download-then-upload pipeline, re-encoding only the audio stream (`-c:v copy -c:a aac`) to avoid quality loss on the video track.

```bash
ffmpeg -ss 420 -i input.mp4 -c:v copy -c:a aac -movflags +faststart output.mp4
```

This is applied after download to a temp file and before the YouTube resumable upload, fitting naturally into the existing Step 2 / Step 3 pipeline in `route.ts`.

## Consequences

- **Zoom preferred** is a soft policy enforced via UI hints, not a hard block. Users can still publish Fireflies content without trimming — the warning is advisory.
- **No Rust changes** are needed for the trim feature in its v1 form; `metadata_extra` is already a free-form map on the domain model.
- **ffmpeg dependency**: the trim-on-upload path requires ffmpeg to be installed in the server environment. This is already a dependency for Loom HLS downloads (see `/api/youtube/upload`). Cloud Build / Docker environments must ensure ffmpeg is available.
- **Transcript pollution**: even with a trim applied at upload, the Fireflies transcript stored in the catalog still contains the pre-run text. A future improvement could apply the trim offset to the transcript display as well (e.g. skip sentences before `trim_start_seconds`).
- **YouTube chapters** (alternative approach, not chosen): YouTube supports a `chapters` description format. An alternative to hard-trimming would be to set Chapter 1 to start at the trim offset. This avoids re-encoding but doesn't remove the pre-run from the video. Hard trim is preferred for audience-facing content quality.
