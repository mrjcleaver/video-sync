# ADR-033: Multi-Origin Deduplication, Description Enrichment, and Live-Stream Semantics

**Status**: Proposed (exploration)
**Date**: 2026-04-21
**Deciders**: Architecture Team
**Scope**: Catalog (ADR-002), Provenance (ADR-019), Source Integration (ADR-005), Recover Flow (ADR-016)

> This ADR is **exploratory**. It names three related problems surfaced in production use, considers options, and recommends a direction. No code changes are proposed as part of this ADR — follow-up ADRs will carry the chosen design forward.

---

## Context

Three production observations, all concerning the same class of problem: the system treats each capture of a video as an independent record, but in reality many captures share an underlying event and the metadata between them is complementary.

### Observation 1 — Videos published without descriptions

When a record's origin is Zoom (or any source that doesn't carry textual content), the published YouTube video often ends up with an empty or placeholder description. Processing rules can template from `{{title}}`, `{{date}}`, `{{participants}}`, but if no transcript exists on the record there is nothing substantive to describe *what the video is about*.

Example: A Zoom recording imported directly (no Fireflies companion) has `transcript_text = null`. Processing Rule templates that reference `{{transcript_summary}}` or the LLM summarisation path produce empty output. The video is uploaded with a title and maybe a date, but no summary.

### Observation 2 — Same event imported twice from different sources

The "Live Vibe 12 Mar 2026" session is now in the catalog twice:

| Record | Source | Source ID | Recorded at | Duration |
|--------|--------|-----------|-------------|----------|
| A | Zoom | `zoom-fvBFE2OqQCCdTkR68agbeQ==` | 12 Mar (host pressed record early) | longer |
| B | Fireflies | `fireflies-01KJZJ1S4DYJ47FD1KD3FDBGCW` | 12 Mar (bot joined at scheduled time) | shorter |

They are clearly the same live event — same participants, same title, same date, start times within minutes of each other — but they arrived through two different source adapters and were indexed as separate `VideoRecord` aggregates. There is currently no automatic detection of this relationship; the operator would need to click **Link Upstream** manually with relation `SameEvent` (per ADR-019) on one of them.

Complicating factor: duration does **not** match between the two captures because Zoom started earlier than Fireflies joined. Duration cannot be used as a strong signal.

### Observation 3 — Live-stream vs uploaded-file semantics

The **Recover from YouTube** auto-suggestion (ADR-016 addendum) matched an existing YouTube video at "100% match" for the Mar 12 record, but:

- The YouTube video's `publishedAt` was **Mar 13**, one day later.
- The YouTube video was **streamed live**, not uploaded from a file.

Clarified model (confirmed with operator): for this workflow the meeting platform — **Zoom today, Google Meet in the near future** — is the origin in both upload and live-broadcast cases. Live broadcasting does not change where the media comes from; it only changes how YouTube ingested it.

So the picture for a single event is:

```
                          Zoom / Google Meet  (Origin)
                         /         |         \
                        /          |          \
       Fireflies ────── (parallel transcript capture, Intermediate)
                                   |
                                   ├── YouTube Live  (Destination, ingest=LiveBroadcast)
                                   │         or
                                   └── YouTube Upload (Destination, ingest=Upload, post-event)
```

The catalog needs to distinguish **where the media originated** (always the meeting platform) from **how a YouTube copy was created** (live broadcast during the event, or file upload after). Our current model collapses both into a single `Destination` role and therefore:

- Mis-dates live-broadcast matches because it uses YouTube's `publishedAt` instead of `liveStreamingDetails.actualStartTime`. `actualStartTime` is closer to the meeting's recorded-at and would eliminate the Mar-12-vs-Mar-13 drift.
- Cannot express "YouTube already has this because it was streamed live" differently from "YouTube already has this because I uploaded it earlier out-of-band." Both are true and both matter — for example, a live broadcast is not re-uploadable, while an orphaned upload is.
- Has no concept of Google Meet as a source platform. The existing adapter pattern (ADR-005) makes this additive, but the dedupe/enrichment logic proposed below must be platform-agnostic from day one or it will be rewritten as soon as Meet lands.

---

## The underlying problem

These three observations are facets of the same thing:

> **A video event can be captured by multiple systems, each producing a derivative artifact with complementary metadata. The catalog is modelling each artifact as if it were an independent entity.**

Concretely:

- Zoom captures the video + basic metadata
- Fireflies captures the transcript + AI summary + participants, triggered by calendar invite
- YouTube hosts the public distribution, either as an upload or a live stream

Treating these as independent records causes:

- Duplicate cards for the same meeting (Observation 2).
- Descriptions that could have been sourced from a sibling record aren't (Observation 1 — the Fireflies transcript exists, it's just on a different `VideoRecord`).
- Live-stream matches look correct on the surface (100% title match) but misrepresent the relationship (Observation 3).

