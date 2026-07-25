# ADR-055: Align YouTube-Live broadcast titles with dated series names used elsewhere

**Status**: Proposed
**Date**: 2026-06-19
**Deciders**: Architecture Team
**Related**: ADR-014 (publishing-attribute processing rules), ADR-019 (provenance graph), ADR-031 (server-side rule persistence), ADR-049 / ADR-050 (directional pair model), ADR-051 (born-on-YouTube auto-Published)

---

## Context

Records enter the catalog with titles from wherever they were captured. In practice, source-platform title conventions diverge sharply:

| Source | Typical title |
|---|---|
| Zoom | `AI Hackerspace Live - 6 Feb 2026` — dated, series-named |
| Fireflies | `Agentics Live Vibe - Coding - 19 Feb 2026` — dated |
| Loom | `New Recording 3` — often generic, undated |
| Kaltura | Varies — usually inherits from the uploader |
| **YouTube-Live** | `Livestream`, `AI Hackerspace Live`, `Agentics Live Vibe - Coding` — **often generic and undated** |

The dashboard renders records by title. When one operator sees `AI Hackerspace Live` on the YouTube-source row and `AI Hackerspace Live - 6 Feb 2026` on the paired Fireflies row, the same event visually looks like two different records at a glance. Sorting by title puts every generic-name broadcast adjacent to every other one; search-by-date-in-title doesn't find them.

The catalog audits earlier this month showed several concrete cases:

- YouTube `AI Hackerspace Live` (undated) ↔ Zoom / Fireflies pairs that already carry the dated title
- YouTube `Agentics Live Vibe - Coding` (undated) ↔ Zoom `Agentics Live Vibe - Coding - 19 Feb 2026`
- YouTube `Livestream - AF Master`, `Finland Agentics Meetup #2`, `Hackerspace Agentics Foundation` — undated, without paired canonicals but with clear series identities

ADR-014 introduced processing rules that transform *outbound publish* attributes using templates like `"{{title}} - {{date:D MMM YYYY}}"`. That solves the outbound side (uploads land with dated titles). It does **not** touch the catalog record's own title, so the *inbound* problem — YouTube ingest bringing generic names into the catalog — persists.

## Decision

Rewrite YouTube-source record titles at ingest time, and offer a retrospective Catch-Up pass for existing records. Two strategies in priority order:

### Strategy 1 — Inherit from paired canonical (preferred)

When the YouTube record has a `BroadcastedFrom` upstream link (per ADR-049 / ADR-050) to a canonical meeting-source record whose title already contains a recognised date form (`D MMM YYYY` or ISO), **copy the canonical's title as-is**. The canonical is authoritative for the event's identity; adopting its title is the strongest alignment signal available.

### Strategy 2 — Series-registry template

When no dated canonical exists, match the YouTube title against a **series registry** — an operator-maintained list of `{series_name, pattern}` entries. On match, construct `{series_name} - {D MMM YYYY}` using the record's `recorded_at`.

Example registry entries (persisted server-side per the ADR-031 pattern):

```json
{
  "entries": [
    { "series_name": "AI Hackerspace Live",           "pattern": "^AI Hackerspace Live" },
    { "series_name": "Agentics Live Vibe - Coding",   "pattern": "^Agentics Live Vibe\\s*-?\\s*Coding" },
    { "series_name": "Friday Hackerspace Live Events","pattern": "^Friday Hackerspace" },
    { "series_name": "Agentics Office Hours",         "pattern": "^Agentics Office Hours" }
  ]
}
```

The registry deliberately reuses ADR-014's `{{date:D MMM YYYY}}` vocabulary so an operator only has one date-format convention to reason about across the two ADRs.

### Safety guards

