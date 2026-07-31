# ADR-060: Scheduled Show Windows and Pre/Main/Post-Show Segmentation

| Field | Value |
|-------|-------|
| **Status** | Accepted (data model + trim); Proposed (YouTube edit-to-preserve-views workflow) |
| **Date** | 2026-07-27 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-014 (processing-rule publish attributes), ADR-019 (provenance graph), ADR-023 (pre-processing trim-to-boundary), ADR-029 (auto-shorts generation), ADR-046 (prompt-driven summaries), ADR-055 (series registry), ADR-059 (pre-show trim for summaries) |

---

## Context

Live-stream recordings sit inside a broader timeline than "the show." The Zoom / YouTube-Live capture runs longer than the programme itself, and the recording typically contains three regions:

- **Pre-show** — sound-check, "can you hear me", warm-up patter with early arrivals, off-topic banter (5–15 min).
- **Main show** — the actual programme the audience came for. This is what viewers should see when they open the published video, what Opus Clip should be sourcing shorts from, and what the summary should describe.
- **Post-show** — Q&A wrap-up, off-topic hang-out, "thanks for watching", tech-troubleshooting after the credits (0–20 min).

ADR-059 gave summarisation a way to skip the pre-show by reusing ADR-014's `trim_start_seconds`. But the trim is per-record and manual: nothing knows *when* the show is scheduled to run, so nothing can propose that value automatically, and nothing separates the post-show at all. Meanwhile ADR-055's series registry already knows which series a recording belongs to — so the natural place to declare "this series airs at noon–1:30 pm ET" is next to the pattern that identifies it.

The published video today is one continuous asset: viewers who tune in for the show land on 10 minutes of sound-check first, and the post-show ramble is bolted on to the end. Opus Clip is asked to make shorts from the whole recording, so its "most viral moment" model has plenty of low-value banter to compete with the actual show.

---

## Decision

### 1. Series registry entries carry a scheduled window

`SeriesRegistryEntry` gains three optional fields:

```
scheduled_start_local: string   // "12:00"  (24-hour)
scheduled_end_local:   string   // "13:30"
scheduled_timezone:    string   // "America/New_York"
```

All three must be present for the window to take effect; any missing field leaves the series untouched (existing behaviour). Editable on the Config → Series Registry panel next to the discord_channel field.

### 2. Derive `trim_start_seconds` and `trim_end_seconds` per record

For a record matched to a series with a scheduled window, the ADR-014 processing-rule engine computes:

- `trim_start_seconds = max(0, scheduled_start − recorded_at)`
- `trim_end_seconds   = max(0, recording_end − scheduled_end)`

`recording_end = recorded_at + duration_seconds`. Both values are seconds counted from `recorded_at`.

`trim_start_seconds` already exists (ADR-014, used by summarisation via ADR-059 and by the ffmpeg trim at YouTube upload). `trim_end_seconds` is a new publish attribute; the YouTube upload path applies it as `ffmpeg -to <duration>` when set.

An operator override on the publish preview always wins over the derived value (the derived value is a good default, not a floor).

### 3. Three-segment provenance

Each recording ingested against a series with a scheduled window is represented in the provenance graph as three virtual segments linked to the source record. Nothing is duplicated at rest — the segments are computed views over the single source video plus `metadata_extra.segments`:

```
metadata_extra.segments = [
  { kind: "pre_show",  start_seconds: 0,         end_seconds: T_start },
  { kind: "main_show", start_seconds: T_start,   end_seconds: T_end   },
  { kind: "post_show", start_seconds: T_end,     end_seconds: duration_seconds },
]
```

`T_start = trim_start_seconds`, `T_end = duration_seconds − trim_end_seconds`. When either trim is zero, that segment's row is absent (no empty entries).

The provenance graph renders the segments as sub-nodes under the source record (like the existing ADR-058 clip nesting), each with a labelled band ("Pre-show 08:12", "Main show 1h 24m", "Post-show 03:45"). Each segment is click-to-jump — future scope is a per-segment inline player scrubbed to the segment offset.

### 4. Clip generation defaults to the main show

`generate_shorts` (ADR-029) accepts an optional `segment` parameter defaulting to `"main_show"`. When set, Opus Clip receives a `startOffset`/`endOffset` bound to that segment's window. The Shorts modal on VideoCard gains a segment picker (Pre-show / **Main show** / Post-show / Whole recording), defaulting to Main show.

Whole-recording remains available for the case where the operator hasn't configured a window for the series and wants to preview clips broadly.

### 5. Published-to-YouTube edit workflow (Proposed — see ADR-061 or later)

For a recording already published to YouTube as one asset, applying this ADR retroactively must preserve the view counter — YouTube's watch statistics are attached to the video ID, not the file, and re-uploading loses them. The proposed workflow:

- **Trim in place**: YouTube Studio's "Editor → Trim" is the only view-preserving edit for length. Its API is not exposed (documented gap). Two options:
  1. **Operator-driven**: catalog surfaces a "🎬 Trim in Studio (open in browser)" deep-link with the computed pre/post-show offsets pre-formatted, so the operator applies them manually. Fastest path; requires human hands.
  2. **YouTube Data API `videos.update` + client-side editor**: not exposed. Same gap as ADR-029's pinned-comment limitation. Watch for API release.
