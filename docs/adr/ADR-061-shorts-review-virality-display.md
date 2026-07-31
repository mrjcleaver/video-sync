# ADR-061: Shorts Review Queue — Sort by Virality and Show the Breakdown

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-07-27 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-029 (auto-shorts generation), ADR-060 (scheduled show segments) |

---

## Context

The Shorts review queue on `/shorts` lists every OpusClip child of the current catalog in whatever order Opus returned them — which is roughly chronological by clip position inside the source video. That's a poor ordering for operator review: some clips are obvious winners, some obvious cutting-room-floor, and the reviewer has to open each preview to tell. Opus itself ranks its clip proposals with a composite virality score and an intent breakdown (e.g. `A- Hook · B+ Emotion · C Payoff`) visible in its own dashboard — we just weren't surfacing any of it.

Two problems compound:

1. **Ordering**: clips of very different quality sit adjacent, so the operator has to scan the whole list to spot the ones worth publishing.
2. **Signal loss**: even when the operator has decided to publish some fraction of a batch, they don't know *why* Opus flagged a clip — just that it's there.

---

## Decision

### 1. Sort each ShortsPanel band by virality descending

Pending / Approved / Failed / Published bands each sort their rows by `metadata_extra.virality_score` descending, tie-break on `clip_start_seconds` ascending. Rows without a score sink to the bottom. Rejected stays chronological (order irrelevant once decided).

### 2. Prominent 0–100 score badge, moved left of title

The current tiny badge (already computed but hidden by low contrast when the score is 0) becomes the leftmost element on the clip row, sized to be scannable at ~24 px monospace. Colour-coded: `≥ 70` green, `40–69` amber, `< 40` muted. Zero-score rows show `—` rather than `0` so the operator can tell "no signal" from "low signal."

### 3. Breakdown chips under the title

When Opus returns per-axis grades (Hook / Emotion / Payoff / Clarity / Flow etc.), each grade renders as a small chip: `A- Hook`, `B Payoff`. Chips wrap onto a second line for narrower viewports; they never push actions off-screen. When Opus returns no breakdown (v2 API often omits it), the chip strip is absent — no empty scaffolding.

### 4. Data plumbing

Opus's `ExportableClipRepresentation` in v2 does not include the composite score or the breakdown in every response — the API sometimes surfaces them under a separate `virality-insights` endpoint per project. Our approach:

- **Primary path**: keep reading `clip.viralityScore` from the exportable-clips response when present. Any breakdown we can extract from `keywords[]` or `text` gets recorded on `metadata_extra.virality_breakdown` as `{ axis: string; grade: string }[]`.
- **Secondary path (deferred)**: a probe of `/api/virality-insights?projectId=<jobId>` if Opus documents it. Not shipped in this ADR — waiting for stable API surface.
- **Legacy rows**: existing OpusClip records show `—` for the score badge and no breakdown chips. Re-running "Discover clips from Opus" (Maintain panel) refetches per project and re-populates whichever fields Opus returns today.

### 5. Interaction: sort persists across reload

The sort order is deterministic (score desc, then start-time asc) so no toggle is needed. If ordering flexibility is required later, a "Sort by: virality / order in video / duration" dropdown would sit next to each band's heading — deferred.

---

## Consequences

**Positive**
- Reviewer's eye lands on the strongest proposals first; the ratio of "publish" clicks to "reject" clicks per unit of time improves.
- Score visible without hovering means faster ok/skip decisions.
- Breakdown chips carry Opus's rationale into our review UI so the operator isn't re-guessing what Opus flagged.
- Zero-signal rows are distinguishable from low-signal rows (`—` vs `40`).

**Negative / trade-offs**
- **Opus v2's score omission**: on batches where Opus returns nothing, every row is `—`. Sort collapses to insertion order — same as today. No regression.
- **Breakdown extraction is heuristic** until Opus documents a stable field. If Opus changes their `keywords` conventions, chips could stop rendering; the score sort still works.
- **Rejected band retains chronological order** — intentional. Rewriting after rejection is noise.

**Downstream effects**
- **ADR-029** review-gate: no gate change, just presentation. Rows still land in Discovered/InScope regardless of score; the gate is human review as before.
- **ADR-060** segments: when the operator picks "Main show only" for clip generation, Opus's score distribution should tighten because the model no longer competes against pre/post-show low-signal candidates. Reviewer will observe this once ADR-060 lands and enough series have schedules declared.
- **Discovery flow** (`opusClipsDiscovery`): the Maintain-panel "Discover clips from Opus" pass persists whatever score fields Opus returns; that pass is the retroactive path for legacy rows. Encourages operators to rediscover after this ADR ships.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| Auto-approve above a virality threshold | ADR-029's decision was explicitly against auto-publish for reputational reasons; auto-approve is the same class of decision one step earlier. Reviewer keeps the gate. |
| Show the score as text only, no colour | Loses the biggest reason to add the score: at-a-glance scanning. |
| Sort by score only after operator opts in | Adds a toggle for what should be the obvious default. |
| Fetch virality breakdown per clip on demand | Cascades to N API calls per opened batch; and Opus doesn't expose a per-clip endpoint anyway. Batch fetch or nothing. |

---

## Out of Scope

- Sort direction toggle / alternative sort keys (deferred; add if operator asks).
- Auto-approve above a virality threshold (see Alternatives).
- Fetching virality breakdown from a separate `virality-insights` endpoint (see §4).
- Per-viewer-segment scoring (needs data we don't have).
