# ADR-058: Source discovery and pre-import awareness on Overview

**Status**: Proposed (exploration)
**Date**: 2026-07-26
**Deciders**: Architecture Team
**Related**: ADR-005 (source integration strategy — operator-triggered by design), ADR-016 (retrospective backfill uploader), ADR-035 (persistence topology), ADR-042 (server-side credentials), ADR-047 (automated catch-up), ADR-057 (activity-based navigation)

---

## Context

ADR-057 promoted Overview (SyncStatusPanel — Overview + Calendar tabs) to a first-class sidebar entry and then to the root landing (`/` → `/overview`). Operator feedback that motivated the promotion:

> "It is the first place I tend to look but it doesn't always show what I expect as I have to import for that."

The gap: Overview's Calendar renders *catalog* records on target days. It doesn't render recordings that *exist on the source platform* but haven't been imported into the catalog yet. The operator sees "empty Tuesday" and only later remembers "…because I haven't clicked Import for this week yet."

This ADR is an exploration of what "pre-import awareness" could look like, without committing to an implementation. The design space touches: source-platform API quotas, storage of "seen-but-not-imported" state, UI representation of ghost/pending records, and an assumption from ADR-005 that imports are operator-triggered on purpose.

### What already exists

The Calendar renders **target-day slots** derived from the selected backfill profile (`SyncStatusPanel` → `buildCalendarOverview(videos, profile)`). Empty target-day slots ARE shown today as placeholders ("— no source —"). The gap is those empty placeholders don't tell the operator *whether a recording actually exists* on the source platform — they only say "no record in catalog."

### Constraints to respect

1. **ADR-005**: no automatic background polling. Every import is a deliberate operator action.
2. **API quotas**: Zoom's account-level API is rate-limited; YouTube Data API v3 has daily quota (10k units default); Fireflies has a monthly usage cap that isn't publicly documented and is easy to burn through.
3. **Cross-operator visibility**: whatever we surface must be visible to every operator, not per-browser (ADR-035 shared-state principle).
4. **Truthful UI**: showing "no recording exists" when we didn't actually check is worse than showing "unknown."

## Alternatives

### Option A — On-demand probe (per-day, per-source)

Each empty target-day slot on the calendar gets a small "Check" button. Clicking it fires a single-source, single-day probe (e.g. `zoom/recordings?from=2026-07-15&to=2026-07-15`), and paints the slot green / grey / with a count.

**Pros**
- No background polling. ADR-005 preserved.
- Quota-cheap — one API call per operator interaction, not per calendar render.
- Simple UX — one button, one result.

**Cons**
- Manual per slot. Doesn't scale to "show me the last 3 months at a glance."
- Multi-source days (Zoom + Fireflies for the same meeting) need multiple button clicks per slot.

### Option B — Ghost records in catalog

When the operator does trigger a source probe, the results are persisted as **ghost records** — VideoRecord entries with `status: "Discovered"` but a new tag `imported: false` (or a new status `Sighted` before `Discovered`). The Calendar renders them like real records but visually muted; the operator can click each to promote from Sighted → Discovered (which triggers the actual import + full metadata fetch).

**Pros**
- Every operator sees the same "we know these recordings exist" state, no per-browser divergence.
- Ghost records participate in provenance graph naturally — if a ghost YouTube record shows up before its paired Zoom is imported, the sibling matcher can hint at the pair.
- Retrospective backfill orchestrator can enumerate ghosts as a work-list.

**Cons**
- New status (`Sighted`) OR new field (`imported: false`) — either is a schema change touching WASM + every consumer that filters by status.
- Storage grows even for recordings that never get promoted — worth if we care about "audit trail of what was on the source" but that's a bigger design question.

### Option C — Server-side polling with cache

A Cloud Run cron (or a periodic worker) probes each configured source every N hours and caches results in `data/source-inventory.json` on the FUSE mount. The dashboard reads that cache and renders it. No per-operator API calls.

**Pros**
- One API call per source per interval, not one per operator per interaction. Quota-friendly at team scale.
- Overview instantly shows "what's out there" on load — feels magical.
- Aligns with existing shared-state pattern (ADR-035).

**Cons**
- **Violates ADR-005** (no background polling). Would need an explicit ADR revision to permit periodic reads-only-not-writes.
- Freshness / staleness UX problem — "last polled 4 hours ago" needs to be visible.
- Adds a scheduled component to the deploy topology. Currently no cron infra.

### Option D — Import-side date-range memory

Track per-source `last_imported_up_to` timestamps. The Calendar renders a subtle band on days where **we know we haven't checked yet** ("last check for Zoom: 3 days ago"), so the operator sees the confidence gap without needing to probe.

