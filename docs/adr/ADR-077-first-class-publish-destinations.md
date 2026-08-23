# ADR-077: First-Class Publish Destinations — Per-Destination Outcomes

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-08-23 |
| **Deciders** | Engineering, Content Operations, Kaltura administrator (for §5's access-control mapping) |
| **Supersedes** | — |
| **Related** | ADR-002 (unified metadata schema — the `destination_*` fields), ADR-012 (YouTube publish integration), ADR-016 (retrospective backfill uploader), ADR-022 (description provenance footer), ADR-037 (Kaltura publish), ADR-042 (shared credential vault), ADR-044 (Kaltura presence sweep), ADR-049 (location dedupe + external-id normalisation), ADR-051 (ingest status auto-advance), ADR-068 (bulk YouTube description sync), ADR-074 (canonical artifact bag), ADR-075 (series-driven destinations), ADR-076 (consumer contract) |

---

## Context

ADR-075 Phase 2 gave series an authoritative `DestinationSpec[]` covering YouTube, Kaltura, Google Drive and an `Other` escape hatch. It shipped, and the declaration model works. A gap analysis of the publish path on 2026-08-23 found that the declaration is not carried through to execution, verification, or measurement.

The two ends of the pipeline are already platform-neutral:

- **Declaration** — `DestinationSpec[]` on the series registry, edited per platform in `SeriesDestinationsEditor.tsx`.
- **Storage** — `locations[]` entries with `role: Destination`, one per platform, deduped by normalised external id (ADR-049).

What is missing is the middle. **There is no per-destination outcome anywhere in the system.** Nothing records "this series declared three destinations, two were attempted, one landed, and here is the visibility each actually has." Every YouTube-centric behaviour downstream is a consequence of that single absence:

| Symptom | Location |
|---------|----------|
| `destination_id` / `destination_url` are scalars — a second destination overwrites the first, leaving the scalars and `locations[]` disagreeing | `src/catalog/video_record/mod.rs:309-310` |
| YouTube is the domain-level default for an unspecified publish | `mod.rs:312` — `cmd.destination_platform.unwrap_or(Platform::YouTube)` |
| `mark_published` is only legal from `Publishing`, so peer destinations use `add_location` and bypass the state machine entirely | `mod.rs:297-303`, `VideoCard.tsx:1176` |
| The emitted `StatusChanged` event carries no destination payload | `mod.rs:336-342` |
| A partial publish is unrepresentable — two of three destinations landing yields the same `Published` as three of three | status enum |
| Bulk / backfill / shorts publish never resolve destinations at all | `BackfillPanel.tsx:213`, `shortsPublish.ts:137` |
| Kaltura and Drive push media but never apply the declared visibility | Kaltura upload body has no access-control id; `/api/drive/publish` sets no permissions |
| Only YouTube's visibility can be read back; the `accessControlId` Kaltura already returns is discarded | `youtubePrivacyCache.ts` vs `api/kaltura/status/route.ts:85` |
| Completeness is measured against a hardcoded YouTube-and-Kaltura pair, not the declared set | `catchupOrchestrator.ts:391-398` |
| ADR-076 §3's "public on YouTube or Kaltura" visibility rule is unevaluable, so the consumer gate stands in on `status = Published` | ADR-076 §3 implementation note |

A first fix landed in `bab5110`: `isAutomatedDestination()` had claimed YouTube-only automation long after the Kaltura (ADR-037) and Drive (ADR-075 §Follow-up #4) endpoints shipped, so the publish preview labelled working automation "⚠ manual". Correcting it surfaced a distinction this ADR builds on — **pushing the media and applying the declared visibility are separate capabilities**, and only YouTube has both. That is now explicit as `appliesDeclaredVisibility()`.

ADR-075's own follow-up list is the honest scorecard: #1 and #4 shipped, #2 partially (preview rows are read-only), #3 is recorded as "unbuilt" but shipped with ADR-037, and #5, #6, #7 and #8 are unbuilt.

---

## Decision

A destination is first class when four facts exist **per destination**: it was *declared*, it was *attempted*, it *landed*, and its visibility is *verified*. YouTube has all four. The others have one and a half. The following six sections each add one of those facts to the remaining platforms. The order is forced — conformance cannot be measured against outcomes that are not recorded.

### 1. Per-destination outcomes in the aggregate

`src/catalog/video_record/mod.rs` gains:

```rust
pub struct DestinationOutcome {
    pub platform: Platform,
    pub declared_visibility: Option<String>,   // what the series asked for
    pub state: OutcomeState,                   // Pending | Pushed | Failed | Skipped
    pub external_id: Option<String>,
    pub external_url: Option<String>,
    pub pushed_at: Option<DateTime<Utc>>,
    pub observed_visibility: Option<String>,   // last read-back (§5)
    pub observed_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
}
```

carried as `destination_outcomes: Vec<DestinationOutcome>` on the record, with three commands:

- **`begin_publish`** — seeds one `Pending` outcome per resolved destination and moves `Approved → Publishing`.
- **`record_destination_result`** — updates one outcome, pushes the `locations[]` entry, emits `DestinationPublished` (or `DestinationFailed`). **Legal from both `Publishing` and `Published`**, which is what removes the `add_location` side door: a peer destination becomes a real event-sourced publish rather than a silent location edit.
- **`record_observed_visibility`** — for the §5 verify sweep.

Two deliberate cost controls:

- **`destination_id` / `destination_url` survive as derived read-only accessors** over the primary outcome (first `Pushed`, preferring YouTube for continuity). Only 24 sites across 6 files read them; none has to change.
- **No migration script.** When `destination_outcomes` is empty, synthesise `Pushed` outcomes from existing `locations[]` entries with `role: Destination` on read. Idempotent, no backfill job, and it avoids repeating ADR-075 §Follow-up #5, which was specified as a one-off script and never built.

`Published` continues to mean "at least one destination landed" (ADR-075's leaning, now committed — see §Open questions). A new derived `is_fully_published()` means "every declared non-`Other` outcome is `Pushed`", and that is what §6 measures.

The `DestinationPublished` event discharges ADR-075 §Follow-up #7.

### 2. Destination resolution usable outside the browser

`resolveDestinations()` is nearly pure already; it reaches for `getSeriesRegistryConfigCached()` internally and its callers supply rules from `localStorage`. Pass the registry config in as a parameter, then add a server-side entry point that reads the registry and `data/rules.json` from disk.

Processing rules are already persisted server-side by `/api/rules`, so this needs no new storage — `localStorage` is a cache, not the system of record. This section is independent of §1 and can ship on its own. It unblocks every headless path: cron, MCP, bulk publish, and the §6 conformance sweep.

### 3. One executor, one adapter per platform

`lib/publish/adapters/{youtube,kaltura,drive}.ts`, each exposing `push()` and `applyVisibility()`. `lib/publish/execute.ts` walks the resolved destination set, dispatches each spec to its adapter, and records an outcome per destination via §1 — **each succeeding or failing independently**, which is the sequencing ADR-075 specified ("Publish button pushes each destination in sequence") and never got.

The ADR-022 provenance footer, currently duplicated verbatim at `VideoCard.tsx:869` and `:1110`, moves into one builder with the character cap as a **per-platform parameter**. That is what stops Kaltura inheriting YouTube's 5000-character truncation, which it has no equivalent limit for.

`BackfillPanel.tsx` and `shortsPublish.ts` then call the executor instead of posting directly to `/api/youtube/upload`, which is what ADR-075 said the bulk and backfill paths would do.

### 4. Publish preview gains real per-destination control

ADR-075 §Follow-up #2, finished. The preview rows become editable — add, remove, and change visibility per destination before the click, with the resolution provenance still shown, and overrides applying to this publish only (never persisting back to the series). Each row carries its own result state after the click, reading from the §1 outcomes.

### 5. Apply visibility, then read it back

Both halves land together; read-back alone would verify a value nothing sets.

- **Apply** — send an access-control id with the Kaltura upload; set file permissions per `share_scope` in `/api/drive/publish`. Note that Drive's current behaviour (inherit the folder's sharing) is correct by accident for `share_scope: inherit` and silently wrong for `org_restricted` and `anyone_with_link`.
- **Read back** — consume the `accessControlId` that `api/kaltura/status/route.ts:85` already returns and discards; add a Drive permissions read. Generalise `youtubePrivacyCache` from "YouTube privacy" into a per-destination observed-visibility cache writing through to §1's `observed_visibility`.

**External dependency:** Kaltura access-control profile ids are partner-specific. There is no universal `public` / `members` / `unlisted` → id mapping; the org's KMC administrator must supply ours, and it needs a home (the ADR-042 credential vault, or per-series config). This is the only part of this ADR blocked on someone outside engineering.

On completion, `appliesDeclaredVisibility()` returns true for all three platforms and the preview's "set visibility by hand" note retires itself.

### 6. Conformance replaces presence as the measurement

The measurement operators actually asked for: **declared minus landed**, per record and in aggregate.

- `isPublishable()` (`catchupOrchestrator.ts:391`) drops `!hasYouTube || !hasKaltura` in favour of "some declared destination is not yet `Pushed`". This fixes two live defects: a YouTube-only series currently reports publishable forever because it will never have Kaltura, and a Drive-only or `Other` series is invisible to the catch-up sweep.
- The overview lozenges render one state per *declared* destination rather than a YouTube privacy lozenge beside Kaltura and Drive booleans.
- Bulk publish shows the pre-flight per-destination counts ADR-075 described ("150 → YouTube, 82 → Kaltura, 82 → Drive").
- The `Other` variant gains an operator acknowledgement so a declared manual target can be marked done — see §Open questions for whether it counts in the denominator.

### 7. Consumer contract stops being YouTube-shaped

- New `get_destinations` MCP tool returning the declared set alongside per-destination landed state and observed visibility.
- `search_records` results gain a destinations summary (additive, per ADR-076 §4's compatibility rule).
- `get_description`'s "prefers the last-pushed YouTube snippet" wording is neutralised; `get_youtube_snippet` stays as a platform-specific extra rather than the shape other platforms are expected to copy.
- **ADR-076 §3 amendment.** Its first visibility rule — records public on YouTube *or* Kaltura — becomes evaluable for the first time: the Viewer gate reads `observed_visibility` per destination instead of standing in on `status = Published`. Until then the §3 implementation note stands as written.

---

## Consequences

### Positive

- "Where did this recording go, and is it visible where we said it would be" becomes answerable per record, from the event log, for every platform.
- A partial publish stops being invisible. Two of three destinations landing is now a distinct, queryable state rather than an indistinguishable `Published`.
- Adding a fifth platform becomes an adapter plus a `DestinationSpec` variant, not a fourth bespoke publish handler with its own credential plumbing and footer copy.
- Bulk, backfill, shorts and interactive publish converge on one code path, so a fix to trimming, footers or error classification lands everywhere at once.
- Kaltura and Drive declarations become enforceable rather than decorative, which is the difference between a destination being configurable and a destination being real.

### Negative

- §1 touches the Rust aggregate and its wasm bindings — the highest-risk change in the plan, and the one that gates four of the other six sections. The derived-accessor and synthesise-on-read choices exist specifically to keep its blast radius to the aggregate.
- Consolidating three publish handlers into adapters is a large mechanical diff over `VideoCard.tsx`, a file already well past the 500-line guideline. Expect the consolidation to make it worse before a later split makes it better.
- §5 cannot complete without the Kaltura access-control mapping. If that input does not arrive, Kaltura visibility stays unenforced and §6's conformance number has to treat Kaltura visibility as unknown rather than wrong.
- More states to explain. "Uploaded but visibility not applied" is a genuinely new concept for operators, even though it is a truthful description of what has been happening silently all along.

### Neutral

- The `DestinationSpec` union and the series editor are unchanged; §§1-7 are downstream of a declaration model that already works.
- `Published` semantics are preserved, so existing dashboards, filters and the ADR-076 consumer gate keep working through the transition.
- `youtubeTitleAlign.ts` remains the home of the `DestinationSpec` type. Cosmetically wrong — it is where a new engineer learns the model — but moving it is churn without behaviour change; deferred.

---

## Deferred / Follow-ups

1. **Title and description sync per destination.** ADR-068's sync audit is YouTube-only down to its endpoint and status vocabulary (`yt_empty`, `missing_on_yt`). A neutral equivalent needs per-platform metadata read-back, which §5 starts but does not finish.
2. **`Other` as a first-class platform.** `Platform` (`value_objects.rs:34`) has no `Other` variant, so a declared Vimeo target can hold neither a location nor an outcome. Either add a labelled variant — touching serde across the aggregate — or track `Other` acknowledgements outside the enum. §6's acknowledgement affordance needs whichever is chosen.
3. **Per-destination retry.** `ToRetry` is a whole-record status; a single failed destination should be retryable without re-pushing the ones that succeeded.
4. **Destination-level processing rules.** ADR-075 §Follow-up #6 (`transforms.destinations`) stays unbuilt; rules still speak only `privacy_status`, which §1 narrows to the YouTube outcome.
5. **Move `DestinationSpec` out of `youtubeTitleAlign.ts`** into its own module.
6. **`notifications/list_changed`** so a consumer can invalidate on a destination landing rather than polling (also ADR-076 §Deferred #2).

---

## Open questions

1. **Does a partial publish mean `Published`?** §1 commits to yes — "at least one destination landed" — because it preserves every existing consumer. But that choice now carries a consequence it did not when ADR-075 raised it: ADR-076 §3 makes `Published` the gate for what an external chapter website can see, so a Drive-only publish would expose a record to a public site with no public video behind it. §7's amendment (gate on `observed_visibility`, not status) is the mitigation, which means **§7 is not optional if §1 lands as specified**. Confirmation needed from Content Operations.

2. **Does the YouTube global default survive?** A record matching no series becomes a YouTube record by construction (`destinationResolver.ts:65`). The registry already carries a `youtube_fallback_when_no_series_match` toggle, so the machinery to disable it exists. Neutrality argues for defaulting to no destinations and making the operator choose; convenience argues for the status quo. Leaning: keep the default, flip the toggle off for new deployments.

3. **Does a declared `Other` destination count in the conformance denominator?** If it does, a manual Vimeo target keeps every matching record permanently incomplete until someone ticks it off — which requires Deferred #2 first. If it does not, the checklist stops being a commitment and goes back to being a reminder. Leaning: count it, but only once the acknowledgement affordance exists; until then exclude it and say so in the conformance label.
