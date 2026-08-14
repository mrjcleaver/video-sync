# ADR-075: Series-Driven Destinations + Per-Platform Visibility

| Field | Value |
|-------|-------|
| **Status** | Accepted — Phase 2 MVP shipped 2026-08-11; Phase 1 (interim default flip) rejected in favour of Phase 2 |
| **Date** | 2026-08-10 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | Prior implicit default (`unlisted`) established in ADR-013 / ADR-016 |
| **Related** | ADR-013 (batch ingestion rules), ADR-016 (retrospective backfill), ADR-035 (processing rules), ADR-055/056 (series registry + title alignment), ADR-068 (bulk description sync), ADR-071 (Drive ingest), ADR-074 (canonical artifact bag) |

---

## Context

The Agentics Foundation publishes recordings across multiple platforms. A single meetup can want to land on:

- YouTube (public — subscribers should see it)
- Kaltura (the org's chosen catalog surface for a chapter's members)
- A Google Drive folder (the chapter's own archival copy)

The current model doesn't reflect that shape. It has:

- A single `default_privacy: "private"|"unlisted"|"public"` per backfill profile — YouTube-specific.
- A `PublishAttributes.privacy_status` computed by `applyProcessingRules()` — also YouTube-specific.
- No destination concept beyond YouTube in the publish flow.

Two problems fall out:

1. **The default was wrong.** `applyProcessingRules()` initialised `privacy_status: "unlisted"` and every existing surface inherited that. Operators had to click the privacy dropdown to `public` on every Publish preview (or edit each profile). The operator ask was: *"Ensure the videos go up publicly to YouTube."*
2. **The model is too narrow.** Publishing a recording is a set of destinations, not a single YouTube video with a privacy flag. Kaltura has its own visibility model (public / members-only / with a category id). Google Drive folder targeting has its own semantics (share scope, folder id). The current single-privacy-field can't express any of that; operators paper over it by running per-platform batches by hand.

The series registry (ADR-055/056) is already the natural home for "this series publishes to X with Y visibility" — series knows the pattern that identifies which records it covers, and operators reason about series when planning content. Series should own destinations.

---

## Decision

### Phase 1 — Rejected

A prior version of this ADR proposed flipping the base default from `unlisted` → `public` at every layer while Phase 2 was designed. On review, operators asked to skip that interim and land Phase 2 directly — series-driven destinations give the same operator-intent-matching outcome without a global default flip that could surprise other consumers of `applyProcessingRules()`. The `unlisted` base default is retained. Both the stored FUSE profile and the code defaults stay at `unlisted`; the profile-level override lives inside each series entry.

### Phase 2 — MVP shipped

Series registry gains a `destinations` array where each entry names a target platform and its platform-specific config. The series definition becomes the authoritative source for "where does this go and how visible is it there" for records matching the series pattern.

#### Data model

`SeriesRegistryEntry.destinations` becomes `DestinationSpec[]`, a discriminated union by `platform`:

```ts
type DestinationSpec =
  | { platform: "YouTube";
      visibility: "public" | "unlisted" | "private";
      // Optional overrides for playlist / category. When absent,
      // the org defaults apply.
      playlist_id?: string;
      category_id?: string;
    }
  | { platform: "Kaltura";
      // Kaltura's own visibility model — public means listed in
      // the org's KMC catalog; members means requires KMS login;
      // unlisted is an entry created with no category membership.
      visibility: "public" | "members" | "unlisted";
      category_ids?: string[];
    }
  | { platform: "GoogleDrive";
      folder_id: string;         // Shared Drive / My Drive folder
      // Drive's own model: what gets set on the file after
      // upload. "inherit" means "use whatever the folder has".
      share_scope: "inherit" | "org_restricted" | "anyone_with_link";
    }
  | { platform: "Other";
      // Escape hatch for a platform we haven't formalised yet
      // (Vimeo, Twitch, etc.). Carries a free-form config bag
      // and a human-readable label. Interactive publish surfaces
      // this as a "manual — see notes" step, not an automated push.
      label: string;
      config: Record<string, string>;
    };
```

The `"Other"` variant is deliberate: it lets operators DECLARE a destination that isn't wired to an automated push. Interactive Publish shows a checklist item (unchecked ⚠) so the operator remembers to do it by hand; batch skips it. Prevents the trap where a series silently drops a target because we haven't built the integration yet.

#### Resolution order

Per-record, the effective destination set is computed in this order (later beats earlier):

1. **Global default** — `[{ platform: "YouTube", visibility: "public" }]`. Applies when nothing else matches.
2. **Series match** — if the record's title matches a series's pattern (ADR-055 title alignment), the series's `destinations` array replaces the global default entirely (not merged — series are authoritative for their records).
3. **Per-batch processing rule** — a rule can add / remove / mutate destinations. Existing rules that set `transforms.privacy_status` still work: they apply to the YouTube destination only.
4. **Per-record override** — the Publish preview modal renders one row per destination with its visibility control; the operator can add / remove destinations and change visibilities before the click. Overrides never persist back to the series — they apply to this publish only.

#### Interactive publish

The Publish preview modal grows a "Destinations" section — one row per resolved destination:

```
Destinations
  ▸ YouTube            visibility: [public ▾]   [− remove]
  ▸ Kaltura            visibility: [members ▾]  [− remove]
  ▸ Drive folder       share scope: [inherit ▾] [− remove]
  ▸ Vimeo (manual)     ⚠ manual step             [− remove]

  + Add destination…
```

Publish button pushes each destination in sequence. A single failing destination doesn't block the others — each row shows its own result state.

#### Batch publish

The `/maintain` bulk publish path (ADR-068) and the backfill uploader (ADR-016) both resolve destinations via the same order. Bulk publish shows the count per destination pre-flight so an operator can see e.g. "150 → YouTube, 82 → Kaltura, 82 → Drive" and gut-check before running.

#### Deprecation path for `default_privacy` on backfill profiles

The profile's `default_privacy` becomes a legacy fallback: used only when a record doesn't match any series AND processing rules don't produce a YouTube destination. When it fires we log an audit event so operators can find the "why did this go up unlisted" answer. Long-term (post-migration) the field is proposed for removal — deferred until we're confident every actively-used series has explicit destinations.

---

## Consequences

### Positive

- Operator intent maps cleanly to configuration. "Live Vibe goes public on YouTube + members-only on Kaltura + archived to the Ops Drive folder" is one series edit; every future record matching the pattern inherits it.
- Kaltura and Drive become first-class destinations, not paper-over-with-a-Discord-message workflows. Unblocks the ADR-071 Drive-folder-as-target future work.
- The "Other" escape hatch means operators can DECLARE a Vimeo / Twitch / private-server target without waiting for the integration — the checklist keeps them honest.
- Deprecating `default_privacy` on profiles removes a subtle footgun where profile-level and series-level values could disagree.

### Negative

- Bigger surface area to reason about. The Publish preview grows from a single privacy dropdown to a list of destination rows, each with its own knobs. Some operators will find it noisier — worth an audit after Phase 2 lands to see if the row list should collapse to a single row when only YouTube is targeted.
- The `Other` variant is a promise the tool can't automate. Operators forgetting a manual step is a real failure mode; the ⚠ marker helps but doesn't guarantee.
- Migration: existing series entries have no `destinations` array. On first read, we back-fill with `[{ platform: "YouTube", visibility: default_privacy_from_matching_profile ?? "public" }]` so the effective behaviour after Phase 2 lands matches the pre-Phase-2 behaviour. Operators should audit and add Kaltura / Drive entries as they discover them.
- Kaltura's `category_ids` and Drive's `folder_id` are opaque strings that the operator has to fetch from the respective UIs. Not friction-free.

### Neutral

- The processing-rules layer still exists and still runs, but its `privacy_status` transform now targets specifically the YouTube destination in the resolved list. Rule authors need to know that.
- Audit logs gain the resolved destinations per publish. Post-incident review ("did we mean to make this public on Kaltura?") gets a cleaner answer.

---

## Follow-ups (all Phase 2)

1. **Series-registry UI edit** — add the destinations editor. Small side panel per destination type; validation per platform (YouTube visibility is enum, Drive folder_id must exist, Kaltura category_ids format check).
2. **Publish preview redesign** — one row per resolved destination. Include the resolution provenance ("from series X" / "profile default" / "operator added").
3. **Kaltura publish endpoint** — `POST /api/kaltura/publish` mirrors `/api/youtube/upload` shape; handles category assignment. Currently unbuilt.
4. **Drive folder-as-destination endpoint** — copies a FUSE-ingested video into the target Drive folder; sets file-level share scope. Piggybacks on the ADR-071 ingest infrastructure in reverse.
5. **Series migration script** — one-off `POST /api/admin/migrate-series-destinations` that walks the existing registry, backfills `destinations` with a YouTube entry inheriting from any matching profile's `default_privacy`, and writes back. Idempotent.
6. **Rule transform vocabulary update** — `transforms.destinations: DestinationSpec[]` becomes available; `transforms.privacy_status` deprecated but retained for backward compat (rewritten server-side to the YouTube destination's visibility).
7. **Audit-log destinations field** — `VideoPublished` events carry the resolved destinations list at publish time.
8. **Publish-preview ribbon** when the effective visibility on any destination resolves to `public` and the record has no transcript or unreviewed description. Same idea as the ADR-072 rung-4 warning, applied here.

---

## Open questions

- Should removing a destination from a resolved list at publish time flag a warning ("you're skipping Kaltura for this record — sure?")? Trade-off: helpful safety net vs. click fatigue. Leaning **yes, quiet ⚠ chip only**.
- When a series defines multiple destinations and only some succeed, do we advance the record to `Published` status or hold it at `Publishing`? Leaning: `Published` if any destination succeeded; the video card carries per-destination result badges so the incomplete-publish state is visible.
- Do we need a "test destination" affordance on the series editor — click to publish a specific test record to that destination and confirm the wiring? Nice-to-have; deferred.
- Should the `Other` variant require the operator to acknowledge the manual step before publish can complete (blocker) or just log a reminder (non-blocker)? Leaning **non-blocker with an ⚠ chip on the record until an operator manually ticks "did that manual step"**.
