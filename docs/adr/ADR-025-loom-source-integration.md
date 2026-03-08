# ADR-025: Loom Source Integration

**Status**: Accepted
**Date**: 2026-03-08
**Deciders**: Engineering

---

## Context

Users manually upload Loom videos to the catalog by pasting a share URL. Unlike Zoom and
Fireflies, Loom has no formal API for bulk listing or batch import. The gaps were:

1. No metadata preview — the card showed only the manually-typed title and no thumbnail.
2. No publish path — `download_url` was set to the Loom share URL, which the upload route
   could not dereference.
3. Duration shown as 0 because Loom doesn't push duration at record-creation time.

---

## Decision

### 1. oEmbed metadata fetch (`/api/loom/metadata`)

Loom exposes a public oEmbed endpoint at `https://www.loom.com/v1/oembed?url=…` that
requires no authentication and returns:

```
title, author_name, thumbnail_url, width, height, duration (seconds),
description (AI-generated summary with timestamped chapters)
```

A Next.js GET route fetches and forwards this data. `VideoCard` shows a collapsible Loom
panel (thumbnail, title, author, duration, scrollable description) and an **Apply to record**
button that calls `UpdateMetadata` with `{ title, description }` from the oEmbed response.

### 2. HLS download via ffmpeg (`/api/youtube/upload`)

The upload route scrapes the Loom share page for `window.__APOLLO_STATE__` and extracts
the M3U8 URL + CloudFront credentials. ffmpeg converts the HLS stream to MP4 (stream copy,
`-bsf:a aac_adtstoasc`, `-movflags +faststart`). If no HLS is found it falls back to a
direct CDN MP4 URL regex. If the video is private or password-protected the scrape yields
nothing and an informative error is returned.

### 3. Source platform filter in processing rules

`RuleCriteria.source_platforms?: string[]` was added (ADR-013 extension) so trim and other
pre-processing rules can be restricted to specific platforms (e.g. Zoom + Fireflies only),
preventing rules from being applied to Loom videos where `recorded_at` may not reflect the
actual stream start time.

---

## Upload timeout characteristics

| Environment | Effective timeout | Notes |
|-------------|------------------|-------|
| Codespaces | ~60 s (proxy) | 504 for large videos — dev limitation only |
| Cloud Run | 3600 s (`--timeout=3600`) | Works for multi-hour videos |
| Vercel Hobby/Pro | 10–60 s | Not recommended for uploads |
| Vercel Enterprise | 900 s | `maxDuration = 3600` exported from route |

The upload route streams video to disk (no memory pressure), runs optional ffmpeg trim
(stream copy, fast), then streams from disk to YouTube's resumable upload API
(`uploadType=resumable`). Peak memory overhead is ~10 MB regardless of video size.

---

## Consequences

- Loom videos get rich metadata (AI-generated description, thumbnail, accurate duration)
  with a single fetch — no user-supplied data entry required.
- The oEmbed description often includes full timestamped chapter breakdowns, making it
  immediately useful as a YouTube video description.
- HLS scraping is fragile: if Loom changes `__APOLLO_STATE__` structure the download path
  breaks. Monitor for errors in server logs (`ext:youtube-upload`).
- Password-protected or private Loom videos cannot be downloaded without additional auth
  (outside scope of MVP).
- Loom videos should be excluded from trim-snap processing rules by default; the
  `source_platforms` filter makes this opt-in rather than opt-out.