- **Already-dated titles are left alone.** Regex `\b\d{1,2}\s+(Jan|Feb|…|Dec)\s+\d{4}\b` (or ISO `\d{4}-\d{2}-\d{2}`) matches → no rewrite. Prevents double-dating and preserves operator edits.
- **Confidence gate.** No paired canonical AND no registry match → leave the title alone. We do NOT invent a series from thin air; the risk of miscategorising a one-off broadcast (guest interview, special event) is worse than leaving it generic.
- **Preserve the original.** Every rewrite stores the raw YouTube title in `metadata_extra.youtube_original_title` so nothing is lost. The card gains a "Show original YouTube title" affordance for inspection.
- **Manual override wins.** If an operator has manually edited the title after ingest (detectable via `title !== metadata_extra.youtube_original_title` AND no strategy previously fired), we don't touch it on subsequent passes. Idempotency comes from the registry match being a pure function of the current title — an already-normalised title won't match the pattern for the raw form.

### When the rewrite happens

- **At ingest time**: the C1-A backfill helper (`youtubeIngest.ingestYouTubeSourceRow`), the C3 forward-only post-publish path, and `YouTubeLiveImport.tsx` channel-poll import all call the resolver before `videoStore.add()`.
- **Retrospective**: a new maintenance card on the Catch-Up panel — **YouTube Title Alignment** — walks existing YouTube-source records and applies the resolver. Pre-flight count breakdown: `N will be renamed via pair, M via registry, K unchanged (already dated OR no confident inference)`.

Sits alongside the existing Catch-Up cards (broadcast-pair migration, YouTube row backfill, summary badge backfill). New colour family — orange — so the four maintenance affordances stay visually distinct.

### Implementation sketch

New pure resolver module `web/src/lib/youtubeTitleAlign.ts`:

```ts
export interface SeriesRegistryEntry {
  series_name: string;
  pattern: RegExp;
}

export interface AlignedTitle {
  new_title: string;
  original_title: string;
  source: "paired_canonical" | "series_registry";
  canonical_id?: string;          // when source = paired_canonical
  matched_series?: string;        // when source = series_registry
}

export function resolveAlignedTitle(
  record: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
  registry: SeriesRegistryEntry[],
  now: Date = new Date(),
): AlignedTitle | null
```

The resolver runs pure: no side effects, easily unit-testable. Consumers call it and decide whether to apply.

Consumer changes:

- `youtubeIngest.ts:ingestYouTubeSourceRow` — call `resolveAlignedTitle` after resolving canonical + before `videoStore.add()`.
- `YouTubeLiveImport.tsx:importSelected` — same, per record.
- New `web/src/lib/youtubeTitleAlignBackfill.ts` — Catch-Up card driver, parallel structure to `summaryBadgeBackfill.ts`.
- `VideoCard.tsx` — small affordance: a tooltip on the title showing the original if present, or an inline "Restore YouTube title" button under an "…" overflow.

### The registry — persistence & UI

Persisted as `data/series-registry.json` on the FUSE-mounted GCS bucket, following the ADR-031 server-side-rule-persistence pattern. Managed via a new small section in the Rules panel (or a new dedicated panel — deferred to implementation). Empty registry is fine — Strategy 1 (paired inheritance) still fires without it.

## Consequences

**Positive**
- Dashboard rendering consistent across paired records — an event and its captures all bear the same dated title.
- Sorting by title places same-series records adjacent; sorting by date remains unchanged.
- Search-by-date-in-title finds YouTube records too.
- Original YouTube title preserved in metadata; operator can inspect via the card affordance.
- Reuses ADR-014's date-format vocabulary — one convention to remember across two ADRs.

**Negative / careful**
- Editorial context in the YouTube title (guest name, episode number) may be lost from the *rendered* title. Mitigated by preserving in `metadata_extra.youtube_original_title` and surfacing on the card.
- The series registry is a new operator-maintained artifact — one more thing to configure. With an empty registry, only Strategy 1 fires.
- Rename is **catalog-only**. YouTube's own title (visible on YouTube itself) is untouched. Anyone comparing the catalog row to YouTube may see a divergence — worth noting in the operator guide.

