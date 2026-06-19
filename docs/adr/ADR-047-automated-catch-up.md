# ADR-047: Automated Catch-Up Action

**Status**: Proposed
**Date**: 2026-06-01
**Deciders**: Architecture Team
**Related**: ADR-005 (source integration), ADR-016 (backfill uploader), ADR-022 (provenance footer), ADR-024 (post-processing webhook & email), ADR-033 (multi-origin dedupe / sibling matcher), ADR-039 (Drive artifact storage), ADR-040 (broaden source imports), ADR-041 (app-level audit log), ADR-044 (Kaltura presence), ADR-046 (prompt-driven summaries)

---

## Context

The pipeline today is correct but **manually staged**. To bring a single new session to "Published to YouTube + Kaltura, captions on Drive, summary on Drive, sibling Fireflies linked", an operator clicks through a sequence of ~8 actions across multiple panels:

1. Pull recordings from each source (Zoom / Zoom Live / Kaltura / Fireflies / YouTube Live) via Import.
2. Wait for transcripts to populate (Zoom + Fireflies inline; Kaltura via the captions fetch lozenge — ADR-044/046 plumbing).
3. Run ingestion rules to triage Discovered → InScope / Approved / Skipped.
4. Click the sibling-match banner to link Fireflies to Zoom (ADR-033).
5. Apply processing rules (title/description templating) via the Publish preview.
6. Click 📄 Summarise (ADR-046) to generate the chapter-oriented summary Doc.
7. Click Publish → YouTube; Click Publish to Kaltura (side-publish).
8. Confirm post-processing rules fired (webhook + email — ADR-024).

On a Friday evening when ten new sessions have landed, this is real friction. Operators want a **"catch me up"** button that walks the most-recent-backwards window and advances each record as far as it can, asking only when human judgment is required (e.g. a sibling-match confidence below threshold).

The pieces exist. What's missing is the orchestrator and a clear stop-state per stage.

## Decision

Add a **Catch Up** action — both a one-click trigger from the dashboard header and a recurring background mode — that processes a configurable window of records (default: 30 days, most-recent first) through the full pipeline. Each record advances stage-by-stage; the action stops on the first stage that needs human judgment, records why, and moves to the next record.

### Stages — user's list + the things the user missed

| # | Stage | Lives in | Today |
|---|---|---|---|
| 1 | **Cross-source fetch** | New: scans each configured source for new records in window | Manual per-source clicks in ImportPanel |
| 2 | **Captions / transcript hydration** | Source adapter (Zoom + Fireflies inline) + `/api/kaltura/captions` | Auto on Zoom/Fireflies; manual lozenge on Kaltura today |
| 3 | **Sibling matching** | `siblingMatcher.ts` (ADR-033) | Manual click on banner |
| 4 | **Ingestion rules** | `rules.ts` runRules — already runs every 60s | Already automatic |
| 5 | **Processing rules application** | `processingRules.ts` — title/description templating | Applied at Publish-preview time |
| 6 | **Summary generation** | `/api/summary/generate` (ADR-046) | Manual click on the Summarise button |
| 7 | **Curation transition** | WASM approve / mark_in_scope / skip | Manual; auto only when an ingestion rule has `auto_approve` |
| 8 | **Publish to destinations** | `/api/youtube/upload` and `/api/kaltura/upload` | Manual per-card per-destination |
| 9 | **Post-processing rules fire** | `firePostProcessingRules` (ADR-024) | Automatic after Publish |

### Things the user's list didn't explicitly call out — flagging them so they're not silently omitted

| What | Why it matters | Default in this ADR |
|---|---|---|
| **Cross-source dedupe before fetching** | Re-running Catch-Up on the same window shouldn't re-import records we already imported. Each adapter must skip already-indexed `source_id`s. Existing imports already check; the orchestrator must trust that check. | Built-in (existing adapter behavior). |
| **Processing rule application** | Title/description rewriting (e.g. "Friday Hackerspace — {{date}}: {{summary_one_liner}}") needs to happen **before** Publish, because the publish payload uses the rewritten title. ADR-014's `transcript_llm` mode also calls OpenRouter. | Run automatically in the publish stage. |
| **Exclusions** | A record matching an active Exclusion entry (ADR-043) must be skipped, not advanced. | Built-in (check before each mutation). |
| **Curation transition gate** | Today `Approved` is the prerequisite for Publish. Catch-Up needs an explicit policy on auto-approval — never auto-approve into Published without operator consent. | Default: advance to `Approved` only if an ingestion `auto_approve` rule matched. Otherwise stop at `InScope` and leave for human review. Operator-configurable. |
| **Provenance footer** | Already auto-applied in `publishToYouTube` and `publishToKaltura` (ADR-022). | Inherited. |
| **YouTube Live chat capture** | ADR-046 open question. For live broadcasts the chat is part of the `C` summary input. Today only Zoom CHAT is captured (ADR-039 slice 3). | Out of scope for this ADR — separate follow-up. Catch-Up uses whatever the existing capture supports. |
| **Per-record cost cap** | The summary stage alone can be $0.50 for a 3-hour session. A Catch-Up batch of 30 records is real money. | Mirror ADR-046's per-batch cap with a per-record limit option. |
| **Per-stage retry** | A flaky Kaltura caption fetch shouldn't abort the whole pipeline for a record. | Each stage has its own retry budget; first hard failure stops only that record's advance and records the failure. |
| **Concurrency** | Sequential per record (the YouTube upload step is bandwidth-bound and YouTube quota is per-day, not per-second). Multi-record parallelism limited by `max_uploads_per_day` from the active backfill profile. | Sequential per record; bounded parallel possible across records subject to ADR-016 quota. |
| **Audit log** | Each stage emits an audit entry naming the actor + result (ADR-041). | Inherited. |
| **Pause / Resume** | A Catch-Up run can be long. Same UX as ADR-046 slice 4 regen. | Inherited pattern: persistent state file, SSE progress, Cancel button. |

