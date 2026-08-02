# ADR-063: Progressive-Reach YouTube Transcript Fetch

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-01 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-027 (YouTube source ingestion — yt-dlp already in image), ADR-042 (Kaltura shared-credential fetch), ADR-046 (prompt-driven summaries / "Show Notes"), ADR-052 (Show Notes backfill), ADR-053 (transcript provenance / borrow), ADR-059 (pre-show trim for summaries), ADR-060 (scheduled show windows) |

---

## Context

A recurring dead-end in the operator flow: a catalog record has a YouTube location — either as its `Origin` (a video ingested from YouTube directly) or as a published `Destination` — but no `transcript_text` on the record and no borrow-able sibling under ADR-053 provenance. The `📄 Show Notes` button (formerly "Summarise") is disabled with the hint "no transcript ≥200 chars" and the operator is stuck.

YouTube itself already has captions for these videos in almost every case: creator-provided tracks when the uploader added them, and auto-captions (ASR) as a floor. Every YouTube video page in a browser has caption text available; the platform just doesn't expose it through the same channel the video-sync ingest paths already speak.

Three routes exist, each with distinct trust and reach characteristics:

1. **YouTube Data API v3 — `captions.list` + `captions.download`**. Official. Requires OAuth. `captions.download` will only serve tracks whose video is owned by the authenticated channel — third-party videos return 403 no matter what scope was granted. High trust; narrow reach.
2. **Public timedtext endpoint** (`https://www.youtube.com/api/timedtext`). The same URL the YouTube web player uses when the viewer turns on captions. Works for any video that has captions enabled. Unofficial, undocumented, subject to change without warning. No auth required; universal reach.
3. **`yt-dlp --write-auto-subs --skip-download`**. Delegate the whole problem to yt-dlp, which already handles YouTube's quirks and ASR fallbacks; it's the maintained abstraction for exactly this task. Slower (subprocess spawn, sub-file scrape) and adds a subprocess dependency, but has the highest reach *and* the most graceful behaviour when YouTube changes its private surfaces. yt-dlp is already installed in the Cloud Run image (ADR-027).

Prior attempts at picking "the one right route" have been unsatisfying — the API works when we own the video; the timedtext scrape works when the creator turned on captions but not ASR; yt-dlp works nearly always but is heaviest. Picking any single one abandons the coverage of the others.

---

## Decision

### 1. Cascade through all three routes on every request

A single endpoint, `/api/youtube/transcript?videoId=<id>`, attempts each route in order. First one to return ≥50 bytes of usable caption text wins and short-circuits the rest. Reach order:

1. **Official captions API** (skipped when no `x-youtube-*` OAuth headers were sent).
2. **Public timedtext scrape** — track-list XML → best English track → `fmt=vtt`.
3. **yt-dlp** — `--write-auto-subs --write-subs --sub-lang 'en.*,en' --sub-format 'vtt/best' --skip-download`, then read the resulting `.vtt` from a scratch dir.

Every branch normalises the output through `captionsToTranscript()` (ADR-042 helper), so the caller receives the same `[HH:MM:SS] line` shape regardless of which route responded. No consumer has to care where the text came from.

### 2. Return `source` + a `tried[]` audit trail

The response is `{ text, source, language, format, tried[] }`. `source` is one of `captions_api | timedtext | yt_dlp`; `tried[]` records the step, an `ok` flag, and (on failure) a short `reason` string. The operator UI shows `source` in the event log and includes `tried` in the error toast when all three fail — this gives an at-a-glance signal for "did the official route work" without opening logs.

### 3. Server-side only

The endpoint runs in the Next.js API route (Node runtime). The public timedtext endpoint blocks browser-origin requests with `Referer` checks and there's no CORS header, so a client-side fetch would only reach route 1 (which the client already has headers for). Consolidating in the API route also lets us keep yt-dlp behaviour on the container, not on operator laptops.

### 4. Persist the fetched transcript via `update_metadata`

On success, the client calls `WasmVideoRecord.update_metadata({ edits: { transcript_text } })` — the existing event-sourced mutation path. The record's transcript then becomes indistinguishable (for downstream consumers: Show Notes, description generation, ADR-062 clip-source stitching, ADR-053 provenance borrow) from a transcript that arrived via the record's native ingest path. No new schema, no new field, no fork.

### 5. UI: one button, next to Show Notes

`📥 Fetch from YouTube` appears next to the disabled `📄 Show Notes` button whenever `!hasTranscript && locations.some(YouTube)`. Placement is deliberate — the operator's failure moment (clicking Show Notes and getting "no transcript") is exactly where the fallback needs to be one click away. On success the button disappears (transcript now exists → the `hasTranscript` branch renders instead) and the Show Notes button auto-enables.

---

## Consequences

**Positive**
- Unlocks Show Notes / description generation / clip-source construction for records that previously dead-ended at "no transcript."
- Every record with a YouTube location becomes summarisable in one click; the reach cascade handles the "which route works for this video?" decision without operator involvement.
- Reuses existing infrastructure: `captionsToTranscript()` from ADR-042, yt-dlp already deployed per ADR-027, OAuth header pattern already used by `/api/youtube/status`, `update_metadata` mutation from ADR-014.
- Adds no new environment variables or secrets — falls back on env-var creds when headers aren't sent, but timedtext and yt-dlp need no credentials at all.