---

## Decision (direction, not implementation)

Adopt **event-centric grouping** in the catalog model. A logical "event" (one meeting, one webinar, one stream) is the coordination unit. The existing `VideoRecord` remains the per-capture artifact, but records representing the same event are linked and present as a single unit in the UI.

Three required capabilities:

### 1. Event detection and linking (addresses Observation 2)

When a new `VideoRecord` is indexed, search the existing catalog for likely siblings and auto-link via the `UpstreamLink(SameEvent)` relationship (ADR-019). Heuristic for "same event":

| Signal | Weight | Notes |
|--------|--------|-------|
| Participant email overlap ≥ 80% | **strong** | Most reliable; both Zoom and Fireflies capture attendees |
| Recording-start proximity ≤ 60 min | **strong** | Accounts for host-recorded-early + bot-joined-late |
| Title token-set overlap ≥ 0.6 | medium | Useful but vulnerable to auto-generated title variants |
| Duration within 30% | **weak** (reject as primary signal) | Observation 2 shows this breaks |
| Source platform differs | necessary | Two records from the same source is suspicious, not same-event |

A weighted score ≥ threshold triggers auto-linking. Below threshold but non-zero: surface as a manual-confirm suggestion on the card (same UX pattern as the YouTube Recover banner).

### 2. Cross-record metadata enrichment (addresses Observation 1)

When applying Processing Rules to compute `PublishAttributes`, the rule engine walks `UpstreamLink(SameEvent)` edges and looks at sibling records for missing fields. Specifically:

- If this record has no `transcript_text`, and a SameEvent sibling does, use the sibling's transcript for `{{transcript_summary}}` / LLM summarisation.
- If this record has an empty `description`, the sibling's `description` is used as fallback.
- Participant lists can be unioned for `{{participants}}`.

This keeps the *canonical source* of each field on its original record (no mutation) but lets the rule engine produce richer output for any record in the event. The enrichment is non-destructive and opt-in at the rule level.

Which record "wins" when publishing? The operator picks — or a profile-level setting designates a preferred source platform (e.g. "Zoom over Fireflies" from ADR-021). The other siblings auto-link as `UpstreamLink(TranscribedFrom)` on the destination.

### 3. Ingest-method awareness (addresses Observation 3)

Meeting platforms (Zoom, Google Meet, and future additions) remain the `Origin` regardless of whether YouTube received the content via live broadcast or post-event upload. To capture the ingest distinction on the YouTube side, extend `PlatformLocation` with an optional discriminator:

```rust
enum IngestMethod {
  Upload,         // file uploaded to the platform via an API
  LiveBroadcast,  // streamed live into the platform from an external source
  Unknown,        // imported from outside our workflow
}
```

This field lives on the *destination* location, not on the VideoRecord as a whole. The same record could theoretically have both a LiveBroadcast YouTube location (during the event) and an Upload YouTube location (a re-upload of the recording later) as separate entries — the aggregate already supports multiple locations.

When the YouTube adapter fetches a video, inspect the `liveStreamingDetails` block:

- Absent → `IngestMethod::Upload`
- Present → `IngestMethod::LiveBroadcast`; also capture `actualStartTime` (which gets stored as the location's `synced_at` or a new `event_start` field for date-match purposes).

**Consequences for the fuzzy matcher.** The Recover matcher currently uses YouTube's `publishedAt`, which for live streams is the archive time and drifts by up to a day relative to the actual event. If `IngestMethod::LiveBroadcast` and `actualStartTime` is present, use `actualStartTime` instead — this closes the Mar-12-vs-Mar-13 gap from Observation 3.

**Consequences for the Recover UX.** The banner should carry different wording for the two cases so the operator understands what is being claimed:

- `Upload`: *"Link & mark Published"* (unchanged)
- `LiveBroadcast`: *"Link live broadcast"* — same state transition (`Published`), same destination linkage, but the label makes it clear that this is a simultaneous-capture association, not a retroactive upload.

**Consequences for source-platform coverage.** Google Meet is the next meeting platform on the roadmap. The dedupe heuristic in §1 and the enrichment logic in §2 must treat meeting platforms as a **set**, not as "Zoom." Participant-email matching and recording-start proximity are platform-agnostic; only the ingest adapters need per-platform code. No heuristic in this ADR may hard-code `Platform::Zoom`.

---

## Consequences

### Positive

- Duplicate cards collapse into a single event view, reducing cognitive load for operators with many source integrations.
- Metadata quality improves automatically: a Zoom-only record gets Fireflies's transcript-sourced description without any operator action, and vice versa.
- The Recover flow's confidence banner stops lying: live-streamed matches are labelled as such and dated correctly.
- The provenance graph (ADR-019) becomes more accurate and more useful — the graph is the primary view, not a secondary display.

### Negative

- Three heuristics (event detection, cross-record enrichment, live-stream detection) each need tuning with real data. False positives are expensive — merging the wrong two records requires manual intervention.
- The Rust domain model gains a new value object (`CaptureMethod`) and potentially new commands for auto-linking — schema migration territory.
- Processing-rule evaluation becomes non-local (must walk SameEvent edges), adding complexity to the pure-function guarantee currently held by `applyProcessingRules`.

### Risks

- **False-positive event linking** merges unrelated meetings that happen to share participants + time (standing meetings). Mitigation: require participant **email** match, not display name; require title-similarity floor; default to "suggest manual confirm" rather than auto-link until a confidence threshold is empirically validated.
- **Privacy/visibility mismatch** between siblings: a Zoom recording marked InScope with a summary derived from a sibling Fireflies transcript that's since been deleted. Mitigation: cache the enriched values at publish time rather than re-deriving on display.
- **Live-stream publishedAt drift**: some live streams show `publishedAt` equal to archive time, which can differ from `actualStartTime` by hours. Mitigation: prefer `actualStartTime` when present; fall back to `publishedAt`.

---

## Alternatives Considered

| Option | Rejected reason |
|--------|-----------------|
| **Merge on ingest** (destroy one record, keep the other) | Data loss — the two captures have different authoritative content (video file vs. transcript). Merging loses one of them. |
| **Leave manual linking only** (operator does Link Upstream each time) | Doesn't scale to 18-month backlogs; operators already miss the link step, producing the observed duplicate cards. |
| **Embed sibling metadata on each record** (copy transcript from Fireflies onto the Zoom record) | Violates single-source-of-truth; invalidation when sibling updates is complex. Better to keep links and resolve on read. |
| **Track capture method outside `PlatformLocation`** (a separate table) | Unnecessary indirection; capture method is a property *of* the location, not of the aggregate. |
| **Ignore live-stream case entirely** | Observation 3 already bit us; the 100% match banner is misleading even without changing the Origin/Destination roles. |
| **Flip YouTube to Origin for live streams** | Considered in the first draft of this ADR and rejected. The media still originates at the meeting platform (Zoom/Meet) — YouTube is just one of multiple simultaneous consumers of the stream. Tracking the ingest method on the destination location captures the distinction without distorting provenance. |

---

## Open questions

These are deferred to follow-up ADRs or implementation:

1. **Threshold for auto-linking vs suggest-only**: needs empirical calibration against the current catalog. Suggest shipping the suggestion UX first, then promote to auto-link once confidence is established.
2. **UI representation of an event**: collapsed card with expandable per-source rows? Single card with multiple origin badges? Separate "Events" view? Out of scope here.
3. **Backfill of existing duplicates**: does the system retrospectively group the existing duplicate cards, or only new imports? A one-time "find duplicates" action may be needed.
4. **Participants as a stable key**: Fireflies uses email, Zoom sometimes uses display name only. Normalisation layer required.
5. **Live-broadcast chat + comments**: YouTube Live chat messages are bound to the broadcast, not to the originating meeting platform. They are first-class event content (often Q&A during the session) but would attach to the YouTube `Destination` location, not to the Zoom/Meet `Origin`. Indexing those is out of scope for this ADR but worth flagging.
6. **Meet adapter parity with Zoom**: when Google Meet support lands, does it go through the same download-re-upload path as Zoom, or should Meet recordings that were already live-broadcast be treated as link-only (no re-upload)? This may reduce to a per-profile publish preference rather than a platform-level decision.

---

## Related ADRs

- **ADR-002**: Unified Video Metadata Schema — `VideoRecord` remains the aggregate; this ADR proposes event-level grouping above it, not a schema replacement.
- **ADR-005**: Source Integration Strategy — ingestion adapters are where auto-link detection would fire.
- **ADR-013**: Batch Ingestion Rules — rule criteria may need an "event sibling exists" predicate.
- **ADR-014**: Processing Rules — description enrichment by walking SameEvent edges lives here.
- **ADR-016**: Retrospective Backfill Uploader — live-stream detection changes the semantics of the Recover flow; the addendum there describes the current (upload-only) behaviour.
- **ADR-019**: Video Provenance Graph — `UpstreamLink(SameEvent)` is the mechanism; currently only populated manually.
- **ADR-021**: Zoom Origin Preference — when a SameEvent cluster has both Zoom and Fireflies, Zoom wins as the publish source. Extending this with a profile-level preference is natural.
- **ADR-027**: YouTube Source Ingestion — YouTube-as-origin is already a concept; live-stream awareness is a refinement.