### Orchestrator structure

A new server-side endpoint **`POST /api/catchup/run` (SSE)** that orchestrates per record. The window of records to process comes from the catalog ordered by `recorded_at desc`, filtered by a configurable date range (default: last 30 days) and optionally a source filter.

For each record:

```
stage_pipeline = [
  fetch_source_if_missing,        // ensures download_url is resolvable
  hydrate_transcript_if_missing,  // Kaltura captions, future YT auto-captions
  link_siblings_above_threshold,  // auto-link at ≥ HIGH; stage at ≥ LOW (per ADR-046 OQ-style)
  apply_ingestion_rules,          // runs the existing 60s evaluator inline
  apply_exclusions,               // hard skip if matched
  ensure_summary_if_publishable,  // ADR-046 generate, unless locked or already current
  apply_processing_rules,         // title/description templating
  publish_to_youtube_if_eligible, // skips if already on YouTube, requires Approved
  publish_to_kaltura_if_eligible, // skips if already on Kaltura, requires Approved
  fire_post_processing_rules,     // ADR-024 webhook + email
]
```

Each stage is a thin wrapper around existing code: `siblingMatcher.suggestFor`, `runRules`, `generateRecordSummary`, `publishToYouTube`/`publishToKaltura`. The orchestrator is the integration point.

For each stage:
- **Already done** → mark stage `skipped`, continue.
- **Success** → mark stage `done`, continue.
- **Soft fail** (e.g. no captions on Kaltura, no Fireflies sibling above threshold) → mark stage `n/a` with reason, continue.
- **Hard fail** (e.g. YouTube refresh-token expired, OpenRouter 5xx) → mark stage `failed`, **stop this record**, move to the next.
- **Human-required** (e.g. sibling match at 0.65, below auto-link threshold but above stage-for-review) → mark stage `needs_review`, **stop this record** with an actionable banner on the card.

The SSE stream emits per-record + per-stage events so the panel can show progress like:

```
2026-04-12 · "Friday Hackerspace — Live Coding Edition"
  ✓ fetch       (already indexed)
  ✓ transcript  (already on Drive)
  ✓ siblings    (Fireflies sibling linked, score 0.91)
  ✓ rules       (matched "weekday sessions" → Approved)
  ✓ summary     (prompt v3 · M:11 L:7 T:4 C:3)
  ✓ youtube     (uploaded, https://youtu.be/abc123)
  ✓ kaltura     (side-published, https://kaltura.com/.../entry/x)
  ✓ post        (notified #engineering)
```

vs.

```
2026-04-19 · "Untitled Meeting"
  ✓ fetch
  ✗ transcript  (no captions on Kaltura — fetch lozenge would 404)
  · siblings    (skipped — needs transcript first)
  ⏸ STOPPED. Click "Open card" to resolve, or set the transcript manually
```

### Trigger modes

| Mode | When | Configuration |
|---|---|---|
| **Manual** | Header "Catch up" button → modal preview → confirm | Window (30 days default), source filter, per-stage opt-out, cost cap. |
| **Scheduled** | Daily at 03:00 UTC via Cloud Scheduler hitting `/api/catchup/run?mode=scheduled` | Default window of "since last successful run, capped at 30 days". |
| **Triggered by import** | When ImportPanel reports new records, surface a passive "X new records — catch up now?" banner | Same modal as manual. |

Scheduled mode opens a separate "open question" around Cloud Scheduler config vs. running off a cron-like timer inside Cloud Run.

### Window semantics

"Most recent backwards" means: order records by `recorded_at desc`, take the first N within the window, advance them sequentially. The orchestrator persists a `last_caught_up_at` watermark so subsequent runs don't re-process the records advanced last time (they'll still be visited — every stage is idempotent — but the orchestrator can mark them "fully caught up" and skip quickly).

### Idempotency

