# ADR-049: Live-stream Provenance — Zoom-to-YouTube Broadcasts

**Status**: Proposed
**Date**: 2026-06-03
**Deciders**: Architecture Team
**Related**: ADR-019 (provenance graph — locations + upstream_links), ADR-033 (multi-origin dedupe / sibling matcher), ADR-040 (broaden source imports — added YouTube Live), ADR-046 (prompt-driven summaries), ADR-047 (automated catch-up), ADR-048 (date-distance gates in matchers)

---

## Context

YouTube Live broadcasts that were actually broadcast **from** another platform (typically Zoom, often relayed via Restream or StreamYard) currently produce a catalog mess. Concrete example provided by the operator:

```
Record 779fabe6-9444-4938-9afa-f0fd07daa88f
  source_platform: YouTube
  source_id:       youtube-WQov-UkWpoA
  locations:
    - Origin       · YouTube · youtube-WQov-UkWpoA
    - Destination  · YouTube · WQov-UkWpoA          ← same video, prefix-stripped
  upstream_links:
    - SameEvent · Zoom · zoom-Avhl0s0sRCuIfF7y0pM28w== · linked_by: Auto

Record 2b3a0f82-0b31-46d7-b1bf-af22d3bf7849
  source_platform: Zoom
  source_id:       zoom-Avhl0s0sRCuIfF7y0pM28w==
  ...                                                 ← the actual recording
```

Three distinct problems compound here:

1. **Duplicate same-video location** on the YouTube record. The Origin (created by `VideoRecord::index()` at import time from `source_platform`+`source_id`) and the Destination (added by a later flow — auto-association banner / mark_published / + Location) both point to the same YouTube video. The data model doesn't enforce dedupe across roles when the platform+id are the same.

