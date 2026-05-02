# ADR-043: Share Backfill Profiles, Queue, and Exclusions Across Operators

**Status**: Accepted (implemented 2026-05-02)
**Date**: 2026-05-02
**Deciders**: Architecture Team
**Extends**: ADR-031 (server-side rule persistence), ADR-035 (persistence topology)
**Related**: ADR-016 (backfill uploader), ADR-033 (multi-origin dedupe), ADR-039 (Drive artifacts)

---

## Context

ADR-035 Level 2 moved the catalog and transcripts to the server, then ADR-039 moved transcripts further to Drive. Several other state files were left in browser `localStorage` and continue to behave per-browser. An audit on 2026-05-02 against ADR-035's "shared across browsers" goal found:

| Key | Today | Should be shared? |
|---|---|---|
| `video-sync:records` | Server (GCS catalog.json) | Yes (done — ADR-035 L2) |
| `video-sync:transcripts` | Drive | Yes (done — ADR-039) |
| `video-sync:rules` | Server (rules.json) | Yes (done — ADR-031) |
| `video-sync:connections` | Hybrid (Secret Manager + override) | Hybrid (done — ADR-042) |
| `video-sync:backfill-state` | Server (uploads_today only) | Partially (done — ADR-016) |
| `video-sync:backfill-profiles` | localStorage only | **Yes (this ADR)** |
| `video-sync:backfill-queue` | localStorage only | **Yes (this ADR)** |
| `video-sync:exclusions` | localStorage only | **Yes (this ADR)** |
| `video-sync:rejected-yt-matches` | localStorage only | Deferred — see Open questions |
| `video-sync:rejected-sibling-matches` | localStorage only | Deferred |
| `video-sync:eventlog` | localStorage only | Stays local (per-browser action history; ADR-041 audit covers shared visibility) |
| `video-sync:yt-privacy` / `:yt-uploads` | localStorage only | Stays local (caches; regenerated on demand) |
| `video-sync:records-lastmodified` | localStorage only | Stays local (sync state for ADR-035 L2 merge) |
| `video-sync:import-tab` | localStorage only | Stays local (UI state) |

Concrete operator pain that drove this:

1. **Profiles**: an operator setting up a new backfill profile on Tuesday found that the colleague who ran the orchestrator on Wednesday couldn't see it. Each browser had to recreate it.
2. **Queue**: the orchestrator's "what's next" list lived in the operator's browser. If they closed the tab, the queue went with them and the next operator started from empty.
3. **Exclusions**: Alice excluded a meeting as "don't re-import this", then Bob ran an import and immediately re-imported it. Exclusions are a deliberate org-level decision; per-browser is wrong.

---

## Decision

Move the three remaining org-level state files to the server using the same write-through pattern as ADR-031's rules: localStorage stays as a fast-boot cache and offline fallback; the server is authoritative.

### Storage layout

| Key | New file | Shape |
|---|---|---|
| `video-sync:backfill-profiles` | `data/backfill-profiles.json` | `BackfillProfile[]` |
| `video-sync:backfill-queue` | `data/backfill-queue.json` | `BackfillQueueEntry[]` |
| `video-sync:exclusions` | `data/exclusions.json` | `ExclusionEntry[]` |

All three sit on the GCS-FUSE-mounted `/app/data` (ADR-035 Level 1, active since 2026-04-27), so they survive cold starts and revisions.

### API surface

For each, three operations:

```
GET    /api/backfill/profiles         → BackfillProfile[]
POST   /api/backfill/profiles         body: BackfillProfile[]   (replace whole list)

GET    /api/backfill/queue            → BackfillQueueEntry[]
POST   /api/backfill/queue            body: BackfillQueueEntry[] (replace whole list)

GET    /api/exclusions                → ExclusionEntry[]
POST   /api/exclusions                body: ExclusionEntry[]    (replace whole list)
```

Same one-route-per-resource shape as `/api/rules`. POST replaces the whole list — these are small (typical queue ≤ 100 entries, profiles ≤ 5, exclusions a few hundred at most). Per-record CRUD doesn't earn its complexity here.

### Client-side shims

In `lib/backfill.ts` and `lib/rules.ts`:

