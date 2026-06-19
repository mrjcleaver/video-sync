# ADR-044: Always Show Kaltura Presence Alongside YouTube

**Status**: Accepted (implemented 2026-05-22 — referenceId + provenance-footer match; fuzzy match deferred)
**Date**: 2026-05-19
**Deciders**: Architecture Team
**Related**: ADR-016 (backfill uploader), ADR-022 (compliance audit), ADR-037 (Kaltura publish), ADR-040 (broaden source imports), ADR-039 (Drive artifacts)

---

## Implementation notes (2026-05-22)

Shipped:

- `POST /api/kaltura/presence-batch` — body `{ recordIds: string[] }`, returns `{ presence, missing }`. Two-pass match: `filter[referenceIdIn]` first (one Kaltura call per batch), ADR-022 provenance-footer scan via `freeText: "catalog:<short-id>"` for up to 10 unmatched IDs per batch.
- `web/src/lib/kalturaPresenceCache.ts` — localStorage `video-sync:kaltura-presence`, 1-hour TTL, same shape as `youtubePrivacyCache`. Bulk-write API for the Fill flow.
- `/api/kaltura/upload` and `VideoCard.publishToKaltura()` now set `referenceId = video.id` so future presence sweeps find the entry by referenceId alone (no description-footer dependency).
- `BackfillOverview` renders the five-state Kaltura lozenge per row, resolving through (1) `locations[]` Kaltura destination → `ready`, (2) presence cache → cached state, (3) otherwise → `unknown`. Tooltip explains the match path (referenceId / footer / not asked / asked-and-absent).
- A **Fill Kaltura status** button sits next to **Fill privacy** in the Overview toolbar, batched 50/call.

Deferred (Open Questions in this ADR):

- Fuzzy title + recorded-at match for legacy entries with no `referenceId` and no parseable footer.
- VideoCard meta-row Kaltura badge (replaces the side-publish button affordance when the entry is already on Kaltura by referenceId/footer).
- Filter-chip differentiation by presence state (present / absent / unknown).
- One-time admin sweep to backfill `referenceId` on historical Kaltura entries.

---

## Context

Today the catalog displays presence for two destinations very asymmetrically:

| Destination | When the lozenge lights up |
|---|---|
| **YouTube** | If a `locations[]` entry exists OR the legacy `destination_url` is a YouTube URL. Privacy (Public / Unlisted / Private) is fetched via the `/api/youtube/privacy-batch` "Fill privacy" flow and cached in `localStorage` (`video-sync:yt-privacy`). |
| **Kaltura** | Only if the operator pressed **Publish to Kaltura** inside this app. Videos that exist on Kaltura via any other path — direct upload, prior pipelines, ADR-040 Kaltura source imports without subsequent re-publish — show **no Kaltura lozenge at all**, even though they're plainly there. |

Concrete operator pain:

1. The operator imports a meeting that was already mirrored to Kaltura months ago. The card shows "not on Kaltura" — wrong; the entry exists. They publish again, creating a duplicate on Kaltura.
2. A live broadcast streamed via OBS → Kaltura RTMP shows up via ADR-040 source import (catalog row appears), but the lozenge stays absent because no `locations[]` Kaltura destination was ever written. The card invites a redundant publish.
3. Background activity by another tool (a separate CMS, a manual upload) puts something on Kaltura. The catalog doesn't reflect it.

YouTube has the same class of problem in theory, but the "Recover from YouTube" + "Fill privacy" flows have evolved to handle it: every Published YouTube record gets a privacy badge that's checked against the channel. Kaltura has no equivalent.

This ADR commits to **treating Kaltura as a peer destination** to YouTube — the catalog should always reflect what Kaltura says, not just what this app has done.

---

## Decision

### Kaltura presence is a first-class display element on every record

Every video card and every Overview row renders a **Kaltura status badge**, even when the record has no `locations[]` Kaltura entry. The badge resolves through:

