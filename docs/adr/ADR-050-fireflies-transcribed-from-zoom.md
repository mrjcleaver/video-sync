# ADR-050: Fireflies as Downstream of the Meeting Source

**Status**: Accepted (implemented 2026-06-07)
**Date**: 2026-06-07
**Deciders**: Architecture Team
**Extends**: ADR-049 (live-stream provenance — Zoom-to-YouTube broadcasts)

---

## Context

ADR-049 introduced the `BroadcastedFrom` derivation type and the pair-aware Overview collapse for the Zoom → YouTube-Live case, where the YouTube record is downstream of an RTMP broadcast from a meeting source. Operators surfaced a second, structurally identical case immediately after:

> "I think Zoom was origin, YouTube Live and Fireflies were downstream."

The Fireflies bot joins a Zoom (or Streamyard / OBS / Wirecast) call as a meeting participant, records its own audio capture, and produces a transcript. The Fireflies record is **downstream** of the same upstream meeting — just via a different mechanism (transcription bot vs. RTMP relay).

Concrete example surfaced 2026-06-07: catalog record `c62837e5` (Fireflies, "Agentics Live Vibe - Coding") was auto-linked as `SameEvent` to `db22d0b3` (Zoom, same meeting). Both rows visible side-by-side in the dashboard, no collapse rule. Same operator pain as ADR-049's `779fabe6` case, with a different bot.

`SameEvent` is the right semantic for *peer* captures of the same meeting (Zoom + a second-platform Zoom recording, or two independent OBS recordings) but the wrong semantic when one side derives from the other.

## Decision

Extend ADR-049's directional-pair model to cover transcription bots:

- Re-use the **existing** `DerivationType::TranscribedFrom` variant (already defined in `value_objects.rs` since the original sibling-matcher design — semantically intended for exactly this case, never wired into auto-classification before this ADR).
- Sibling matcher emits `TranscribedFrom` when a Fireflies record is paired with a meeting-source platform (`Zoom` / `Streamyard` / `OBS` / `Wirecast`) inside the same 60-minute time gate ADR-049 uses for `BroadcastedFrom`.
- The pair-aware collapse from ADR-049 treats `BroadcastedFrom` and `TranscribedFrom` as members of a single "downstream pair" family. The Fireflies record hides by default; the Zoom canonical card surfaces a **`📝 Fireflies · <transcript-id>`** badge (orange) next to ADR-049's existing **`📺 YouTube Live · <video-id>`** badge (red).
- One important distinction from ADR-049: a `TranscribedFrom` pair does **not** make the canonical "already published." Fireflies doesn't publish to YouTube — it just transcribes. So the `alreadyPublished` flag on the canonical card stays `false` even when a Fireflies pair is detected, preserving the operator's ability to Publish to YouTube from the Zoom canonical.

| Relation | Direction | Pair member set | Time gate | Counts as "already on YouTube" on canonical? |
|---|---|---|---|---|
| `BroadcastedFrom` | YouTube-Live → meeting source | RTMP broadcast — YouTube-Live + {Zoom, Streamyard, OBS, Wirecast} | ≤ 60 min | Yes |
| `TranscribedFrom` | Fireflies → meeting source | Transcription bot — Fireflies + {Zoom, Streamyard, OBS, Wirecast} | ≤ 60 min | **No** — transcript ≠ publication |
| `SameEvent` | Peer (bidirectional) | Anything else above review threshold | ≤ 30 h (ADR-048 gate) | n/a (not collapsed) |

### When Fireflies is the earliest catalog row (no Zoom upstream available)

