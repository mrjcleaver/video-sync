# ADR-068: Bulk YouTube Description Sync + Backups

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-03 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-041 (audit log), ADR-042 (shared credential vault), ADR-064 (description strategy), ADR-067 (Show Notes → description prompt) |

---

## Context

ADR-067 taught the per-card Copy-from-Show-Notes button to write a Show-Notes-derived description onto the local record, and ADR-064-adjacent added a per-card **↗ Push title + description to YouTube** button. Two friction points have surfaced when using those primitives at catalog scale:

1. **No bulk audit.** After a Show-Notes prompt tweak or a description-format change, an operator wants to see *which* of the hundreds of catalog records are now out of sync with their live YouTube counterpart, without opening each card and eyeballing. The existing flow answers "does one record match?", not "which records don't?".

2. **No undo.** Every `/api/youtube/update-title` PUT overwrites the live YouTube snippet. If the operator pushes a bad batch — an over-truncated prompt output, the wrong record IDs selected, a Show Notes doc that had a broken chapter map — there's no way to walk it back short of hand-editing on YouTube Studio. The stakes are especially high because YouTube's description field can carry chapter cues that viewers rely on.

---

## Decision

### 1. Bulk comparison + push card in Maintain

New card on the Maintain page: **↗ YouTube description sync**. Publisher+ only.

- **Scan**: for every catalog record with a YouTube location AND a non-empty local description (source-platform OpusClip excluded), batch-fetch the live YouTube snippet via a new `POST /api/youtube/snippets` endpoint (50 ids per `videos.list` call). Compare local vs live description.
- **Categorise** each row into one of:
  - `in_sync` — trimmed equality.
  - `differs` — non-trivial difference.
  - `yt_empty` — local has copy, YouTube description is blank.
  - `local_empty` — local blank; can't push meaningful content.
  - `missing_on_yt` — the YouTube id was not returned by `videos.list` (deleted / privacy / wrong id).
- **Select-and-push**: bulk select rows (with a "select all differing" one-click), then push the local description to YouTube for each. Reuses the per-record `/api/youtube/update-title` endpoint so the same idempotence + auth + logging paths apply.
- **Client-side loop**, one PUT per record. Sequential rather than parallel — the batches we're realistically pushing (10s of records) don't need concurrency and the sequential shape keeps YouTube quota + rate-limit behaviour predictable.

### 2. Snapshot the prior YouTube state before every write

New backup store at `data/description-backups.json`. Every `POST /api/youtube/update-title` that actually changes state:

- Fetches the current YouTube snippet (already does this to preserve `categoryId`).
- Persists the `{ prior_title, prior_description, new_title, new_description, taken_by, taken_at }` tuple into the backup store BEFORE issuing the `videos.update` PUT.
- Prunes older entries per `(record_id, yt_video_id)` — **retains the newest 2** as the ADR requirement calls out. The window is small on purpose: two backups is enough to undo "I just made a mistake" without turning the backup file into an unbounded archive. History beyond the last two lives in Cloud Logging via `channel: "yt:update-title"` audit entries.
- Backup capture is best-effort: a store-write failure logs `warn` but doesn't block the primary update — the alternative would be refusing to update YouTube when disk is flaky, and the whole point of this ADR is to make updates *safer*, not brittler.

### 3. Restore endpoints

- `GET /api/description/backups[?record_id=<id>]` — Publisher+, lists visible backups.
- `POST /api/description/backups/[id]/restore` — Publisher+. Reads the backup, calls back into `/api/youtube/update-title` with the prior title + description as the new values. **The current YouTube state gets captured as a new backup first** — so a restore is itself undoable. The endpoint accepts `{ dry_run: true }` to report what would happen without actually PUTting.

### 4. UI surface for backups

Every row in the sync card carries a **Backups** button. Click opens a per-record list with `taken_at / taken_by / prior_title / prior_description length / ↶ Restore` per row. The "↶ Restore" button confirms before dispatching, explains that the current state is being captured first, and refreshes the deltas + backup list on success.

Backups aren't listed anywhere else yet — no per-card affordance, no Config-page browser. If the Maintain-card flow proves useful we'll surface them beside the record's Description too.

---

## Consequences

**Positive**
- Answers "what's out of sync?" at catalog scale in one click. Previously required opening every card.
- Undo becomes a first-class button rather than a "hope you have a copy in your buffer" scramble.
- Backup capture is coupled to the write path — an operator cannot forget to snapshot; every PUT snapshots automatically.
- Restore reuses the same `/api/youtube/update-title` codepath as a forward push, which means every restore itself gets backed up (recursive undo). The 2-per-record cap prevents unbounded growth in ping-pong scenarios.

**Negative / trade-offs**
- **Only 2 backups per record.** A batch of consecutive bad pushes can walk off the end of the window. The retention is a deliberate simplification — operators wanting deeper history query the audit channel. If the cap proves too tight, bumping it is a one-line change (`KEEP_PER_TARGET`).
- **Client-side sequential loop** on the bulk push. For ~200 records it's a few minutes end-to-end. Acceptable at current scale. When we cross ~1000 records per push, the loop should move server-side with progress SSE.
- **Backup capture requires an extra videos.list call per update** — already happening for `categoryId`, so no new cost.
- **The backup file lives on FUSE** — if the mount is unavailable, backup writes fail (silently, logged as warn). The primary YouTube update still succeeds. Operators need to know the safety net can fail; the sync-panel copy says "backup captured" per push but doesn't verify the file actually landed. If FUSE reliability becomes a concern, a follow-up ADR can move backups to a real durable store.
- **No cross-record undo** — restoring is one record at a time. A "restore this batch" affordance would be nice; deferred.

**Downstream effects to watch**
- **ADR-041 audit log** now has richer `yt:update-title` entries with `titleChanged` + `descriptionChanged` flags. The Access Log panel (§ADR-041) can surface them.
- **ADR-064 push button** on each card writes into the same backup store — an operator using per-card push benefits from the safety net too, not just bulk-sync users.
- **YouTube API quota**. `videos.list` is 1 quota unit; `videos.update` is 50. Scanning 200 records costs 4 quota units; pushing 200 records costs 10,000. Well below the default 10,000/day limit for a single scan, but a full push over the whole catalog will burn most of a day's quota. Worth a warning banner if the selected count exceeds ~150.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| Keep unlimited backup history in a rolling ring per record | Backups accumulate faster than they're consulted. 2 covers "immediate oops" which is the actual failure mode; deeper history sits in the audit log. |
| Server-side bulk-push with SSE progress | Warranted at higher scale; current usage doesn't justify the extra complexity yet. |
| Store backups in Secret Manager (durable, versioned) | Overkill for text blobs. FUSE JSON is sufficient. |
| Move backup capture into a database (Firestore/SQLite) | Same rebuttal — text blobs, low volume, atomicity not a concern (last-write-wins per record is fine). |
| Backup at ingest time only (freeze the "original" YouTube description forever) | Doesn't help the "I just pushed a bad edit, roll me back to yesterday" case. Two rolling backups per record covers the actual operator flow. |

---

## Out of Scope

- **Per-card backup viewer** on the VideoCard itself. Deferred — the Maintain surface covers the currently-motivated use case.
- **Restoring a full batch** (undo my last bulk push in one click). Deferred; individual restores compose to the same effect at 1× the clicks.
- **Config-page browser** for all backups across the catalog. Deferred until an operator asks for it.
- **Diffing UI** showing the exact character delta between local and YouTube description. Deferred; showing character-count deltas is enough for triage.
- **Migrating backups to a durable store**. Follow-up if FUSE-mount reliability becomes a concern.