1. `locations[]` with `platform === "Kaltura"` and `role === "Destination"` (definitive — we published it here)
2. A cached presence record from a Kaltura discovery pass (we've asked Kaltura and got an answer)
3. Otherwise: **Unknown** (no answer yet — the operator can ask, or the background sweep will)

### Status enum

Five states, mirroring the YouTube privacy cache shape:

| State | Meaning | Lozenge style |
|---|---|---|
| `ready` | Entry exists on Kaltura, ready to play (`mediaType` returned, status ≥ READY) | Solid purple, label "Kaltura" |
| `processing` | Entry exists, still encoding | Outlined purple, label "Kaltura: processing" |
| `live` | Live-stream entry currently broadcasting | Solid red-purple, label "Kaltura: LIVE" |
| `absent` | Kaltura asked and didn't return a match | Faint purple, struck-through, label "no Kaltura" |
| `unknown` | Never asked / cache expired | Faint grey outline, label "Kaltura ?" |

The lozenge replaces the current "show only if locations has Kaltura" pattern.

### How we match a catalog record to a Kaltura entry

Two strategies, applied in order:

1. **`referenceId` (preferred)**. Every record we publish from this app already sets the Kaltura entry's `referenceId` to the catalog UUID. For discovery of entries we didn't publish, we extend the discovery sweep to also query by ADR-022 provenance footer markers in the entry description (`catalog:UUID`). When `referenceId` is present and matches, the link is unambiguous.

2. **Title + recorded-at fuzzy (fallback)**. For legacy Kaltura entries with neither `referenceId` nor a provenance footer, match by title token overlap (same algorithm as `siblingMatcher`) combined with same-calendar-day `createdAt` proximity. Score above a threshold → cache as `ready`. Below threshold → cache as `absent`. Operators can manually accept or reject via a small "Did you mean…" hint, mirroring the YouTube sibling-suggest UX.

### Discovery sweep

A new endpoint `POST /api/kaltura/presence-batch` analogous to `/api/youtube/privacy-batch`:

```
Body: { recordIds: string[] }
Returns: {
  presence: Record<recordId, {
    state: "ready" | "processing" | "live" | "absent",
    entryId?: string,
    playerUrl?: string,
    matchedBy: "referenceId" | "footer" | "fuzzy",
    matchScore?: number,        // only when matchedBy === "fuzzy"
    checkedAt: ISO,
  }>;
}
```

Server-side: mints a Kaltura admin session, calls `media.list` with `filter[referenceIdIn]` for the batch (Kaltura supports comma-separated `IN` filters), falls back to fuzzy for unmatched IDs.

Client caches the result in `localStorage:video-sync:kaltura-presence` keyed by catalog record id, 1-hour TTL (same shape as `video-sync:yt-privacy`).

UI affordance: a **Fill Kaltura status** button next to the existing **Fill privacy** button in the Overview header, batched in groups of 50.

### Operator override of fuzzy matches

Two new buttons on cards that have a `fuzzy` Kaltura match:

- **Confirm Kaltura match** → adds a Kaltura `locations[]` entry, upgrades the status to `ready` via the definitive path.
- **Reject Kaltura match** → adds to a new `video-sync:rejected-kaltura-matches` list (per-browser today; subject to the ADR-043 Open Questions discussion).

### Where the lozenge appears

- **Video cards** (`VideoCard.tsx` meta row) — replaces the existing conditional render of the Kaltura badge
- **Overview rows** (`BackfillOverview.tsx` `DateList`) — already has a slot for the lozenge; populates from the same cache
- **Sync Status filter chips** (`BackfillOverview.tsx` legend) — extend the existing `kaltura` filter to differentiate present / absent / unknown when the chip is clicked

---

## Consequences

### Positive

- **Duplicates avoided.** Operator sees Kaltura presence before clicking Publish; can confirm-match instead of re-uploading.
- **Symmetric with YouTube.** Mental model matches: every record has both YouTube and Kaltura columns, both can be in any of {present, processing, absent, unknown}.
- **Bridges ADR-040 ingest path.** Kaltura source imports get a Kaltura lozenge for free (we already have the `entryId` from the import).
- **Sets up cross-platform dedupe (ADR-033 §Q3).** A future "Find duplicates" scan benefits from the same presence cache.

### Negative

- **Quota cost.** Kaltura's `media.list` with `IN` filter is cheap (one call per 50 records), but a full-catalog sweep at 1000 records is ~20 calls — fine in absolute terms, but worth noting.
- **Fuzzy matching produces false positives.** A "Tech Talk 2025-09-12" on Kaltura might be a different meeting from the same-day "Tech Talk 2025-09-12" in the catalog. Mitigated by requiring confirm before writing to `locations[]`.
- **UI density grows.** Each video row now has two destination columns instead of one. Acceptable on the Overview's wide-row layout; tighter on mobile.
- **Cache invalidation.** Kaltura entry transitions (`processing` → `ready`, deletions) won't reflect until the next sweep or until the TTL expires. Same shape as YouTube privacy cache.

### Risks

- **`referenceId` not consistently set on historical entries.** Older Kaltura entries pre-dating our publish flow won't have `referenceId`. Fuzzy matching is the only path. If accuracy is poor, operators rely on the confirm/reject UI more than is comfortable. A one-time backfill (admin endpoint that walks the Kaltura account and updates `referenceId` where the provenance footer is parseable) would close this gap; flagged as Open Question.
- **Live broadcast state is volatile.** Status changes mid-broadcast; a 1-hour TTL means the lozenge can lag reality. Acceptable for the broader use case; live-streaming operators can hit "Fill Kaltura status" to refresh.
- **Rejection list grows unbounded.** Same shape as `rejected-yt-matches`. Per ADR-043 Open Questions, sharing this across operators is undecided.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **Manual "Check Kaltura" button per card** | Per-card discovery scales poorly; operators have to remember to click. Batch sweep is the right primitive — manual override stays available via the confirm/reject UX. |
| **Show Kaltura lozenge only when `locations[]` has it** (current behaviour) | The pain that motivated this ADR. Skips entries we didn't publish but Kaltura plainly has. |
| **Push presence to the server-side resolver** (always re-check on every catalog read) | Quota inflation; server has no easy way to invalidate when Kaltura changes; client cache with refresh button is the established pattern (YouTube privacy works this way). |
| **Use Kaltura webhooks to notify on entry create/update** | Two-way integration territory; large scope. Webhook handler + state reconciler is its own ADR. Polling with explicit refresh keeps complexity bounded. |
| **Treat Kaltura as authoritative — drop the local `locations[]` for it** | Loses the in-app audit trail of "we published this from here". The `locations[]` is the canonical record of our actions; presence cache is the canonical record of Kaltura's current view. They're complementary. |

---

## Open questions

1. **Backfill `referenceId` on legacy entries?** An admin sweep that walks Kaltura, parses provenance footers from descriptions where present, and sets `referenceId` on matching entries would lift accuracy of subsequent discovery passes. Cost: a few minutes of operator time + Kaltura API calls. Not built here.
2. **Rejection list scope.** Per-browser today (matches ADR-043 deferral on `rejected-sibling-matches`). Should reject decisions propagate to other operators? Depends on whether a fuzzy match is an objective judgement or a contextual one.
3. **Refresh cadence.** 1-hour TTL is borrowed from `yt-privacy`. For Kaltura `processing` → `ready` transitions (which take minutes for short clips, hours for long ones), a shorter TTL on `processing` entries specifically would feel snappier. Lazy refinement.
4. **Mobile UX.** The video card meta row is dense already; adding a second destination badge tips it past comfortable on narrow viewports. Worth a small audit if/when the operator base spans mobile.

---

## References

- ADR-016: Retrospective backfill uploader — defines `BackfillProfile`, current YouTube-only quota tracking
- ADR-022: Compliance audit — `catalog:UUID` provenance footers we can parse from Kaltura entry descriptions
- ADR-033: Multi-origin dedupe — sibling-match scoring this ADR's fuzzy path reuses
- ADR-037: Kaltura publish — the side that writes to Kaltura; this ADR is the read side
- ADR-040: Broaden source imports — Kaltura as a source platform (we already read `media.list` there)
- ADR-039: Drive artifact storage — the broader "be honest about what state lives where" theme
