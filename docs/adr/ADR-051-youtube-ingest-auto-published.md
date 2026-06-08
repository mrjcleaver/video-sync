# ADR-051: YouTube source rows from publish-trail ingest land at Published

**Status**: Accepted (implemented 2026-06-07)
**Date**: 2026-06-07
**Deciders**: Architecture Team
**Related**: ADR-008 (DDD bounded contexts — status lifecycle), ADR-027 (YouTube source ingestion), ADR-049 (live-stream provenance), ADR-050 (Fireflies as downstream)

---

## Context

ADR-008 establishes the catalog status lifecycle: `Discovered → InScope → Approved → Publishing → Published`, with off-ramps to `Skipped`, `Failed`, `Abandoned`, `ToRetry`. New records start at `Discovered` so the operator can review before any publish action.

ADR-049/050 C1-A (`youtubeIngest.ts`) and C3 (post-publish hook in `VideoCard.tsx`) added a new way for YouTube source rows to enter the catalog: walking a host record's `Destination YouTube` locations or watching a publish trail. By definition these flows only run for videos *that are already live on YouTube* — the YouTube row's existence in our catalog is, semantically, a record of a known publication.

For these rows, `Discovered` is the wrong default. The operator surfaced this directly:

> "This will advance those 28 records stuck in Discovered?"

Concrete example (2026-06-07): backfilled YouTube source row `youtube-p4kHccoXsjY` landed at `Discovered` even though the video has been live on YouTube for months. The operator's expected mental model is "the row exists ↔ it's a known publication", not "the row exists ↔ I need to review it for possible future publication."

## Decision

When a YouTube source row is created (or repaired in the partial-pair sense from ADR-050 follow-ups) via the publish-trail ingest paths — **C1-A backfill** and **C3 forward-only post-publish** — automatically advance it through `→ Approved → Publishing → Published` using the existing WASM aggregate transitions. The video is already on YouTube; the catalog state should reflect that.

Concretely: after `videoStore.add(record)` (or the matching repair branch for an existing partial row), call a private `maybeAdvanceToPublished(recordId, ytVideoId, actor)` that runs:

1. `approve(cmd)` — `Discovered`/`InScope` → `Approved`
2. `request_publish(cmd)` — `Approved` → `Publishing`
3. `mark_published(cmd)` — `Publishing` → `Published`

`mark_published` uses the YouTube video id as the `destination_id`. WASM's existing dedupe (ADR-049 slice 1 — `Platform::normalize_external_id`) ensures the redundant Destination push is a no-op when the Origin location already covers the same id, which is the case for YouTube source rows.

### Status guard

Auto-advance is **only** attempted when the row's current status is one of `{Discovered, InScope, Approved}`. The guard exists to preserve deliberate operator intent — a row that's been moved to `Skipped`, `Failed`, `Abandoned`, `ToRetry`, or that's already in-flight (`Publishing`, `Published`) is left alone. This is the difference between "fill in a forgotten default" and "override a decision" — ADR-051 only does the former.

Exposed for testability as `ADVANCEABLE_STATUSES` + `isAdvanceableStatus(s)` in `youtubeIngest.ts`.

### Scope

ADR-051 applies to:
- **C1-A** (Catch-Up panel → Run YouTube row backfill) — the historical-publish-trail walk.
- **C3** (`VideoCard.tsx` post-publish hook) — the forward-only auto-ingest after every successful YouTube publish.

