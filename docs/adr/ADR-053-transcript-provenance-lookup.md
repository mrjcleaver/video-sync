# ADR-053: Transcript Provenance Lookup — Borrow Transcripts From Related Records

**Status**: Proposed
**Date**: 2026-06-08
**Deciders**: Architecture Team
**Related**: ADR-019 (provenance graph), ADR-039 (Drive-based artifact storage), ADR-046 (prompt-driven summaries), ADR-049 (live-stream provenance), ADR-050 (Fireflies as downstream of meeting source), ADR-052 (Catch-Up summary badge backfill)

---

## Context

ADR-052 carved a Summary Badge Backfill out of the catch-up pipeline but explicitly scoped it to records that already have a transcript (`transcript_text.length >= 200`). Records without transcripts stay at `📄 —` because the existing summary pipeline gates on the record's own `transcript_text` field. The operator's framing:

> "Maybe deal with the ones that do have transcripts and have a different backfill that seeks to match a Fireflies or other transcript source from provenance — i.e. a separate ADR"

That separate ADR is this one. The provenance graph already knows when one record is "the transcript bot's capture of" or "the broadcast of" or "the same event as" another — links built by ADR-033's sibling matcher and the ADR-049/050 directional extensions. If a record lacks a transcript but is linked to one that has it, we should use it.

Concrete cases this unblocks (every one of these has at least one real record in catalog today):

- **Zoom record + paired Fireflies** (`TranscribedFrom → Zoom`): Zoom has no transcript of its own; Fireflies has a clean diarised one. → Borrow Fireflies's transcript when summarising the Zoom record.
- **Standalone YouTube Live** (no Zoom upstream in catalog, per ADR-049/050 fallback-canonical rule): YouTube has auto-captions; the canonical (YouTube itself in this case) doesn't necessarily have a transcript field populated. → Borrow YouTube's auto-captions.
- **Zoom record + paired YouTube Live broadcast** (`BroadcastedFrom: YouTube → Zoom`): Zoom is the canonical; YouTube auto-captions cover the same event audio. → Borrow YouTube's captions when Fireflies isn't available.
- **Loom or Kaltura record with a `SameEvent` peer that has a transcript**: borrow the peer's.

There's a quality ordering: Fireflies diarised > YouTube auto-captions > nothing. Some donors are strictly better than others.

## Decision

Add a **transcript provenance lookup** layer between "record" and "summary generation" (and any other transcript-consuming feature). When a record's own `transcript_text` is empty (< 200 chars), walk the provenance graph in a defined safe-relation set and find a donor record. Use the donor's `transcript_text` for the downstream operation (summary, future search, etc.).

### Safe-relations set

The graph distinguishes `DerivationType` variants (`value_objects.rs`). Each variant has a different implication for "is this related record's transcript valid for the current record?":

| Relation | Meaning | Safe to borrow transcript? | Direction |
|---|---|---|---|
| `SameEvent` | Peer capture of same event | **Yes** | bidirectional |
| `BroadcastedFrom` | YouTube-Live is a broadcast of meeting source | **Yes** | both directions — same audio, full duration |
| `TranscribedFrom` | Transcription bot captured the upstream meeting | **Yes** | both directions — exact-purpose match |
| `ClipOf` | Subset of the upstream | **No** | clip's transcript = partial; can't represent the full upstream |
| `ScreenRecordingOf` | Screen recording of the upstream | **No** | different audio surface — may include voice-over, omit music, etc. Confidence too low for auto-borrow. |

Walking the graph from a target record R means: look at R's outgoing `upstream_links` AND find any record X where X's `upstream_links` reference R. For each link in the safe-relations set, check the related record's `transcript_text`.

### Donor selection — quality ordering

When multiple donors qualify, prefer higher-quality sources. Default order:

1. **Fireflies** (any `TranscribedFrom`-related record on platform `Fireflies` or `TRANSCRIPT_BOT_PLATFORMS`) — diarised, speaker-attributed, clean.
2. **Zoom recording transcript** (`SameEvent` peer or `BroadcastedFrom` upstream on Zoom/Streamyard/OBS/Wirecast) — Zoom's auto-transcription, generally good quality.
3. **YouTube auto-captions** (`BroadcastedFrom` downstream on platform YouTube) — works but less accurate, no diarisation.
4. **Kaltura captions** (`SameEvent` peer on Kaltura) — varies by upload pipeline.

The lookup returns the first donor in priority order. If multiple Fireflies records exist (e.g. multiple bots joined the same meeting), pick the one with the longest `transcript_text` as tiebreaker.

