# ADR-040: Broaden Source Imports — Kaltura, YouTube Live, Multi-Origin Per Date

**Status**: Accepted (implemented 2026-04-30)
**Date**: 2026-04-30
**Deciders**: Architecture Team
**Related**: ADR-013 (Batch ingestion rules), ADR-015 (Fireflies import), ADR-016 (Backfill uploader), ADR-033 (Multi-origin dedupe), ADR-035 (Persistence topology), ADR-037 (Kaltura publish), ADR-039 (Drive artifacts)

---

## Context

Until this ADR, the catalog could be seeded from three external sources: Zoom recordings, Fireflies transcripts, and YouTube videos imported one-URL-at-a-time. The Backfill Uploader and the Sync Status Overview both assumed those origins were sufficient.

Two operator-driven gaps emerged:

1. **Videos already on Kaltura** — recordings the operator uploaded directly to Kaltura, often originating from streaming software (OBS, Streamyard, Wirecast, vMix) ingested via Kaltura's RTMP endpoint. These were invisible to the catalog. The only way to surface them was to re-import via URL one at a time.

2. **YouTube live broadcasts** — the entries on YouTube Studio's "Live" tab (`https://studio.youtube.com/channel/<id>/videos/live`). Past, currently-live, and upcoming broadcasts produced by streaming software pushing to YouTube Live's RTMP endpoint. The existing per-URL `YouTubeImport` flow could capture them one at a time but didn't enumerate them as a list.

A third issue surfaced once Kaltura side-publishing landed (ADR-037 + Kaltura side-publish from ADR-039): the Sync Status Overview deduplicated videos by recorded date, showing only the highest-status record per day. A Kaltura-only or live-broadcast record on the same day as a Zoom import was simply hidden.

---

## Decision

### Source-platform expansion

Add `Kaltura` to the Rust `SourcePlatform` enum (`src/catalog/value_objects.rs`):

```rust
pub enum SourcePlatform {
    Zoom,
    Loom,
    Fireflies,
    YouTube,
    Kaltura,    // ← new; live broadcasts ingested via streaming software
}
```

Update the `From<SourcePlatform> for Platform` exhaustive match. WASM rebuild required; Cloud Build's stage 0 produces `pkg/` so `pkg/` stays gitignored.

YouTube live broadcasts use the existing `SourcePlatform::YouTube` value but with `metadata_extra.live_broadcast = "1"` to distinguish them from regular uploads at query time.

### New API endpoints

| Route | Purpose |
|-------|---------|
| `GET /api/youtube/live-broadcasts?from&to` | Lists past/current/upcoming live broadcasts on the authorised channel. Enumerates uploads playlist, batches `videos.list` with `liveStreamingDetails`, filters to entries where the field is populated. Optional ISO date range. |
| `POST /api/kaltura/list` | Lists Kaltura media entries from the authorised account. Mints an admin KS, calls `media.list` with optional date filter. Returns id, name, duration, tags, player_url, created_at, and an `is_live` flag derived from `mediaType ∈ {7, 201}`. |

Both endpoints are `force-dynamic` and gated by IAP. Quotas are modest (~10 quota units for ~50 videos on the YouTube side; Kaltura is unmetered for our scale).

### New UI components

`KalturaImport.tsx` and `YouTubeLiveImport.tsx`, both following the established `FirefliesImport` / `ZoomImport` pattern: header with a fetch button, filter row (title substring + a kind-specific filter), a multi-select list, and an "Import N selected" action. They live in the **Meetings** tab of `ImportPanel` and share the merged date range introduced earlier.

For the live-broadcast component the kind-specific filter is a status dropdown: All / Completed / Currently live / Upcoming. Recorded-at on import uses `actualStartTime` (when the streamer went live) rather than `publishedAt`, so the catalog row lands on the correct day in the Overview.

### Multi-origin per date in Overview

`buildCalendarMonth` previously kept `Map<date, video>` with a single highest-status record per day. Replaced with `Map<date, video[]>` (sorted by status rank descending), and the per-day slot loop emits **one slot per video** when multiple share a date.

`buildCalendarOverview`'s monthly summary continues to count days, not rows: `target_days` and `gaps` deduplicate by `slot.date` so per-video proliferation doesn't inflate totals. Per-status counts (`published`, `approved`, etc.) still index by row — three Published-status records on one date count as three Published, which matches operator intent.

### Legacy-URL classification

Older catalog records have `destination_url` set on the singular field (predating the `locations[]` design). The Overview now classifies that URL by host (`/youtube\.com|youtu\.be/i` → YouTube; `/kaltura\.com/i` → Kaltura) so a Kaltura URL renders the purple Kaltura lozenge instead of being mis-shown as YouTube. Unknown hosts default to YouTube for backwards compatibility.

---

## Consequences

### Positive