**Risks**
- Same-day-same-series events produce duplicate dated titles. Not corruption — record identity is `record_id`, not title — but the dashboard shows two rows with identical titles. Mitigated by sort tiebreaker on `recorded_at` (time-of-day) and by leaving the operator free to edit either title manually.
- A retrospective rename via Catch-Up shuffles alphabetical views — visible churn during the migration. One-shot; acceptable.
- If a canonical record's title later changes, the paired YouTube row won't automatically follow (would require re-running the resolver). Documented in Open Questions.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Leave YouTube titles untouched (status quo) | The reported problem. |
| Reuse ADR-014 processing rules for catalog rewrites | ADR-014's trigger point is publish, not ingest — reusing it would require broadening its purpose across two lifecycle phases, muddying its scope. Sharing the *templating vocabulary* is cleaner than sharing the rule engine. |
| Pull YouTube's description first line as the title | Fragile — descriptions vary widely and are operator-editable free text. |
| Rename via YouTube Data API `videos.update` | Irreversible on YouTube's side, and outside the catalog's responsibility. The catalog aligns *its* view of the event; it doesn't attempt to rewrite the source of truth on YouTube. |
| Auto-generate a series pattern by clustering titles | Clever but opaque — hard to explain a wrong classification. Explicit registry is auditable and easily corrected. |
| Store `series_name` on the record instead of rewriting `title` | Would need every consumer (dashboard, VideoCard, provenance graph, summary lozenge) to know to compose the display title from `series_name + date` at render time. Higher blast radius than a title rewrite with a metadata preservation slot. |

## Open Questions

1. **Propagation on canonical title change.** If a Zoom record's title is manually edited to a different dated form later, should the paired YouTube record's title follow? Suggest: yes, via re-running the Catch-Up card. Track separately if operator flags a real case where this matters.
2. **Generic-name generalisation.** Loom recordings often carry generic titles (`New Recording 3`); Kaltura entries can too. Same pattern would apply — but the pair-inheritance strategy already works for Loom via `ClipOf` / `ScreenRecordingOf` (when present). Series-registry-for-Loom could ship as a follow-up ADR-056 if the case arises.
3. **Date format overrides per series.** Some series use `2026-02-19` style; others use `19 Feb 2026`; some use `Feb 19`. Registry could allow a per-entry format override. Deferred until operator surfaces a real preference.
4. **Registry UI location.** Rules panel section vs dedicated "Series" panel vs Connections panel. Implementation-time decision.
5. **Multi-registry-match tiebreak.** If two registry entries match the same title (rare but possible), pick the more-specific one (longer `series_name` wins) — or force the operator to disambiguate via a preview? Suggest: longer-name-wins default; surface the match count in the Catch-Up log so an operator can inspect.

## References

- ADR-014 — publishing-attribute processing rules; the templating vocabulary this ADR reuses (`{{date:D MMM YYYY}}`) and the point where dated titles were first applied (outbound publish path).
- ADR-019 — provenance graph; the `BroadcastedFrom` link Strategy 1 walks.
- ADR-031 — server-side rule persistence; the pattern the registry follows for cross-operator sharing.
- ADR-049 / ADR-050 — the directional-pair model that identifies which record is the canonical for pair inheritance.
- ADR-051 — YouTube ingest auto-Published; ADR-055 sits directly upstream of it (rewrite title before the auto-advance chain runs).
- ADR-052 — Summary Badge Backfill; ADR-055's Catch-Up card is a sibling on the same panel.
- Concrete pre-implementation examples in the catalog (June 2026 audit):
  - YouTube `AI Hackerspace Live` (undated) with dated Fireflies pairs
  - YouTube `Agentics Live Vibe - Coding` ↔ Zoom `Agentics Live Vibe - Coding - 19 Feb 2026`
  - YouTube `Livestream - AF Master`, `Finland Agentics Meetup #2`, `Hackerspace Agentics Foundation` — undated, without paired canonicals (Strategy 2 candidates if registry entries exist)
