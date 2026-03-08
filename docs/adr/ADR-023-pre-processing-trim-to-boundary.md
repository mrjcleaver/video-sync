# ADR-023: Pre-processing Trim-to-Boundary Rule

Date: 2026-03-07
Status: Accepted

## Context

Zoom recordings start when the host opens the meeting room, and Fireflies bots join at the same moment the room is opened. Both may therefore capture several minutes of pre-meeting coordination before the scheduled session goes live — dead air, host setup, or informal chat that should not appear at the start of a published YouTube video.

ADR-021 established that Zoom-originated content is preferred over Fireflies for upload, and noted that a trim offset should be computable from the `recorded_at` timestamp. The challenge: the exact amount to trim varies per recording, but sessions typically start on a well-known boundary (e.g. 12:00:00, 14:30:00). Trimming to the next such boundary removes pre-meeting content without needing per-video manual review.

## Decision

Add a `trim` transform to the pre-processing rules engine (`ProcessingRule.transforms.trim`). When a matching rule has a trim transform, `applyProcessingRules()` computes `trim_start_seconds` — the number of seconds to skip from the beginning of the recording so the output starts at the next snap boundary.

### Snap modes

| Mode | Boundaries | Description |
|------|-----------|-------------|
| `hour` | `:00` | Top of each hour (default) |
| `half` | `:00` / `:30` | Every 30 minutes |
| `quarter` | `:00` / `:15` / `:30` / `:45` | Every 15 minutes |

### Algorithm

```
currentOffset = recorded_at.minutes × 60 + recorded_at.seconds
if currentOffset == 0: trim_start_seconds = 0  // already on boundary
else: find smallest boundary B > currentOffset within [0, 3600)
      trim_start_seconds = B - currentOffset
```

If the recording starts exactly on a boundary (e.g. 14:00:00) the trim is skipped entirely (`trim_start_seconds = 0`).

### Priority and override

- Rules run in priority order (lower number = first).
- The first matching rule with a `trim` transform wins; subsequent rules' trim transforms are ignored.
- `trim_start_seconds` flows through `PublishAttributes` to `VideoCard.publishToYouTube()`, which passes it to `/api/youtube/upload` as `trimStartSeconds`.

### Server-side trim (ffmpeg)

`/api/youtube/upload` runs ffmpeg after the source video is downloaded to disk and before the upload to YouTube:

```
ffmpeg -ss {trimStartSeconds} -i input.mp4 -c:v copy -c:a copy -movflags +faststart -y trimmed.mp4
```

Stream copy (`-c:v copy -c:a copy`) avoids re-encoding — preserving quality and keeping processing time proportional to file size rather than video length. The trimmed file replaces the downloaded file; both are cleaned up after upload.

## Consequences

- **Fast**: stream copy trim of a 1-hour recording takes ~5 seconds regardless of bitrate.
- **Accurate to the second**: `recorded_at` seconds component is used, not just minutes.
- **Non-destructive**: the original recording in Zoom/Fireflies is unaffected; only the copy uploaded to YouTube is trimmed.
- **Transparent**: a `TrimApplied` event is logged in the event log showing the offset applied. The Processing Rules panel preview shows the computed trim offset before upload.
- **Caveat**: ffmpeg must be installed on the server. If not present the upload fails with a clear error message. The Codespaces / Docker environment includes ffmpeg.
- **Caveat**: snap-boundary trim assumes sessions are scheduled on known intervals. Recordings for ad-hoc calls (no fixed start time) should use a rule with no trim transform, or override manually via the publish preview.