2. **Inverted origin semantics**. YouTube is recorded as the Origin, but the video was actually produced on Zoom and broadcast through YouTube Live (often via Restream's RTMP relay). The Zoom recording is the real origin; the YouTube Live entry is a *destination*. The sibling matcher detects them as "Same session", which is true but understates the directional relationship — Zoom → YouTube is causal, not peer.

3. **Two catalog records for one logical event**. The Zoom side-imported as record `2b3a0f82-…`; the YouTube Live side-imported as record `779fabe6-…`. Both describe the same session. Operators see two of everything — two summaries to consider, two publish flows, two card-state checks, two destinations to coordinate. The sibling-link banner mitigates but doesn't resolve the duplication.

This pattern is the norm, not the exception, for the operator's content (Friday Hackerspace Live Events, AI Hackerspace Live, etc.).

## Decision

Three coordinated changes, each independently useful:

### 1. Suppress same-video location duplicates

`VideoRecord::add_location` and `mark_published` already check for duplicate `(platform, external_id)` before pushing. Extend this check to **normalise the external_id** (strip the `youtube-` / `zoom-` / `fireflies-` / etc. source-id prefix) before comparison. A record whose Origin location is the same YouTube video as a proposed Destination location keeps only one entry — the operator sees `Origin: YouTube · WQov-UkWpoA`, no Destination of the same video, no "Check Status" against itself.

Live broadcasts that *are* their own destination (born-on-platform) are conceptually Origin-only. The "Destination" semantic is reserved for downstream publishes — not for the platform the record was discovered on.

### 2. Auto-classify Zoom-to-YouTube broadcasts via a new upstream relation

When the sibling matcher (`rankSiblingCandidates`) detects a YouTube-Live record (`metadata_extra.live_broadcast === "1"` or tag includes `youtube-live`) paired with a record from a known "broadcaster" platform (Zoom; later Streamyard, OBS, Wirecast), the auto-link relation is no longer `SameEvent` — it's a **new relation `BroadcastedFrom`**.

`BroadcastedFrom(youtube_record → zoom_record)` carries directional intent:

- Zoom is the upstream Origin.
- YouTube is the broadcast destination.
- The provenance graph reads: *Zoom recording → broadcast to YouTube Live*.

Existing `SameEvent` links remain for non-directional cases (Zoom + Fireflies of the same meeting, where neither broadcast to the other).

### 3. Pair-aware rendering — one logical card by default

In the dashboard, when two records are linked by `BroadcastedFrom`, the canonical card is the **upstream** one (Zoom in the typical case). The YouTube-Live record collapses into it as a "broadcast destination" badge:

```
Friday Hackerspace — 3 Apr · Zoom (origin)
  📺 Broadcast to YouTube Live · WQov-UkWpoA · 2h12m
  Drive · 📄 M:8 L:5 T:3 C:2 · 🔒 ...
```

The YouTube-Live record stays in the catalog (single-source-of-truth still works for the YouTube ID, view count, etc.) but is hidden from the default dashboard view. An "Show paired records" filter chip reveals it for debugging or manual editing.

Publish flow on the canonical (Zoom) card understands that YouTube is *already populated* via the broadcast — no "Publish to YouTube" button, because it's already live. The card can offer "Side-publish to Kaltura" as the remaining destination action.

### Detection logic

The trigger for `BroadcastedFrom` (vs. `SameEvent`):

```
isBroadcastedFrom(youtube_record, candidate_record):
  if youtube_record.source_platform != "YouTube": return false
  if youtube_record.metadata_extra.live_broadcast != "1"
     and !youtube_record.tags.includes("youtube-live"): return false
  if candidate_record.source_platform not in {"Zoom", "Streamyard", "OBS", "Wirecast"}: return false
  // Sibling matcher's existing time-delta gate (ADR-048) applies first.
  // For broadcasts, the Zoom recording's recorded_at and YouTube's
  // actualStartTime should be near-simultaneous (Restream typically
  // adds < 5s of delay). Tighten the time score requirement
  // specifically for BroadcastedFrom — same minute = high, same hour
  // = medium, same day = drop the broadcast designation but keep
  // SameEvent.
  return time_delta_minutes <= 60
```

Description-scan for "Restream" / "StreamYard" / "RTMP" signatures is *not* part of the trigger — easy to do but fragile (operators edit descriptions freely). The sibling-match-plus-platform-pair is the durable signal.

### When YouTube Live is the earliest catalog row (no meeting source available)

Symmetric to [ADR-050's Fireflies-as-fallback-canonical case](ADR-050-fireflies-transcribed-from-zoom.md#when-fireflies-is-the-earliest-catalog-row-no-zoom-upstream-available). Two operational realities make a YouTube Live record arrive with no upstream meeting source in our catalog:

- **OBS / Streamyard / Wirecast streamed directly to YouTube Live without a Zoom session in the loop.** No upstream meeting source ever existed.
- **A Zoom session DID host the meeting, but on an account the operator doesn't own / can't import.** The Zoom record exists in the world; it just doesn't exist for us. The YouTube Live broadcast is then the earliest catalog row we have for that event.

Audit on 2026-06-07 found this is the **majority case** for YouTube Live rows in the current catalog (6 of 9; 2 of the remaining 3 are correctly `BroadcastedFrom → Zoom`, and 1 is `SameEvent → Fireflies` — both downstreams of an absent Zoom). The matcher must not invent a Zoom record that isn't there.

Operating rule for the matcher / migrations:

- `BroadcastedFrom` is emitted *only* when both sides exist in the catalog. If no meeting-source record matches the YouTube Live record within the 60-min gate, the YouTube Live row stays standalone — it has no upstream link, and it is its own canonical for any downstream pair purposes (e.g. a Kaltura side-publish from this row pairs against it directly).
- If both a YouTube Live row and a Fireflies row exist *without* a meeting-source upstream (the `b8ebdf87` shape), they remain peers under `SameEvent`. No directional collapse, both shown — this is correct, because neither is causally upstream of the other; they are both peer captures of an absent meeting.
- An existing standalone YouTube Live record does **not** become an orphan when a Zoom record is later imported. The next sibling-matcher / catch-up pass picks up the new pair and writes the `BroadcastedFrom` link forward.
- Downstream pair-aware UI (badges, "already published" gating, broadcastPairs index) is canonical-agnostic on the platform — keyed off "any record with incoming `BroadcastedFrom` / `TranscribedFrom` upstream links", not off Zoom specifically.

This rule and ADR-050's Fireflies counterpart together establish the general invariant: **the canonical for collapse purposes is whichever record is earliest in the upstream chain that exists in our catalog**, regardless of whether that's the semantic origin. The semantic origin (an inaccessible Zoom call) is honoured by its absence — no fictitious node is created.

## Implementation slices

| Slice | Scope |
|---|---|
| **1. Location-dedupe normalisation** | Rust `add_location` + `mark_published` normalise external_id (strip platform prefix) before duplicate check. Returns success without push when the normalised pair already exists in any role. Backfill migration: a one-shot script that removes duplicate Origin/Destination pairs on the same video across the catalog. |
| **2. `BroadcastedFrom` relation** | New `DerivationType` variant. WASM `link_upstream` accepts it. Sibling matcher emits it when the platform pair + live-broadcast signature matches. Existing `SameEvent` auto-links from prior runs stay; new runs prefer `BroadcastedFrom`. |
| **3. Pair-aware Overview + card collapse** | `BackfillOverview` renders the canonical (upstream) row only; the broadcast-destination card becomes a sub-line beneath. `VideoCard` for the upstream card surfaces a "📺 YouTube Live · {id}" badge; for the broadcast card a "(Broadcast of {parent})" tag. Filter chip "Show paired records" reveals collapsed entries. |
| **4. Publish-flow integration** | When the canonical card has a `BroadcastedFrom`-paired YouTube record, the publish button changes: YouTube is "Already broadcast" (with link), so Kaltura side-publish is the active action. |

## Consequences

**Positive**
- One record per logical event — operators stop curating duplicates.
- The provenance graph reads correctly: Zoom origin → YouTube broadcast destination.
- Bulk operations (catch-up, bulk summarise) hit each event once, not twice.
- Sibling-detected pairs become a first-class concept in the UI, not just a banner.

**Negative**
- The collapse hides a record by default. Operators who used to find the YouTube-Live entry in the Active list will be surprised at first. Mitigated by the toggle chip and a one-time onboarding hint.
- Existing data has duplicate `Origin`+`Destination` entries; migration touches the catalog and needs care to be reversible.
- `BroadcastedFrom` is a new derivation type — Rust enum bump + serde-compatible migration so old catalog.json deserialises.

**Risks**
- The platform-pair heuristic misses non-Zoom broadcasters (Riverside, Descript Rooms, etc.). Adding them is mechanical but uncovered broadcasters will appear as `SameEvent` until the list grows.
- "Broadcast paired" records still need their own metadata (privacy status, live duration, chat capture). The collapse must not break access to those fields — confirmed by exposing them on the canonical card.
- Description-scan rejected here; if it turns out the platform-pair signal misses too often, that's the fallback (with all its fragility).

## Alternatives considered

| Option | Rejected reason |
|---|---|
| **Merge into a single record at sibling-link time** | Destructive; loses ability to debug source records independently; record_id semantics break for any external system holding catalog IDs. Pair-aware rendering achieves the operator-facing benefit without the irreversible merge. |
| **Detect via Restream/StreamYard description signature** | Fragile — operators edit descriptions, the signature can be removed; non-Restream broadcasters wouldn't show signatures. Use as a future supplement to the platform-pair signal, not the primary signal. |
| **New `LocationRole::Broadcast`** distinct from Destination | Adds a third axis (Origin/Intermediate/Destination/Broadcast) that's hard to reason about. The existing Origin/Destination axes suffice once the duplicate is suppressed and the upstream relation is directional. |
| **Manual operator declaration only** ("Mark this as broadcast of …") | We already auto-link via the sibling matcher; not reusing that signal is wasted effort. Manual override remains available for edge cases. |

## Open Questions

1. **Should `BroadcastedFrom` time-delta be tighter than the 30-hour sibling gate?** Broadcasts and their source recordings start near-simultaneously (RTMP relay delay is seconds, not hours). A tighter gate (say ≤ 60 minutes) would reduce false `BroadcastedFrom` classifications while preserving `SameEvent` for genuine cross-source captures. Suggested default in the implementation sketch above.
2. **Migration policy for existing data.** The catalog already contains records like `779fabe6-…` with duplicate locations and `SameEvent` (instead of `BroadcastedFrom`) auto-links. A backfill script can dedupe locations and re-classify links. Should it run automatically on next deploy, or be operator-invoked? Suggest operator-invoked with a Catch-Up panel stage so the result is visible and reversible.
3. ~~**What about pre-Zoom broadcasters?**~~ **Resolved 2026-06-07** — promoted to a documented rule. See [Decision § When YouTube Live is the earliest catalog row](#when-youtube-live-is-the-earliest-catalog-row-no-meeting-source-available) below.
4. **Restream-mediated broadcasts** sometimes appear in the YouTube description as "Streamed live via Restream"; useful signal for confidence but not load-bearing. Document for a possible future enhancement.

## References

- ADR-019: Provenance graph — locations + upstream_links model this ADR extends
- ADR-033: Multi-origin dedupe — the sibling matcher whose detection this ADR repurposes for direction
- ADR-040: Broaden source imports — added YouTube Live as a source, surfaced this issue
- ADR-046: Prompt-driven summaries — currently summarises each paired record independently; this ADR's collapse means one summary per pair
- ADR-047: Automated catch-up — its auto-link stage produces `SameEvent` links today; would emit `BroadcastedFrom` instead under this ADR
- ADR-048: Date-distance gates — the time-delta plumbing this ADR builds on for the broadcast-specific tighter gate
- Concrete example: catalog records `779fabe6-9444-4938-9afa-f0fd07daa88f` (YouTube) + `2b3a0f82-0b31-46d7-b1bf-af22d3bf7849` (Zoom)