- **Post-show as a separate video**: upload the post-show segment as a new YouTube video (regular ADR-012 flow), title it "Post-show: <original title>", link back to the main show via the ADR-022 provenance footer, and add it to the same series playlist. The catalog records this as a new record linked via a new `PostShowOf` upstream_link relation (see §6).

Because the trim-in-place is not fully automatable, this ADR ships (2), (3), (4) and defers the retroactive Studio-trim to a follow-up ADR when either YouTube exposes the API or an operator-driven Studio-deep-link mode is designed. The catalog surfaces the deep-link intent as a "manual trim required" call-out on affected records.

### 6. New provenance relation: `PostShowOf`

Only used when the post-show is uploaded as a separate video (§5). Directional — the post-show record's upstream link points back at the main show.

`DerivationType::PostShowOf` gets added to `src/catalog/value_objects.rs` and to the transcript-safe / title-inheritance sets in ADR-053 / ADR-056.

---

## Consequences

**Positive**
- Automated pre- and post-show trim for any series with a window declared. Operator only sets the schedule once.
- Summarisation via ADR-059 already reads `trim_start_seconds`; it gains the post-show trim automatically because the same slice helper accepts a bounded window.
- Provenance graph gains segment context — click a session, see where the main show lives inside the raw capture.
- Opus Clip stops making shorts out of sound-checks.

**Negative / trade-offs**
- **Timezone tricky ground.** DST transitions, series that move times between seasons, guest slots that run over — all of these require operator maintenance. The default of "no window → old behaviour" keeps the pit-of-success shallow: if a series doesn't fit a fixed schedule, don't declare one.
- **`trim_end_seconds` behaviour when duration is misreported**: for some legacy imports `duration_seconds` is the pipeline's ingest window, not the recording's true duration. When that's wrong by more than a few minutes, the post-show trim will chop off legitimate main-show content. Mitigation: the operator publish preview shows the derived trim and can override it; the ADR-059 summary regen path treats the trim as advisory, not authoritative.
- **Retroactive Studio-trim is manual** until YouTube exposes the API. The "manual trim required" call-out is a workflow paper-cut, not a blocker.
- **First-run churn** parallel to ADR-059: series with windows will show a bunch of records as needing re-summarisation and (if not yet published) re-upload with the wider trim. Same manual gate as ADR-059 — nothing regenerates without a click.
- **`post_show` clip generation** defaults off. If the operator ever wants a "best of Q&A" short-form pipeline, they explicitly pick "Post-show" from the segment picker; no surprises.

**Downstream effects to watch**
- **ADR-014** processing rules gain a `trim_end_seconds` output field — the existing `applyProcessingRules` shape widens.
- **ADR-019 / ADR-058** provenance graph rendering gains a per-record segment column. Renders under the source card, above the derivatives (clips) column.
- **ADR-023** pre-processing trim: pre-trim was designed for a fixed value; window-derived values will overwrite the fixed rule when both fire. Longest match wins (i.e. the explicit rule can raise the derived value but not lower it — the operator override on the preview is still the escape hatch).
- **ADR-029** clip generation: the segment picker in the Shorts modal is a small UX change; the underlying API to Opus already accepts start/end offsets.
- **ADR-046 / ADR-059** summaries: `trim_end_seconds` gets added alongside `trim_start_seconds`. Sidecar records both.
- **ADR-053** transcript provenance: adds `PostShowOf` to the safe-relations set so a post-show record can inherit the main show's transcript metadata (they share the same audio; the split is virtual).
- **ADR-055 / ADR-056** title alignment: the pre- and post-show segments inherit the main show's aligned title with a suffix — `"<series> - <date> (pre-show)"`, `"<series> - <date> (post-show)"`. Operators who add a `pattern` alias never see this diverge because segments live under the source record's title, not their own.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| Store segments as separate catalog rows | Duplicates state at rest; three rows per recording bloats the catalog and complicates every existing query. Virtual segments over one record win. |
| Hard-code segment lengths per series (e.g. always trim last 5 min) | Doesn't survive a schedule change and fails on any recording that ended early. Time-of-day windows survive both. |
| Detect show boundaries via LLM classifier | Non-trivial cost per record; series windows are a cheap, correct default when they exist. Save the LLM for cases where the schedule is genuinely unknown. |
| Re-upload trimmed main show to YouTube (losing view counter) | View counters are the whole point of the "already published" retroactive case. Users would rather see a 3-min pre-show than lose the counter. |
| End-of-show detection via applause / silence | Signal-processing rathole for a small optional feature. Deferred. |

---

## Out of Scope

- Automatic Studio-trim of already-published videos (blocked on YouTube API; see §5).
- Per-guest / per-episode overrides of the window (would need an episode calendar).
- Applause / silence-based post-show boundary detection.
- Per-segment sponsorship or ad-marker export.