ADR-051 explicitly does **not** apply to:
- **`YouTubeLiveImport.tsx`** (channel-poll import). That flow imports broadcasts at all lifecycle stages — `live`, `upcoming`, `none`, `completed`. Only `completed` and `none` are unambiguously "publication-complete"; the others have nuance (an upcoming scheduled stream isn't a publish yet). Auto-advance for the channel-poll flow needs a per-broadcast `liveBroadcastContent` check, deferred to a follow-up if needed.
- **Manual YouTube ingest** (URL paste, ad-hoc operator action). The operator's intent in those flows is less constrained; leave the Discovered default in place.

### Why not change the WASM default starting status?

Two reasons:
1. The default makes sense for every other source — operator review before any publish action is the right default for Zoom/Fireflies/Loom/Kaltura inputs.
2. Changing the WASM default would conflate "ingested" with "published" globally. The right fix is per-ingest-path: paths that know the publication state, set the right status; paths that don't, fall through to Discovered.

## Consequences

**Positive**
- The 28 historical YouTube rows backfilled by C1-A land at Published immediately — no operator follow-up needed to clear them out of the Discovered bucket.
- Future publishes through the C3-wired flow auto-advance their new YouTube source row, so the Discovered count never accrues from this source.
- ADR-049's "alreadyPublished" pair-aware gating on canonical cards (which already uses `broadcastPairs.destinationsFor`) now has both signals aligned: the canonical sees a paired broadcast AND the broadcast row itself is at Published.

**Negative / careful**
- A YouTube row whose backing video gets deleted from YouTube between ingest and operator review would be in catalog at Published with a now-dead link. Same risk exists in `YouTubeLiveImport.tsx`'s flow today; not a new failure mode introduced here.
- The auto-advance chain is fire-on-best-effort: if any of the three WASM transitions throws, the helper returns `advancedToPublished: undefined` and leaves the record wherever the chain stopped. The catalog state stays consistent — a Discovered or Approved row is still readable, the next backfill run re-attempts. No partial-publish corruption is possible because the WASM aggregate transactions are per-call.

**Mitigation for the chain-failure case**: each WASM transition is idempotent on no-op (e.g. `request_publish` from `Publishing` is treated as the receiving state, not an error in our orchestration), so re-running C1-A or repeating C3 will retry the remaining transitions safely.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Change the WASM default starting status to Published** | Wrong for every non-publish-trail ingest source. Conflates ingest with publish. |
| **Add a new dedicated `BornPublished` status** | Status proliferation without semantic gain — the existing `Published` is correct here, the gap is just the default at creation. |
| **Auto-advance via the sibling matcher / Catch-Up regular flow** | The matcher's job is link classification, not status transitions. Mixing concerns would make `runCatchUp` non-pure-link-side-effects. |
| **Leave operator to click "Already on YouTube" per row** | 28 manual clicks for the backfill; recurring overhead on every C3 publish. The operator's repeated request "advance those 28 records stuck in Discovered" makes the manual cost explicit. |
| **Auto-advance only after manual confirm in a dialog** | Adds friction without proportional safety — the publish-trail provenance is unambiguous, and the status guard already preserves explicit-Skipped/Failed/Abandoned intent. |

## Open Questions

1. **`YouTubeLiveImport.tsx` channel-poll flow.** Should we auto-advance `completed` broadcasts in the channel-poll path too, using a `liveBroadcastContent === "completed"` gate? Probably yes; deferring until operator surfaces it.
2. **Operator override.** If an operator decides a Published YouTube row is wrong (e.g. they want to abandon a draft), the existing `abandon` transition works — no special un-publish flow needed. Worth documenting in the operator guide once it exists.
3. **Catalog migration for pre-ADR-051 backfilled YouTube rows in Discovered.** The first production C1-A run on 2026-06-07 created at least one row (`p4kHccoXsjY`) at Discovered before this ADR's auto-advance was wired. Re-running the backfill after this ADR ships will repair them (the existing-row repair branch now also calls `maybeAdvanceToPublished`). Listed here so the migration trail is explicit; no separate operator action needed.

## References

- ADR-008: status lifecycle (Discovered → ... → Published)
- ADR-049 slice 1: `Platform::normalize_external_id` location dedupe — what makes the Origin=Destination case safe
- ADR-049 slice 4 / ADR-050: `alreadyPublished` pair-aware gating on canonical cards
- ADR-027: YouTube source ingestion
- Implementation: `web/src/lib/youtubeIngest.ts:maybeAdvanceToPublished` (commit pending — same PR as ADR text)
- Tests: `web/tests/youtubeIngest.test.ts` — `isAdvanceableStatus` describe block (4 cases)
- Concrete trigger: catalog record `youtube-p4kHccoXsjY` stuck at Discovered after the 2026-06-07 first run.
