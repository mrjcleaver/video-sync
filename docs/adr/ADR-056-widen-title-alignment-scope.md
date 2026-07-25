# ADR-056: Widen catalog title alignment beyond YouTube

**Status**: Accepted (implemented 2026-07-25)
**Date**: 2026-07-25
**Deciders**: Architecture Team
**Extends**: ADR-055 (YouTube-Live title alignment)
**Related**: ADR-050 (Fireflies as downstream of meeting source), ADR-053 (Transcript provenance lookup — the same safe-relations set)

---

## Context

ADR-055 targeted the specific case that surfaced first: YouTube-Live broadcasts with generic titles. Once shipped, the production catalog audit revealed the pattern is broader than YouTube. Snapshot from 2026-07-25:

| Undated title | Rows | Source platforms |
|---|---:|---|
| `Agentics Live Vibe - Coding` | 14 | 8 Fireflies + 6 Zoom |
| `Friday Hackerspace Live Events` | 15 | ~11 Fireflies + Zoom mix |
| `AI Hackerspace Live` | 11 | Mostly Fireflies |
| `Agentics Live Vibe Coding` (no hyphen) | 4 | 3 Fireflies + 1 Kaltura |

Most of the visual "many rows with the same title" problem is on **Fireflies** and **Zoom**, not YouTube. The ADR-055 gate `record.source_platform === "YouTube"` locks the resolver out of the majority of eligible records.

The pair-inheritance mechanism from ADR-055 was also artificially narrow — it only walked `BroadcastedFrom` upstream links. In practice the direction that usually carries the date is `TranscribedFrom → Zoom` (Fireflies bot capturing a meeting whose Zoom record has the date), or `SameEvent → paired` (either side of a peer capture pair).

## Decision

Widen ADR-055 in two places:

### 1. Drop the platform gate

`resolveAlignedTitle` and `findRecordsNeedingTitleAlignment` no longer restrict to `source_platform === "YouTube"`. Every catalog record participates.

### 2. Broaden `findPairedCanonicals` to all safe relations

The set matches ADR-053's transcript-safe-relations exactly:

| Relation | In safe set? | Rationale |
|---|---|---|
| `SameEvent` | ✅ | Peer capture of same event — either side can donate a dated title |
| `BroadcastedFrom` | ✅ | Broadcast destination inherits from meeting source |
| `TranscribedFrom` | ✅ | Transcript bot inherits from meeting source (the majority case) |
| `ClipOf` | ❌ | Clip is partial — its dated title doesn't identify the full source |
| `ScreenRecordingOf` | ❌ | Same partial-context reasoning as ADR-053 |

Direction is unchanged — the resolver walks `record.upstream_links` outgoing, matching the ADR-055 pattern. Adding incoming-direction walk (donor points AT record) is a natural extension already used by ADR-053's transcript resolver, but ADR-055's paired-canonical strategy stays outgoing-only for now — the common cases (Fireflies with `TranscribedFrom → Zoom`, YouTube with `BroadcastedFrom → Zoom`) are all outgoing.

### 3. UI copy update

Catch-Up card:
- Title: `🏷️ YouTube title alignment` → `🏷️ Catalog title alignment`
- Description: `undated YouTube-source titles` → `undated series-named titles`
- ADR reference: `(ADR-055)` → `(ADR-055/056)`

### 4. What's NOT changed

- **Field naming**: `metadata_extra.youtube_original_title` stays as-is for backward compat with the single record hand-patched under ADR-055 (`c9a05df3`). New rewrites via the retrospective backfill use `update_metadata` which can't touch `metadata_extra` anyway (WASM aggregate limitation carried over from ADR-055).
- **File / module naming**: `youtubeTitleAlign.ts` + `youtubeTitleAlignBackfill.ts` keep their names to avoid import churn. Rename deferred; a future contributor grepping for the resolver will find it via ADR-056's implementation section.
- **Ingest-time application for non-YouTube sources**: still deferred. `youtubeIngest.ts` applies Strategy 2 (series-registry) at first-ingest for YouTube. Fireflies / Zoom / Kaltura / Loom import paths don't yet call the resolver at ingest; the retrospective Catch-Up card catches them. If real ops pain emerges, wire in per-platform later.

## Implementation

- `web/src/lib/youtubeTitleAlign.ts` — drop the `!== "YouTube"` gate; widen safe-relations set in `findPairedCanonicals`.
- `web/src/lib/youtubeTitleAlignBackfill.ts` — drop the `!== "YouTube"` gate in `findRecordsNeedingTitleAlignment`.
- `web/src/components/CatchUpPanel.tsx` — update card title + description copy.
- Tests: extend `youtubeTitleAlign.test.ts` with TranscribedFrom + SameEvent inheritance cases; verify non-YouTube records are eligible.

## Consequences

**Positive**
- One resolver run catches the ~40+ undated series-named records visible in the production catalog, not just the 4 YouTube-source ones.
- Fireflies transcript-bot captures inherit their paired Zoom's dated title via TranscribedFrom — the exact case that produced the most visual dashboard clutter.
- SameEvent pair inheritance lets either side of a peer capture donate a date to the other.

**Negative / careful**
- Module name (`youtubeTitleAlign`) is now a misnomer. Documented; rename deferred.
- More records eligible means the retrospective backfill's per-run cost grows. No new API calls per record (the resolver is pure), so cost stays negligible.
- Strategy 1's paired-canonical scan now considers more link relations per record. `O(records × avg_links_per_record)` — bounded and small in practice.

**Risks**
- SameEvent is bidirectional and less semantically strict than the directional relations. A rare failure mode: two records get linked as SameEvent by the sibling matcher but were actually different events with similar titles — the resolver could then propagate a wrong date. Mitigated because SameEvent is only auto-linked at ≥ 0.85 confidence (ADR-033), and the title-alignment rewrite is idempotent + reversible (operator can edit the title back).

## Alternatives considered

| Option | Why rejected |
|---|---|
| Add ingest-time application to Fireflies / Zoom / Kaltura import paths | Larger surface area than needed for the reported symptom. The retrospective card + widened resolver already picks up everything. Wire per-platform later if operators want first-ingest normalisation. |
| Rename `youtubeTitleAlign.ts` → `titleAlign.ts` in this PR | Four import sites to update. Cheap but adds unrelated diff churn. Defer. |
| Include ClipOf / ScreenRecordingOf in the paired-canonical scan | Same partial-audio-context concern as ADR-053. Clip's title represents a subset of the source; inheriting its title onto the full source would be wrong. |
| Add incoming-direction walk (donors that point AT the record via safe relation) | Symmetric with ADR-053's transcript resolver. Common cases (Fireflies → Zoom, YouTube → Zoom) all outgoing, so defer until incoming-only case appears. |

## Open Questions

1. **Rename `youtube_original_title`** metadata_extra field to `catalog_original_title`? Only one production record has the field today. Trivial to migrate; deferred until the field is used more broadly.
2. **Ingest-time application for non-YouTube sources.** Depends on whether operators surface title clutter on freshly-ingested Fireflies / Zoom records. Retrospective card handles it today; forward-only wire-up would just remove the between-import-and-catchup gap.
3. **Rename the module + Catch-Up card icon**. `🏷️` still reads. Full file rename can bundle with the field rename above.

## References

- ADR-055 — the YouTube-scoped predecessor.
- ADR-050 / ADR-053 — the safe-relations set this ADR reuses.
- 2026-07-25 catalog audit — the production-scale evidence that motivated the widening.
