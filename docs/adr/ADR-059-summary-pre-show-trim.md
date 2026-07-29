# ADR-059: Pre-Show Trim for Summary Generation

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-07-27 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-014 (publishing-attribute processing rules), ADR-023 (pre-processing trim-to-boundary), ADR-028 (download / re-upload), ADR-046 (prompt-driven summaries), ADR-052 (catch-up summary badge backfill), ADR-053 (transcript provenance lookup) |

---

## Context

Live-stream recordings routinely start 5–15 minutes before the actual programme begins. This warm-up period contains sound-checks, off-topic chatter, dead air, and welcome patter that is not part of the show being summarised. The transcript captures every second of the recording — so an ADR-046 summary generated from the raw transcript is polluted by whatever happened during the pre-show, systematically over-weighting introductions, technical talk about the streaming setup, and idle banter at the expense of the actual programme content.

Publishing already recognises this problem: ADR-014 processing rules can compute a `trim_start_seconds` publish attribute which the YouTube upload path (`/api/youtube/upload`) applies via ffmpeg. But that trim only affects the **video file** re-uploaded to YouTube. The catalog's `transcript_text` on Drive is stored untrimmed, and ADR-046 summary generation consumes it verbatim. So the same `trim_start_seconds` that gets the published video right does nothing for the summary.

The operator can override the trim per-record on the publish preview, and could theoretically re-run summary generation on a manually-shortened transcript, but there is no first-class mechanism to say "use the video's trim window when summarising."

---

## Decision

### 1. Reuse `trim_start_seconds`; don't invent a second knob

The publish-attribute `trim_start_seconds` produced by ADR-014 processing rules — whatever value the rule engine or an operator override computed for publishing — is the trim window used for summarisation too. No new field, no divergence between "what got published" and "what got summarised."

### 2. Slice at the transcript's timestamp markers

Drive transcripts store one line per utterance with a leading `[HH:MM:SS]` marker (produced by Kaltura caption import, Fireflies fetch, and Zoom VTT flattening). Summarisation slices the transcript at the first line whose timestamp is ≥ `trim_start_seconds`. Lines before that boundary are dropped for LLM input; the raw Drive artifact is not modified.

### 3. Absolute-time chapters, adjusted-time context