Every stage is either idempotent or already has a "skip if already done" check. The Catch-Up orchestrator is allowed to be lazy: re-running on the same window is safe, just expensive. Caching:

- `summary_doc_id` present + `summary_prompt_version === current_prompt_version` → skip summary stage.
- `locations[]` has destination of platform X → skip publish to X.
- `transcript_text` ≥ 200 chars → skip transcript hydration.
- All this is already encoded in the existing per-button gating; the orchestrator inherits it.

## Consequences

**Positive**
- The Friday-evening-ten-new-sessions case becomes one click + a "review the four that need attention" follow-up.
- Forces every stage to be observable and idempotent, which retroactively improves single-stage operations too.
- The SSE progress view doubles as a unified pipeline visualisation — useful for debugging "why didn't this advance?"
- Schedules cleanly to a nightly cron once the manual flow is proven.

**Negative**
- Big surface: ten stages × five outcomes per stage × N records = a lot of states to render and reason about. UX risk is real.
- Cost concentration: a single Catch-Up run could trigger expensive summary regenerations + YouTube upload bandwidth. Cost cap + Cancel are essential.
- A bug in any stage now affects N records, not 1. Per-record isolation (one failure doesn't taint others) is load-bearing.

**Risks**
- The "auto-link siblings above threshold" rule lives in tension with the recorded preference for manual bulk-accept of sibling matches (`memory/feedback_dedupe_threshold.md`). Catch-Up should respect the same two-tier policy: silent link only at HIGH confidence; stage for manual at LOWer-but-above-threshold.
- Cloud Run scale-to-zero: a long Catch-Up run holds the SSE stream open. If the instance dies mid-run the persistent state lets the operator Resume, but no automatic retry — same trade-off as ADR-046 slice 4.
- The processing-rule stage applies title/description rewrites that the operator may not have reviewed for that specific record. Default: rewrites are deterministic from rules, so this is fine; operators can disable the stage via per-stage opt-out.

## Alternatives considered

| Option | Rejected reason |
|---|---|
| **Per-stage "Run All" buttons (no orchestrator)** | Doesn't address the "10 records × 8 stages = 80 clicks" pain. Slightly faster per-record but no cumulative win. |
| **Make each stage trigger the next via events** | Decoupled but loses observability — operators want one progress view, not 10 panels listening to events. Implicit ordering is harder to reason about. |
| **External orchestrator (Cloud Tasks / Cloud Workflows)** | Adds infrastructure. Today everything runs in Cloud Run, and a single SSE-driven loop is sufficient at our scale (hundreds of records, not millions). Revisit if Catch-Up ever needs hours-long runs. |
| **Always-on background catch-up daemon** | Worthwhile eventually but premature. Get the manual flow proven and observable first; daemonise once trust is established. |
| **One stage at a time, advancing all records in lock-step** | Mismatches the operator mental model of "this record went all the way through" and complicates partial-failure handling. |

## Open Questions

1. **Cost cap unit.** Per-record vs per-batch (mirrors ADR-046 open question). Default suggested: `min(per-batch=$10, per-record=$0.50)`.
2. **Auto-approve gate.** Catch-Up should never auto-approve into Published without operator consent. But should it auto-advance `Discovered` → `InScope` when ingestion rules score it as in-scope? Default: yes; reversible.
3. **YouTube Live chat capture.** Carries ADR-046 OQ-4 forward. Catch-Up enables chat-sparked discussion summaries only for sources where chat capture exists (Zoom today).
4. **Sibling auto-link threshold.** Should Catch-Up use the same threshold as the interactive banner, or a stricter one given the no-human-in-loop nature? Suggest: stricter (≥ 0.85 for silent auto-link; ≥ 0.6 → stage for manual review).
5. **Scheduled mode trigger source.** Cloud Scheduler vs. an in-process cron vs. a sentinel record poll. Easiest: Cloud Scheduler. Out of band of this ADR's first cut.
6. **Per-source caching.** Should Catch-Up cache a "we asked source X for window Y at time T, nothing new" so it can skip the fetch stage cheaply on the next run? Avoids API quota burn on the daily scheduled mode. Suggest: yes, with a 1-hour TTL.

## References

- ADR-005: source integration
- ADR-016: backfill uploader — closest existing orchestrator pattern; Catch-Up reuses its quota integration
- ADR-022: YouTube description provenance footer
- ADR-024: post-processing webhook & email
- ADR-033: multi-origin dedupe / sibling matcher — threshold semantics
- ADR-039: Drive-based artifact storage
- ADR-040: broaden source imports (Kaltura source, YouTube Live)
- ADR-041: app-level audit log — each stage emits audit entries
- ADR-043: shared backfill profiles + exclusions
- ADR-044: Kaltura presence
- ADR-046: prompt-driven summaries — slice 4 panel + SSE shape are the template for this ADR's progress UI
- `memory/feedback_dedupe_threshold.md`: recorded preference for manual bulk-accept of sibling matches in the mid-confidence band