- `loadProfiles()` / `loadQueue()` / `loadExclusions()` — unchanged. Read from localStorage. Synchronous, used everywhere.
- `saveProfiles()` / `saveQueue()` / `saveExclusions()` — write localStorage **and** fire `fetch(POST)` best-effort. Same pattern as `saveRules()` since ADR-031.
- New: `syncProfilesFromServer()` / `syncQueueFromServer()` / `syncExclusionsFromServer()` — called from `bootStore()` after WASM init. Server-wins-if-non-empty, otherwise push local up to seed the server.

Boot order (in `page.tsx` `useEffect`):

```ts
await Promise.all([
  syncRulesFromServer(),
  syncProfilesFromServer(),
  syncQueueFromServer(),
  syncExclusionsFromServer(),
]);
```

### Conflict resolution

**Last-writer-wins on the whole file**, not per-record. Two operators editing different profiles simultaneously and both saving will result in one set of edits being lost. This matches the rules.json behaviour today and is acceptable because:

1. Profile/queue/exclusions edits are infrequent (operators rarely edit them in parallel).
2. The cost of a per-record merge is not justified by the collision rate.
3. The localStorage shadow gives an operator a chance to recover their lost edits — the server version is overwritten on next save, but the operator's local version is what they see in the UI.

---

## Consequences

### Positive

- Two operators no longer maintain parallel mental models of "what's queued" or "what's been excluded."
- New operators inherit the org's profiles on first login, instead of starting blank.
- The orchestrator's queue survives browser closes, scale-to-zero, and revision rollouts (it's on the FUSE bucket).
- Exclusions are now a one-time decision per video, made by whoever first dismissed it — not a decision each operator must repeat.

### Negative

- Three more files written to the FUSE bucket. Each save is a GCS PUT; we already saw 429 rate-limit warnings on `server.log` (which is much more write-intensive). Profiles change ~daily; queue updates per-import-attempt; exclusions per-dismissal. No throttling needed at this scale.
- Last-writer-wins is silent. Operators editing in parallel won't see each other's edits clobbered.
- localStorage stays as a cache, so a user with a stale browser (left a tab open through a server-side update) still posts their stale state on next save and overwrites the more-recent server copy. Mitigated by the 5-minute group cache and the relatively low edit rate; not eliminated.

### Risks

- **Queue stampede**: the orchestrator runs server-side and updates the queue mid-import. If two operators each kick off the orchestrator from their own browsers (unusual but possible), both start firing uploads against the same queue. Today's design doesn't lock the queue; a server-side "orchestrator running" flag would be the proper fix. Out of scope here — flag if it becomes real.
- **Exclusions can't be unlinked from an operator** today (the file is a flat list of `{platform, source_id, excluded_at, reason}`). If we later need "Alice excluded this; Bob can override," we'd need to add `excluded_by` and a UI for it. The shape is forward-compatible with that addition.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **Per-record CRUD endpoints** (`POST /api/backfill/profiles/:id`) | Earned complexity; lists are small. Whole-list replace is what `data/rules.json` does and it works. |
| **Per-operator profiles** (Alice's profiles separate from Bob's) | Defeats the purpose. Operators should share a view of org-level state; per-operator means Alice sets up a profile that Bob never sees. |
| **Continue rejecting per-browser, document as known limitation** | Operator pain (Bob re-imports what Alice excluded) is concrete and unlocking. |
| **Move rejected-yt-matches / rejected-sibling-matches in this same ADR** | These are arguably per-operator-judgement ("Alice's 'not a match' shouldn't propagate to Bob"); the answer depends on team policy. Deferred to a separate decision. |

---

## Open questions

1. **Should `rejected-yt-matches` and `rejected-sibling-matches` be shared too?** Two valid views: (a) shared — once a match is rejected the org has decided it's wrong; (b) per-operator — judgement calls vary by reviewer. Defer to operator preference; current behaviour is per-browser.
2. **Server-side orchestrator lock**: when this becomes a real concern (multiple operators kicking off backfill), introduce a `data/orchestrator-lock.json` with a held-by + held-until timestamp. Not built now.
3. **Schema migration for adding `excluded_by` to existing exclusion entries** is trivial (read-modify-write with default values), but worth a one-line adapter in `loadExclusions` if/when added.

---

## References

- ADR-016: Retrospective backfill uploader — defines BackfillProfile shape
- ADR-031: Server-side rule persistence — pattern this ADR follows
- ADR-035: Persistence topology — names the single-browser-constraint problem this addresses
- ADR-041: App-level audit log — covers the per-operator "what did I do" dimension