**Negative / trade-offs**
- **Timedtext scrape is undocumented**. Google can change the endpoint or start requiring signatures at any time. Mitigation: it's the middle step, not the primary, and yt-dlp will keep the reach if it breaks.
- **yt-dlp subprocess spawn adds ~2–8s per fetch** on cold start. Acceptable for a manual, per-record operator action; not viable for a bulk-backfill job at current scale. If Show Notes backfill (ADR-052) starts calling this endpoint, we'll need concurrency limits + timeouts.
- **captions.download requires video ownership**. Third-party YouTube videos always fall through to timedtext even when we have OAuth. This is a YouTube quota-and-policy fact, not something we can route around. The operator sees `captions_api: HTTP 403 (needs channel-owner auth)` in the `tried[]` audit and understands why.
- **Auto-caption quality varies**. ASR-generated tracks (the timedtext fallback for videos without creator captions) can miss speaker turns, mistranscribe proper names, and drop punctuation. Show Notes generated from ASR text will be measurably worse than Show Notes from a Fireflies transcript. Operators should treat ASR-derived Show Notes as a first pass, not authoritative.
- **VTT chunking artefacts**. Both timedtext and yt-dlp emit repeated cue overlaps at chunk boundaries. `captionsToTranscript` dedupes contiguous identical lines, but the timing markers can still be slightly off — good enough for Show Notes generation, marginal for precise clip cutting.

**Downstream effects to watch**
- **ADR-046 Show Notes**: no schema change; the fetched transcript flows through `resolveTranscriptForOperation` naturally. Show Notes generated from ASR text will get lower-quality M/L/T/C section extraction — worth watching the C (Chat-Sparked) count in particular, since chat isn't in ASR.
- **ADR-059 pre-show trim**: applies to the fetched transcript as-is. If YouTube's captions start earlier than the show does (usually they don't — YouTube starts captioning when audio starts), the ADR-060 scheduled window still trims correctly.
- **ADR-062 clip-source stitching**: benefits directly. A record with a fetched YouTube transcript can now generate a summary → summary highlights become clip-source regions → ADR-062 stitching works even for YouTube-origin records that arrived without transcripts.
- **ADR-053 transcript provenance borrow**: the fetched transcript becomes borrow-able by sibling records via `TranscribedFrom` / `SameEvent` relations exactly as an ingest-native transcript would. No provenance annotation says "this came from YouTube after the fact" — deliberately kept generic to avoid a special-case in every borrower.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| yt-dlp only (skip the two lighter routes) | Higher latency for every fetch; makes cheap wins (owned videos, timedtext-available videos) pay the full subprocess cost. |
| captions API only | 403s any non-owned video. Rejects most of the reach the operator is asking for. |
| Client-side scrape of timedtext | Blocked by YouTube's `Referer` check + no CORS. Would work in a browser extension, not a web app. |
| Store the raw VTT and convert lazily | Extra plumbing for no benefit; every consumer wants `[HH:MM:SS]` marker format immediately. |
| Cache fetched transcripts in a separate table keyed by YouTube ID | Not needed — the record already stores `transcript_text` and dedupe-by-source (ADR-058) already prevents duplicate records for the same YouTube ID. |

---

## Out of Scope

- **Bulk backfill of missing transcripts**. Deferred; needs concurrency + rate-limit consideration before it can run over the full catalog. Individual records are unblocked immediately via the new button.
- **Speaker diarisation on ASR output**. YouTube's ASR doesn't emit speakers; adding a diarisation pass would require sending audio to a service that supports it. Not worth the cost when Fireflies + Zoom cover the multi-speaker case natively.
- **Automatic re-fetch when YouTube caption tracks improve**. YouTube periodically re-runs ASR on older videos with better models; there's no callback for "captions changed." Manual re-fetch via the same button is the pragmatic answer; the operator can just click it again.

---

## Related surface changes shipped alongside

Three smaller improvements landed in the same commit series; documenting here so a reader who greps for the affected files finds the reasoning:

- **Show Notes rename**. The chapter-oriented ADR-046 Drive Doc is now labelled **Show Notes** in the UI (button, lozenge tooltip, Discord push text, Maintain-page panel, backfill card). Internal identifiers (`summary_doc_id`, event names like `SummaryGenerated`, Rust struct fields, API routes at `/api/summary/*`) stay untouched — the rename is a display-layer change so log analysis and WASM API remain stable. Motivation: operators kept confusing "Summary" the paragraph blurb (`video.description`) with "Summary" the chapter breakdown; the podcast convention "Show Notes" describes the chapter doc unambiguously.

- **Description observant of the show**. `generateDescriptionFromTranscript` in `VideoCard.tsx` now applies ADR-060's `computeScheduledWindow` to derive `trim_start_seconds` + `trim_end_seconds`, then slices the transcript at both ends before hitting the LLM. Mirrors what ADR-059 did for Show Notes; the paragraph description no longer over-weights pre-show chatter or post-show tear-down. A new `sliceTranscriptToSeconds` companion lives in `lib/transcriptSlice.ts` alongside the head-slicer.

- **Shorts source link jumps to the clip moment**. The `▶ source` link on each short in `ShortsPanel.tsx` now includes `&t=<clip_start_seconds>s` when the clip's `metadata_extra.clip_start_seconds` is present (Opus populates this for every clip). Label reads `▶ source @ Xm Ys`. ADR-062's stitched-source manifest lookup is not yet wired in — deferred until clips actually start arriving from stitched sources.