### Borrow at read time, not at backfill time

**Do not copy** the donor's transcript text into the target record's storage. Reasons:
- Donors may update their own transcript (re-transcription, manual edits); cached copies in target records would silently go stale.
- The donor's transcript already lives on Drive (ADR-039) — duplication wastes Drive quota.
- Adding a `transcript_source_record_id` pointer is enough provenance — the read site resolves lazily.

Concretely: a pure function

```ts
resolveTranscriptForOperation(
  record: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
): { text: string; source: TranscriptSource } | null
```

returns either the record's own transcript or a borrowed one, with `source` describing where it came from. Consumers (summary generation, future search, future export-to-Drive) call this rather than reading `record.transcript_text` directly.

```ts
type TranscriptSource =
  | { kind: "own" }
  | { kind: "borrowed"; donor_record_id: string; donor_platform: string;
      donor_relation: "SameEvent" | "BroadcastedFrom" | "TranscribedFrom";
      direction: "outgoing" | "incoming" };
```

### Badge UI — surface borrow transparently

The `SummaryLozenge` gains a "via-pair" indicator when the underlying transcript was borrowed: e.g. `📄 v3 ←FF` (FF = Fireflies). Tooltip: `Summary v3 (transcript borrowed from Fireflies record <id> via TranscribedFrom)`. The operator can see at a glance which records have summaries built on their own transcript vs a donor's.

### Catch-Up backfill — unblocks ADR-052's deferred case

With this in place, the existing `tryEnsureSummary` no longer hard-skips records with no own-transcript. It calls `resolveTranscriptForOperation` first, generates from whatever that returns. The Summary Badge Backfill from ADR-052 then implicitly covers transcript-less records too — no new button, just smarter resolution.

Optionally, the badge backfill driver can use the resolver to **pre-flight count** "would-be-eligible-via-borrow" records and surface them in the pre-flight count (e.g. `Run backfill (12 missing, 4 stale, 7 via borrowed transcript)`).

## Implementation sketch

```ts
// web/src/lib/transcriptProvenance.ts (new)

const TRANSCRIPT_SAFE_RELATIONS: ReadonlySet<string> = new Set([
  "SameEvent", "BroadcastedFrom", "TranscribedFrom",
]);

const DONOR_PRIORITY: ReadonlyArray<(rec: VideoRecordJSON) => boolean> = [
  (r) => r.source_platform === "Fireflies",
  (r) => ["Zoom", "Streamyard", "OBS", "Wirecast"].includes(r.source_platform),
  (r) => r.source_platform === "YouTube",
  (r) => r.source_platform === "Kaltura",
];

export interface ResolvedTranscript {
  text: string;
  source: TranscriptSource;
}

export function resolveTranscriptForOperation(
  record: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
  minLength = 200,
): ResolvedTranscript | null { ... }

/** Find all donor candidates — exported for testing + the
 *  pre-flight count in ADR-052's backfill panel. */
export function findTranscriptDonors(
  record: VideoRecordJSON,
  allRecords: VideoRecordJSON[],
): Array<{ donor: VideoRecordJSON; relation: string; direction: "outgoing" | "incoming" }> { ... }
```

`tryEnsureSummary` updates:

```diff
- if ((record.transcript_text?.length ?? 0) < 200) return { generated: false, reason: "no transcript" };
+ const resolved = resolveTranscriptForOperation(record, videoStore.getAll());
+ if (!resolved) return { generated: false, reason: "no transcript (own or via provenance)" };
```

`/api/summary/generate` accepts a new optional `borrowed_transcript_text` field so the client passes the resolved text directly. Server-side `summary_doc_id` writes record the donor pointer for audit.

## Consequences

**Positive**
- Transcript-less records that have a paired transcript donor get summaries automatically. Resolves ADR-052's deferred case for the majority of records that need it.
- No data duplication — donor transcripts stay in one place (Drive, donor record).
- Cleaner separation: `transcript_text` continues to mean "this record's own captured transcript", `resolveTranscriptForOperation` means "best transcript usable for this record."
- Badge UI's via-indicator gives operators provenance transparency — clear when a summary is built on borrowed input.
- The same resolver becomes useful for any future feature that wants a transcript (search index, RAG embedding, transcript display modal).