The prompt continues to receive absolute-time chapter markers (i.e., the timestamps in the LLM-visible transcript are still `[HH:MM:SS]` from the recording's t=0, unchanged). This preserves the operator's ability to cross-reference a summary chapter with the raw recording. The trim is applied *before* the LLM sees the text; nothing about the chapter format changes.

### 4. New parameter surfaced at every entry point

`generateRecordSummary(ctx, opts)` in `lib/summaryGenerate.ts` gains `opts.trimStartSeconds?: number`. It's threaded through:

- **`POST /api/summary/generate`** — accepts `trim_start_seconds` in the request body; per-record Summarise / Re-summarise buttons on VideoCard send the value derived from that record's applyProcessingRules result.
- **`tryEnsureSummary`** in `lib/catchupOrchestrator.ts` — computes the trim per record via `applyProcessingRules(loadProcessingRules(), record)` and passes it through.
- **Bulk summary badge backfill (ADR-052)** — inherits the change via `tryEnsureSummary`; no separate path.

### 5. Record the trim on the summary metadata

The summary sidecar (JSON stored next to the doc on Drive, tracked via WASM `summary_prompt_version` / `summary_doc_id`) grows a `trim_start_seconds` field. This closes the audit loop — an operator inspecting a summary can see whether it was generated with a trim, and what value.

### 6. Freshness — a trim change invalidates the summary

Existing summaries generated without a trim are **not** automatically re-generated. Two mechanisms:

- **Operator action**: the per-record "📄 Re-summarise" button on VideoCard already regenerates on click and now applies whatever `trim_start_seconds` the processing rules currently produce.
- **Bulk staleness detection**: `findRecordsNeedingSummaryBadge` (which today compares `summary_prompt_version` against the current prompt version) additionally compares the summary sidecar's stored `trim_start_seconds` against the value the processing rules currently produce. A mismatch marks the summary as stale, and the next Maintain-panel run re-summarises it with the correct window.

---

## Consequences

**Positive**
- Summaries stop being polluted by 5–15 minutes of warm-up per recording.
- No new operator vocabulary — same `trim_start_seconds` used for publishing.
- Idempotent: repeat runs with the same trim produce the same summary (modulo LLM sampling).
- Auditable: the trim used is recorded on the summary sidecar.

**Negative / trade-offs**
- **Bulk regen churn**: the first bulk-backfill run after this ADR ships will re-generate every summary whose parent record has a non-zero `trim_start_seconds`. On the current corpus (~50 recordings with rules producing a non-zero trim), at OpenRouter cost ~$0.02/summary, that's roughly $1 of one-time spend. The operator gates this via the existing "Run backfill" button; nothing regenerates without a click.
- **Prompt-vs-trim staleness ambiguity**: a summary can now be stale for two reasons — prompt version bumped, or trim value changed. The event log names the reason so the operator can distinguish "the model changed" from "the show boundary moved".
- **Transcript truncation still applies**: if the pre-trim transcript exceeds `MAX_TRANSCRIPT_CHARS`, we slice first and truncate second. In practice this means the trim recovers head-of-transcript budget that was being lost to warm-up chatter — small but real quality lift.

**Downstream effects to watch**
- **ADR-023** pre-processing trim: describes the same value being applied to the video file at publish time. That path is untouched — the ffmpeg call still trims the mp4. This ADR extends the same input to summarisation.
- **ADR-053** borrowed transcripts: when a record borrows a Fireflies transcript via TranscribedFrom, the borrowed transcript's timestamps are the *donor's* absolute time. The Zoom canonical and the Fireflies bot start at approximately the same moment (both connect near the meeting start), so `trim_start_seconds` from the canonical's processing rules maps sensibly onto the donor's transcript. If the two clocks are more than ~30 s apart this ADR does not correct for that drift — a future ADR could align both by looking at the first common utterance.
- **ADR-046** prompt version: unchanged. Bumping the prompt still forces a full regen. Trim changes are orthogonal and tracked alongside.
- **ADR-052** catchup summary badge backfill: gains an additional "reason to regenerate" (trim changed). Reported alongside the existing "missing / stale (prompt drift)" categories.
- **Cost estimates**: `estimatePerRecordCost` uses the full transcript length. When the trim slices ~10% off, the estimate over-forecasts spend by ~10%. Small enough to leave alone unless the operator flags it.
- **Chapter drift risk**: the LLM continues to see absolute-time markers, so chapter offsets in the generated summary remain aligned with the raw recording. This is a deliberate choice — an operator jumping to `12:34` in the summary lands at `12:34` in the recording, not at `12:34 - trim`. Documented here so a future refactor doesn't "fix" the timestamps thinking they're wrong.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| Trim the transcript **file** at ingest | Loses information — the raw transcript is useful for reviewing what happened before the show. Better to keep it whole and slice at read-time. |
| A separate `summary_trim_start_seconds` field | Two knobs mean two chances to disagree. If a record's video is trimmed at 12:00 but the summary trims at 8:00, that's a bug factory. Reusing the publish attribute avoids the divergence. |
| Detect the pre-show boundary automatically via LLM | Reasonable long-term direction but adds a pre-summarisation LLM call per record and non-trivial cost/latency. Deferred to a future ADR — the manual trim already exists and works. |
| Trim the LLM's output post-hoc (chapter deletion) | LLM has already read the pre-show content; the summary's framing is already polluted. Slice at input, not output. |

---

## Out of Scope

- Automatic pre-show boundary detection (see Alternatives).
- End-of-show trimming (Q&A wrap-up, "thanks for watching", etc.) — solvable with the same mechanism (`trim_end_seconds`) but not needed today.
- Retroactive re-summarisation of every existing record — operator-triggered, not automatic.