- The catalog can now contain everything visible in YouTube Studio's Live tab and the operator's Kaltura account, alongside Zoom and Fireflies imports.
- Streaming-software broadcasts (OBS / Streamyard / Wirecast / vMix → YouTube Live or Kaltura RTMP) are first-class catalog citizens with the right `recorded_at` and a `live_broadcast` metadata flag.
- Sync Status now shows the FULL state of a date when multiple platforms have records for it — a Zoom recording and a Kaltura side-publish on the same day are both visible.
- The Overview's `src:Kaltura` filter chip joins `src:Zoom` and `src:Fireflies` so operators can isolate platform-specific subsets quickly.

### Negative

- The Rust `SourcePlatform` enum now has five variants. Future serialised state (e.g. `data/catalog.json`) referring to `Kaltura` source can't be deserialised by older app versions — a one-way migration. Acceptable since the app is single-deploy.
- Channel enumeration on YouTube — even with the `liveStreamingDetails`-only filter — costs ~`ceil(uploads/50) * (1 quota for playlistItems.list + 1 for videos.list)`. For a 1000-video channel, ~40 quota units per fetch. Kept inside the daily 10k quota with room to spare.
- More import surface to maintain. Added platforms grow the diff between what *can* be imported and what the rule engine (ADR-013) understands. Live broadcasts in particular don't yet have rule-engine criteria for `liveBroadcastContent`.

### Risks

- **Duplicate detection across origins**. A live broadcast on YouTube and a Kaltura mirror of the same broadcast share no obvious identifier. The existing dedupe (ADR-033) keys on `(source_platform, source_id)`, which won't catch this. Mitigation: ADR-033's "find duplicates" scan can be extended to surface cross-platform date+title overlaps; not addressed here.
- **YouTube quota during a manual `Fetch from YouTube`** could spike if the channel has tens of thousands of uploads. We don't currently paginate the UI, so the operator gets the whole list at once. Acceptable at current scale; revisit if the channel exceeds a few thousand uploads.
- **Kaltura `mediaType` heuristic for `is_live`** uses `7` (LIVE_STREAM_FLASH) and `201` (LIVE_STREAM_QUICKTIME) per Kaltura's enum. New live media types added to Kaltura would render as non-live until the heuristic is updated.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **Use YouTube `liveBroadcasts.list` API** | Requires the broader `youtube` OAuth scope; existing app holds `youtube.readonly`. Re-auth would disrupt every operator. The chosen approach (uploads playlist + `videos.list` with `liveStreamingDetails`) works with the readonly scope. |
| **Per-URL Kaltura import only** (no list flow) | Kaltura entry IDs aren't human-rememberable; operators would need to copy them from Kaltura's UI one at a time. List-and-multi-select is the friction-reducing pattern that already worked for Zoom and Fireflies. |
| **Separate "Live" tab in `ImportPanel`** | Splitting the Meetings tab would orphan the shared date range. Stacking live broadcasts and recordings inside Meetings keeps the date picker behaviour consistent and is closer to how operators think about a day's content. |
| **Drop the Overview's date dedup entirely** (let any video render) | Considered but breaks the "this day has X coverage" mental model. Multi-row-per-date with deduped target_days/gaps preserves the day-view while letting all records be visible. |
| **Add `live_broadcast` as a fifth `SourcePlatform` variant** | Would proliferate the enum (today YouTube live and YouTube uploads share one variant). The metadata_extra flag is enough to distinguish them at query time without the schema churn. |

---

## Open questions

1. **Cross-platform dedupe for live broadcasts** that are mirrored to both YouTube Live and Kaltura simultaneously. Currently treated as two records; ADR-033's dedupe scan would need a new heuristic (date + title fuzz + duration). Defer until operators report duplicates.
2. **Rule-engine support for `live_broadcast`** — should ingestion rules be able to match `metadata_extra.live_broadcast == "1"` to auto-approve / auto-skip live broadcasts? Probably yes for completed broadcasts; defer until operators ask.
3. **Currently-live broadcast handling**. The list flow imports them with status `Discovered`, which is fine for after-the-fact processing — but the operator might want a "watch this broadcast complete and re-fetch metadata" flow. Out of scope here; ADR-034 (chat-query MCP) is adjacent.

---

## References

- ADR-013: Batch ingestion rules engine — applies to all source imports.
- ADR-015: Fireflies import — UX pattern reused here.
- ADR-016: Retrospective backfill uploader — depends on accurate `recorded_at` from imports.
- ADR-033: Multi-origin dedupe — its keys must extend to cover cross-platform-mirrored broadcasts.
- ADR-035: Persistence topology — broader source set increases catalog size; Level 2 server-side catalog handles it.
- ADR-037: Kaltura publish — destination side; this ADR adds the source side.
- ADR-039: Drive-based artifact storage — every imported record gets a Drive folder for transcripts/descriptions/summary/chat.