**Negative / careful**
- **Borrowed-transcript summary staleness**: if a donor's transcript is updated after the summary was generated, the summary becomes stale but the prompt-version check doesn't detect it. The borrowed summary needs a secondary staleness signal — e.g. store `summary_source_transcript_hash` and detect drift. Tracked in Open Questions.
- **Confidence asymmetry**: a YouTube auto-caption transcript will produce a noticeably lower-quality summary than a Fireflies one. The badge surfaces the source but the summary's `summary_counts` won't reflect quality. Operator should know the via-pair indicator is also a quality cue.
- **Cross-record reads at summary time**: `resolveTranscriptForOperation` needs `allRecords` to scan inverse links. The current `tryEnsureSummary` receives only `record`. This adds an `allRecords` arg through the call chain. Mostly mechanical; the catch-up orchestrator already has it loaded.

**Risks**
- A donor record might itself have a borrowed transcript indicator in some future world where this pattern is recursive. ADR-053 explicitly disallows transitive borrow — only direct provenance edges. Documented in Open Questions.
- Operator confusion: "why is this Zoom record's summary so much better than that one's?" — answer is the donor pool differs. The badge surface mitigates but doesn't eliminate this. Operator education / docs.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Copy donor transcript into the record at backfill time** | Creates a stale duplicate. Re-transcription on the donor side is silently invisible to the target. Per-record storage explodes. Read-time resolution avoids all of this. |
| **Restrict to a single relation (TranscribedFrom only)** | Misses real cases like a Zoom record paired with a YouTube broadcast where YouTube has the transcript and Fireflies doesn't exist. The safe-relations set isn't that big — handle all of them. |
| **Allow ClipOf as a borrow source** | A clip's transcript doesn't cover the full source record. Producing a summary from a partial transcript would silently mislead. Hard exclusion preferred over a per-case judgement. |
| **Generate a fresh transcript via Whisper / Gemini audio mode** | Real work, real cost, real engineering. Out of scope for this ADR — would be its own ADR-054 if pursued. The provenance route gets us 80% of practical coverage for free. |
| **Persist a `transcript_source_record_id` pointer on the record** | Considered. The resolver is stateless and re-resolves on demand, which is fine for the read-side use cases. If a future feature needs to *audit* which donor was used for a specific historical summary, store the pointer on the summary doc (Drive artifact metadata) — not on the video record. Keeps records lean. |

## Open Questions

1. **Borrowed-summary staleness on donor transcript update.** Today: `summary_prompt_version` mismatch is the only staleness signal. We should also flag stale when the donor's transcript has been updated since the summary was generated. Mechanism options: hash-of-donor-transcript stamped on summary doc; or last-modified comparison via Drive metadata. Worth a small follow-up; not blocking.
2. **Recursive / transitive borrow.** Out of scope here — direct provenance edges only, no chasing through chains. A donor with its own borrowed-from is allowed (its summary is fine for *its* needs) but we don't transitively borrow from it to a third record. Re-visit if a real graph emerges that needs it.
3. **Manual operator preference for a specific donor.** Some operators may have strong preferences ("always prefer Zoom's transcript over Fireflies when both exist"). Today: hardcoded priority. Future: per-prompt-version or per-record override. Defer.
4. **Search and other readers**: ADR-053 names "future search" as a beneficiary of the resolver. The current search index (per ADR-006) is built off `record.transcript_text` directly. Switching it to call the resolver would broaden coverage materially — separate piece of work, easy to scope.
5. **`ScreenRecordingOf` revisit**: marked unsafe here because we can't be confident the screen-rec audio matches the source's audio. If real data shows the audio IS reliably the same (e.g. OBS screen-rec of a Zoom call always pipes the meeting audio), revisit and add it to the safe set.

## References

- ADR-019: Video provenance graph — the upstream_links + locations model.
- ADR-039: Drive-based artifact storage — where transcript text physically lives.
- ADR-046: Prompt-driven video summaries — what consumes the transcript today.
- ADR-049 / ADR-050: directional pair model — where the safe relations come from.
- ADR-052: Catch-Up Summary Badge Backfill — calls out this ADR as the unblocker for transcript-less records.
- Existing summary-stage check: `web/src/lib/catchupOrchestrator.ts:307-345` (`tryEnsureSummary`).
- Existing badge UI: `web/src/components/SummaryLozenge.tsx`.
- Existing safe-relations parallel: `web/src/lib/broadcastPairs.ts` (`BroadcastedFrom` + `TranscribedFrom` walker — same set this ADR formalises for transcript borrow purposes).
- Implementation pattern reference: pure resolver + tests (parallel to `web/src/lib/youtubeIngest.ts:resolveYouTubeCanonical`).