**Pros**
- Truthful — shows "unknown" rather than "empty."
- No source-API calls at all — pure catalog-side bookkeeping.
- Minimal schema change: one timestamp per source in an existing settings blob.

**Cons**
- Doesn't answer "does a recording exist on Tuesday?" — only "have I checked Tuesday?"
- Operator still has to click Import to get the answer. Same as today, just with clearer signposting.

### Option E — Overview "Import missing" action

The current Overview's empty target-day slots gain a **"Import date range"** action that opens ImportPanel pre-filtered to that date-range on all configured sources. One click → Import panel opens showing what's fetch-able for that window.

**Pros**
- No new source-side machinery; just plumbing between two existing panels.
- Preserves ADR-005 exactly — operator still initiates.
- The "I have to import for that" gap collapses to a single click.

**Cons**
- Still requires the click. Overview doesn't answer the question directly; it shortcuts the next step.
- Operators looking for a passive "what am I missing?" view don't get it.

### Option F — Do nothing (status quo after ADR-057)

Overview is on the root landing, count badges visible, but Overview stays a view of *what's imported*, not what's out there. Operators internalise the mental model and know to click Import when the calendar looks emptier than expected.

**Pros**
- Zero risk. ADR-057 shipped; nothing more to build.
- The existing "Fill Kaltura status" button on Overview is already the shape of Option A for Kaltura specifically — that pattern can extend if any specific source becomes the pain point.

**Cons**
- The operator's original complaint stands unresolved.

## Considerations that apply across options

1. **Which source platforms should participate.** Zoom + Fireflies + YouTube Live are the obvious three. Loom is URL-only (no discovery API). Kaltura already has a probe pattern via "Fill Kaltura status." Any new pattern should share ergonomics with what exists.
2. **What "exists on source" actually means.** For Zoom, a `RECORDING_COMPLETED` webhook (if we were listening — we're not) is the truth. Without the webhook, a polling-based sighting is best-effort. For YouTube Live it's `liveBroadcastContent` state. For Fireflies it's the transcript-list endpoint.
3. **Duplicate signalling.** If a Zoom recording exists AND a Fireflies transcript for the same meeting exists, we sight two things but they're one event. The sibling matcher will pair them AFTER import. The pre-import signal should ideally coalesce (one row per event) but that's expensive without full metadata.
4. **The privacy line.** Some Zoom accounts host meetings the operator shouldn't see. Sighting via account-level API doesn't respect per-meeting ACLs. Might not matter for Agentics's use case but is a general concern.
5. **Notification vs surface.** Option C is "always-on know it exists"; Options A/D/E are "know it when I look." Different mental models — worth naming which the operator's mental model actually wants.

## Recommendation direction (not a decision)

Author-lean: **Option E (Import missing action) first, Option D (last-checked bookkeeping) as complement, Option A (per-day probe) if operators want more.**

Rationale:
- E costs one afternoon and directly addresses the "I have to import for that" pain by making the trigger obvious from Overview.
- D costs one small schema addition + one Calendar UI element and turns empty slots into *honest* signals ("empty because we haven't checked" vs. "empty because we checked and nothing"). No API calls.
- A is where operators end up asking after E+D if the two aren't enough — build then, informed by real use.
- B (ghost records) is architecturally interesting but earns its complexity only if provenance-before-import turns out to matter.
- C requires revising ADR-005's operator-triggered principle. Real change of contract; should not be casually accepted.

## What this ADR is NOT deciding

- Whether to implement any of A–F. This ADR exists to lay out the trade space.
- Whether ADR-005's "operator-triggered" principle should be revised.
- The exact schema for ghost records.
- The exact cron / scheduling infrastructure Option C would need.

## Open Questions

1. **Which option (or combo) does the group prefer?** Answer before implementation.
2. **Is ADR-005's operator-triggered contract negotiable?** — Option C hinges on this.
3. **Should Zoom / Fireflies discovery be gated by shared credentials only?** — Ties to ADR-042 shared-defaults; a per-operator source probe could exhaust one operator's quota for the whole org.
4. **How do sighted-but-not-imported entries interact with ADR-055 title alignment?** — If we run the resolver on a ghost record, we'd rewrite a title we haven't yet fetched. Probably don't run.

## References

- ADR-005 — Source integration strategy (operator-triggered principle)
- ADR-016 — Retrospective backfill uploader (existing worklist mechanic)
- ADR-035 — Persistence topology (shared state)
- ADR-042 — Server-side credentials with operator override
- ADR-047 — Automated Catch-Up (closest existing "operator triggers batch action" pattern)
- ADR-057 — UX hierarchy and activity-based navigation (this ADR's parent)
- `web/src/components/SyncStatusPanel.tsx` — the Overview surface all options extend
- `web/src/lib/backfill.ts:buildCalendarOverview` — the current target-day computation