> Symmetric to [ADR-049's YouTube-Live-as-canonical case](ADR-049-livestream-provenance-zoom-to-youtube.md#when-youtube-live-is-the-earliest-catalog-row-no-meeting-source-available) — same rule, different downstream platform.


Semantically Fireflies is downstream of the Zoom (or other meeting source) it joined, but the catalog only contains records the operator can *import*. Two operational realities make this break in practice:

- The meeting may be hosted on a Zoom account the operator doesn't own / isn't credentialed against. The host's recording is unreachable; only the Fireflies bot's capture is.
- Fireflies is configured as a **shared dumping ground** — a single Fireflies workspace that the bot joins across many Zoom hosts (community calls, partner sessions, hackerspace events). The Fireflies record exists in our catalog regardless of which Zoom account ran the meeting.

In that case **Fireflies is the earliest record we have**, and for catalog purposes it *acts as the canonical*: nothing upstream exists to collapse it under. The matcher must not invent a Zoom record that isn't there.

Operating rule for the matcher / migrations:

- `TranscribedFrom` is emitted *only* when both sides exist in the catalog. If no meeting-source record matches the Fireflies record within the 60-min gate, the Fireflies row stays standalone — it has no upstream link, and it is its own canonical for any downstream pair purposes (e.g. a YouTube broadcast published from this Fireflies card pairs as `BroadcastedFrom → Fireflies`, with no intermediate Zoom).
- This also means an existing standalone Fireflies record does **not** become an orphan when a Zoom record is added later. The next sibling-matcher / catch-up pass picks up the new pair and writes the `TranscribedFrom` link forward. There is no "stuck canonical" failure mode.
- Downstream pair-aware UI (badges, "already published" gating) works identically whether the canonical is a meeting source or a fallback Fireflies row — the broadcastPairs index keys off "any record that has incoming `BroadcastedFrom` / `TranscribedFrom` upstream links pointing at it", not off platform.

This is why the migration that ran 2026-06-07 only touched 29 Fireflies records — not all Fireflies records had a pair-able Zoom in the catalog, and those without correctly remained standalone.

## What shipped

1. **Sibling matcher** (`web/src/lib/siblingMatcher.ts`):
   - New `TRANSCRIPT_BOT_PLATFORMS = {"Fireflies"}` set (separate from `MEETING_SOURCE_PLATFORMS` so adding Otter/Krisp/Granola etc. is one set entry without touching scoring).
   - New `isTranscribedFromPair()` helper, called by `rankSiblingCandidates` alongside the existing `isBroadcastFromPair`. First match wins; falls through to `SameEvent` if neither fires.
2. **Pairs index** (`web/src/lib/broadcastPairs.ts`):
   - Walks both `BroadcastedFrom` AND `TranscribedFrom` upstream links.
   - Each `BroadcastDestinationInfo` now carries `kind: "broadcast" | "transcript"` + `destination_platform`.
   - Renamed the `youtube_id` field to `external_id` (works for both — the platform-native id with the `"<platform>-"` source-id prefix stripped).
3. **Catch-up orchestrator** (`web/src/lib/catchupOrchestrator.ts`):
   - Directional gate extended: `BroadcastedFrom` only emitted on the YouTube side, `TranscribedFrom` only on the Fireflies side.
   - Migration extended: reclassifies `SameEvent` → `TranscribedFrom` for Fireflies records paired with a meeting-source platform, parallel to the existing YouTube-Live → `BroadcastedFrom` path.
4. **VideoCard** (`web/src/components/VideoCard.tsx`):
   - `pairedDownstreams` split into `pairedBroadcasts` (`kind=broadcast`) and `pairedTranscripts` (`kind=transcript`).
   - `alreadyPublished` only includes broadcast pairs.
   - `markAsAlreadyPublished` falls back to the broadcast pair's `external_id` (transcript pair ignored).
   - New 📝 transcript badge alongside the existing 📺 broadcast badge.
5. **Server-side migration** (one-shot 2026-06-07, before code deploy): walked `catalog.json` directly, reclassified 29 Fireflies records' `SameEvent` upstream links → `TranscribedFrom`. Backup at `/tmp/catalog_backup_<timestamp>_pre_ff.json` on the build host. Affected records span the full back catalogue of AI Hackerspace Live / Agentics Live Vibe / Friday Hackerspace Live / Friday live coding sessions.
6. **Reverse-stub cleanup migration** (one-shot 2026-06-07, after the deploy above): pruned 3 reverse `SameEvent` stubs on Zoom canonicals (`db22d0b3`, `abb9d200`, `a040dab6`) whose downstream Fireflies records were already correctly `TranscribedFrom`. Backup at `gs://video-sync-data-agentics-487016/catalog_backup_<ts>_pre_ab.json`. Resolves Open Question #3.

## Consequences

**Positive**
- The dashboard now reflects the operator's mental model: one canonical row per logical meeting, downstream captures (broadcast + transcript) collapse underneath with informative badges.
- Catch-up no longer surfaces "auto-detected SameEvent" suggestions for Fireflies pairs — it emits the directional relation directly. The "auto-detected" label that confused the operator is no longer the dominant outcome for these pairs.
- Adding more transcription bots (Otter, Granola, Krisp, etc.) is a one-line set update.
- Adding more meeting source platforms (Google Meet when it lands) is the same set update that ADR-049 already calls out — both relations benefit.

**Negative**
- ADR-050 builds on ADR-049's directional-relation pattern, increasing the surface area of the "downstream pair" concept. A future operator looking at the pair-collapse UI sees something rich; a developer reading the code has more relation variants to internalise.
- The TranscribedFrom 60-min time gate is the same as BroadcastedFrom. If a Fireflies bot is configured with a long-delayed join policy (e.g. retries 30 min later), the pair could miss the gate and remain `SameEvent`. Tunable via the constant if it surfaces.

**Risks**
- The existing `TranscribedFrom` enum variant in Rust was previously dormant. Older clients (browsers cached from before 2026-06-07) may not recognise it in catalog hydration — the `relation` is a string in JSON, so unknown values would just fail the relation === "BroadcastedFrom" / "SameEvent" checks silently and the link wouldn't render with its semantics. Mitigated because every operator's browser auto-refreshes on the next visit after deploy; no long-lived clients.

## Alternatives considered

| Option | Rejected reason |
|---|---|
| **Keep using `SameEvent` for Fireflies pairs** | The operator's mental model and the data model disagree — every recurring meeting accumulates two visible rows for one event. Status quo broken. |
| **Introduce a fresh `BotCapture` / `CaptureOf` relation** | `TranscribedFrom` already existed in the enum (defined in the original sibling-matcher work but never wired) and is semantically accurate for what Fireflies produces. Adding a new variant when an existing one fits would create two near-synonyms. |
| **Merge Fireflies + Zoom records into one row server-side** | Loses ability to inspect each source's contributions independently; record_id semantics break for any external system holding catalog IDs. Pair-aware rendering (ADR-049's pattern) gives the operator-facing benefit without the irreversible merge — same reasoning ADR-049 used. |
| **Detect via description scan (transcript markers, bot signatures)** | Fragile; depends on operator-editable text. The sibling-matcher's platform-pair signal is durable and already in place. |

## Open Questions

1. **Other transcription bots.** Otter, Granola, Krisp, etc. — when/if they land as source platforms, adding them to `TRANSCRIPT_BOT_PLATFORMS` plus an import flow is the work. No model changes.
2. **Time gate per-relation.** Both `BroadcastedFrom` and `TranscribedFrom` use 60 min today. A bot's join latency profile may differ from RTMP relay delay; if Fireflies pairs start missing the gate, split the constants. Not seen in operator practice yet.
3. ~~**Reverse-direction cleanup.** The migration changes the Fireflies → Zoom link to `TranscribedFrom` but does not touch the reverse Zoom → Fireflies `SameEvent` link.~~ **Resolved 2026-06-07** — a follow-up operator-invoked migration pruned the reverse SameEvent stub on 3 Zoom canonicals (`db22d0b3`, `abb9d200`, `a040dab6`). The stub was rendering as "Fireflies is upstream of Zoom" on the canonical's provenance-card view, which is the inversion the user reported. Pruning rule: drop a canonical's `SameEvent → <downstream>` link when the downstream record has the corresponding directional link (`TranscribedFrom`/`BroadcastedFrom`) pointing back at the canonical.
4. **TranscribedFrom for non-meeting sources.** A YouTube video could in principle be transcribed by a service like Whisper-API that wasn't joined as a bot — semantically still `TranscribedFrom` but the trigger pattern is different. Out of scope here; same-event-at-the-time-of-recording is the trigger this ADR detects.
5. **Missing YouTube source rows for past publications.** Audit on 2026-06-07 found that **none** of the 28 Destination-YouTube locations on existing host records have a corresponding YouTube source row in the catalog — so ADR-049's `BroadcastedFrom` pair-aware UI is currently a no-op for all historical publishes. 22 of those 28 are hosted on a Fireflies record (which per the operating rule above is sometimes the legitimate canonical, sometimes a downstream of a missing Zoom). Backfill plan tracked separately (informal C1 + C3): C1 = ingest the 28 YouTube IDs as YouTube source rows via the existing import path, then let the matcher classify; C3 = wire the publish-to-YouTube path so it ingests the resulting YouTube video as a source row on success, preventing this gap from accruing further.

## References

- ADR-049: live-stream provenance — Zoom-to-YouTube broadcasts. This ADR is its sibling for the bot-transcription axis.
- ADR-033: multi-origin dedupe / sibling matcher — the scoring this ADR's detection pivots from.
- ADR-048: date-distance gates — the time-gate plumbing reused for the 60-min `TranscribedFrom` bound.
- Concrete example: catalog records `c62837e5-33b4-4807-9605-f5ee760b3a1b` (Fireflies) + `db22d0b3-7f7e-4be5-903e-f22fa797ee50` (Zoom).
- Implementation commit: `fb83546` (feat(ADR-049 ext): Fireflies pairs collapse as TranscribedFrom).
- Migration: server-side Python pass on 2026-06-07, reclassified 29 Fireflies upstream links.
