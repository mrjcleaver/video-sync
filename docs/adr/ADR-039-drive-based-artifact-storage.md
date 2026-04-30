# ADR-039: Drive-Based Artifact Storage for Transcripts, Descriptions, Summaries, and In-Meeting Chat

**Status**: Proposed
**Date**: 2026-04-30
**Deciders**: Architecture Team
**Supersedes (in part)**: ADR-035 Level 2 transcript storage
**Related**: ADR-035 (storage topology), ADR-036 (Workspace auth), ADR-014 (publishing-attribute processing rules), ADR-015 (Fireflies import), ADR-034 (chat-query MCP)

---

## Context

Today the app stores artifacts across three places:

| Artifact | Where | Authoritative? |
|----------|-------|----------------|
| Transcripts | `data/transcripts.json` on GCS FUSE (ADR-035 L2) | Yes |
| Generated descriptions | Inside the WASM `VideoRecord` JSON, persisted in `data/catalog.json` | Yes |
| Long summaries | Not stored — re-generated on demand from rules | No |
| In-meeting chat | **Not captured** | — |

This works but it has friction:

- Drive is where the Workspace users (operators, board members, viewers) already live. Sharing a markdown summary today means downloading it from the app and re-uploading to Drive.
- Drive's revision history, comments, search, and ACLs are familiar and policy-controlled at the org level. GCS objects have none of that ergonomically.
- The app doesn't currently capture Zoom in-meeting chat at all, even though it's available in the Zoom Cloud Recording API as a `CHAT` entry alongside the video and transcript.
- Long summaries (the "rich" LLM-generated narrative for a meeting, distinct from the YouTube description) have no home — they get regenerated each time, costing tokens.

The operator asked on 2026-04-30:

> Storage of transcripts, generated descriptions and long summaries and chat interactions during calls should be on a workspace google drive.

---

## Decision

Move all four artifact types to a Workspace-owned Google Drive folder, as Markdown files, with one folder per meeting record. Drive becomes the **single source of truth** for these artifacts; GCS-backed `data/transcripts.json` is migrated and removed.

### Scope of this ADR

**In:**
- Transcripts (replacing `data/transcripts.json` on GCS FUSE)
- LLM-generated long descriptions (currently on the WASM record's `description` field — augmented, not replaced)
- LLM-generated long summaries (new artifact)
- Zoom in-meeting chat captured from Zoom Cloud Recording's `CHAT` file_type (new capture)

**Out:**
- Catalog metadata (`data/catalog.json`) — stays on GCS FUSE; ADR-035 Level 2 unchanged
- Rules (`data/rules.json`) — stays on GCS
- Credentials — ADR-011 pattern (browser localStorage), preserved per ADR-035 Level 3 deferral
- Fireflies "during call" chat — Fireflies doesn't expose this; not addressable here

---

## Storage layout

### Drive folder structure

```
[Shared Drive: agentics.org] / Video-Sync Artifacts /
  2026-04-21--zoom-abc123-engineering-standup /
    transcript.md
    description.md
    summary.md
    chat.md
    .meta.json
  2026-04-22--fireflies-xyz789-board-review /
    transcript.md
    description.md
    summary.md
    .meta.json   ← no chat.md (Fireflies has no chat capture)
  ...
```

- **Top-level**: a single Shared Drive folder, `Video-Sync Artifacts`. Configurable via env var `DRIVE_ROOT_FOLDER_ID`.
- **Per-meeting folder**: name format `<recorded_at_yyyymmdd>--<source-platform>-<source-id-truncated-12>-<slugified-title-32>`. Slugify drops anything outside `[a-z0-9-]`. The leading date prefix gives chronological browsing in Drive's default sort.
- **File names** are stable: `transcript.md`, `description.md`, `summary.md`, `chat.md`. Missing files are valid — not every meeting has every artifact. `.meta.json` is always present and acts as the index.

### File contents

Each `.md` file has YAML frontmatter for metadata, then the content. Example `transcript.md`:

```markdown
---
record_id: 7f3a92ce-1c1d-4d7e-9b51-...
source_platform: Zoom
source_id: abc123
recorded_at: 2026-04-21T14:00:00Z
generated_by: zoom_api
generated_at: 2026-04-22T09:14:11Z
---

[00:00:01] Alice: Good morning everyone, let's get started.
[00:00:08] Bob: Quick agenda check — three items today...
```

Markdown was chosen over Google Docs because:
- Drive renders `.md` natively in preview (since 2024)
- File writes are ~50ms vs ~1s for a Doc
- No 60M-character limit (Docs)
- Diff-friendly if we ever want to version-control extracts

### `.meta.json` shape

```json
{
  "record_id": "7f3a92ce-1c1d-4d7e-9b51-...",
  "title": "Engineering Standup",
  "source_platform": "Zoom",
  "source_id": "abc123",
  "recorded_at": "2026-04-21T14:00:00Z",
  "artifacts": {
    "transcript":   { "drive_file_id": "1abc...", "size": 152034, "modified": "2026-04-22T09:14:11Z" },
    "description":  { "drive_file_id": "1def...", "size": 4221,   "modified": "2026-04-22T09:15:02Z" },
    "summary":      { "drive_file_id": "1ghi...", "size": 8104,   "modified": "2026-04-22T09:15:33Z" },
    "chat":         { "drive_file_id": "1jkl...", "size": 2876,   "modified": "2026-04-22T09:14:12Z" }
  }
}
```

This is the per-record index — lets the server resolve `record_id → file_ids` without a Drive search per request.

---

## Auth and access

A dedicated Google Workspace service account `video-sync-drive@agentics-487016.iam.gserviceaccount.com` is granted **domain-wide delegation** and impersonates `video-sync-bot@agentics.org` (a real Workspace user dedicated to this purpose). All Drive reads and writes go through the impersonated user, so:

- Drive activity log shows `video-sync-bot@agentics.org` as the actor — clean audit trail.
- The Shared Drive ACL is set to grant `video-sync-bot@agentics.org` Manager role.
- Operators get **Reader** access to the Shared Drive via the same Cloud Identity Groups model as ADR-036 (`video-sync-viewers@agentics.org`, `-operators@`, `-key-admins@` all get read; only the bot account writes).
- Operators reading the Drive UI directly see their own identity; the app's writes are attributed to the bot.

Service account key storage: Secret Manager, named `DRIVE_SERVICE_ACCOUNT_KEY`, mounted into Cloud Run via `--set-secrets`. Same pattern as `OPENROUTER_API_KEY`.

---

## API surface

All endpoints existing today on `/api/catalog/transcripts` collapse into a generic artifact endpoint. The client sees:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/artifacts/:record_id` | GET | Returns `.meta.json` for the record (artifact list with sizes + Drive IDs) |
| `/api/artifacts/:record_id/:kind` | GET | Returns the markdown body — `:kind` ∈ `transcript`, `description`, `summary`, `chat` |
| `/api/artifacts/:record_id/:kind` | PUT | Upsert the markdown body — server writes to Drive and updates `.meta.json` |
| `/api/artifacts/:record_id/:kind` | DELETE | Remove the file (rare; mostly for re-generation) |

Old transcript endpoints (`GET/POST/DELETE /api/catalog/transcripts`) stay for one release cycle, return `410 Gone` with a deprecation header pointing at `/api/artifacts/:id/transcript`. Removed in ADR-039 follow-up.

---

## Performance and caching

This is the biggest cost of the move. GCS FUSE reads are ~5ms; Drive API reads are 200-500ms typical, plus rate limits (1000 reads / 100 sec / user — easily hit during bulk catalog views).

Mitigations:

1. **Lazy fetch in the UI**: the catalog list page never reads transcripts. Transcripts only load when the user opens a specific record's detail panel. This is already how the UI works today after ADR-035 Level 2's `transcripts.json` was made fetchable — no UI refactor needed.
2. **Server-side LRU cache** of decoded markdown bodies, keyed by `(drive_file_id, modified_time)`. ETag-aware. Cache size: 256 entries, ~50MB worst case. Memory-pressure-aware (ADR-032).
3. **Client-side localStorage cache** (already exists) — survives reloads; backed by an `If-Modified-Since` header from the server.
4. **`.meta.json` is always cached aggressively** (1 hour TTL on server, indefinite on client until explicit refresh). It's the only thing in the catalog GET path.

Worst case: a "Find duplicates" scan (ADR-033) iterating every transcript would hit the rate limit. We don't do this today — if we add it, batch via Drive's `files.export` with `Accept: text/plain` and parallelism capped at 10.

---

## Migration plan

One-shot script `scripts/migrate-transcripts-to-drive.sh`. Idempotent.

1. List records from `/api/catalog`
2. Read `data/transcripts.json` once into memory
3. For each `(record_id, transcript_text)`:
   a. Look up existing per-meeting folder in Drive (by `.meta.json` record_id field, via Drive search)
   b. If folder doesn't exist, create it with the naming convention above
   c. Skip if `transcript.md` already exists in the folder with matching SHA-256 (idempotent retries)
   d. Write `transcript.md` with frontmatter
   e. Update or create `.meta.json`
4. After all records processed, run a dry-run report: `gcs-transcripts-without-drive-equivalent.txt` listing any record IDs that failed
5. After human review of the report: `gcloud storage rm gs://video-sync-data-agentics-487016/transcripts.json` and remove the file routes from `web/src/app/api/catalog/transcripts/`

Estimated duration: 15 records × ~2 sec each = 30 sec for the current dataset; scales to ~3 minutes for 1000 records.

---

## In-meeting chat capture (new)

Zoom Cloud Recording API returns a `recording_files` array per recording, with entries like:

```json
{ "file_type": "MP4", "download_url": "..." },
{ "file_type": "TRANSCRIPT", "download_url": "..." },
{ "file_type": "CHAT", "download_url": "..." }
```

We currently fetch `TRANSCRIPT` (ADR-015 indirectly via Fireflies, plus Zoom's own). The `CHAT` entry is plain text in Zoom's format:

```
14:00:08  From Bob to Everyone: morning all
14:00:15  From Charlie (Director of Eng) to Everyone: brb
14:01:42  From Alice to Bob (privately): can you take notes?
```

Capture path: extend `web/src/app/api/zoom/recordings/route.ts` to also pass through chat URLs, and add a new fetch step in the Zoom import flow that downloads the chat (if present), normalises to markdown (one line per message, frontmatter with participant list), and stores as `chat.md`.

Privacy note: private chats (the "to Bob (privately)" line) ARE included by Zoom in the host's chat export. If this is a concern, add a config knob `STRIP_PRIVATE_CHATS=1` that filters lines containing `(privately)`. Default off (transcript is what the host received from Zoom, not a fabrication).

---

## Consequences

### Positive

- Drive becomes the gravitational center for meeting artifacts — operators can search, share, comment, and apply retention policies without involving the app.
- Long summaries get a durable home; no more re-generating tokens every view.
- Zoom in-meeting chat is finally captured.
- Single auth model for artifacts (service account with DwD) — simpler than current localStorage credential pattern.
- Drive's free retention + revision history replaces ad-hoc backups.

### Negative

- **Latency regression**: 5ms FUSE reads → 200-500ms Drive reads. Mitigated by caching but the cache miss case is felt by users.
- **Rate limit risk**: bulk operations need explicit batching.
- **One more service account to rotate** (Secret Manager has rotation reminders).
- **Drive UI permissions are coarse-grained**: a viewer in the group can read every meeting's artifacts. Operators must remember Drive ACLs apply to *all* artifacts, not the per-record permissions the app might one day have (ADR-035 Level 4).
- The app must handle Drive being unavailable gracefully — service degraded, not crashed.

### Risks

- **Domain-wide delegation is powerful** — if the service account key leaks, the attacker can impersonate any Workspace user. Mitigation: key in Secret Manager, narrow OAuth scopes (`drive.file` not `drive`), bot-user-only impersonation, rotation every 90 days.
- **Drive folder accidentally moved or shared too broadly** — same blast radius as a misconfigured GCS bucket today, but more visible. Mitigation: folder is in a Shared Drive (org-owned, not personal), with audit logging.
- **`.meta.json` corruption** orphans the per-record artifacts. Recovery: scan the folder, rebuild `.meta.json` from filenames. Document the recovery script alongside the migration script.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **Mirror to Drive, GCS stays authoritative** (option 1b in design discussion) | Operator wanted Drive as primary so they could edit summaries directly in Drive and have the app pick up the changes. Mirroring loses the round-trip. |
| **Google Docs instead of Markdown** | Doc API write latency ~1s, 60M char limit, no diff-friendly storage. Drive renders Markdown natively now anyway. |
| **PDFs in Drive** | Read-only — operator can't edit a summary in Drive without re-uploading. Loses one of the main reasons to be on Drive. |
| **Keep transcripts on GCS, only move new artifacts to Drive** (option 1c) | Two storage systems for similar data. Operator has to remember which is where when looking for a file. |
| **Per-operator OAuth instead of service account** | Aligned with ADR-011 credential pattern but creates ownership ambiguity (whose Drive owns the artifact when Alice imports a meeting and Bob views it?). Service account + bot user gives one source of truth. |
| **A new dedicated artifacts API on GCS** (no Drive) | Operator already lives in Drive; building another UI would duplicate Drive's ergonomics for no reason. |

---

## Open questions

These should be resolved before implementation starts; flagging for the implementer:

1. **Shared Drive vs org-shared My Drive folder?** Shared Drive is preferred (no ownership-by-individual problem) but requires a Shared Drive to exist in `agentics.org` Workspace. If none exists, this ADR's first task is asking the Workspace admin to create one.
2. **What happens to the `transcript_text` field on the WASM `VideoRecord`?** Proposal: deprecate it. The record carries the `record_id`; the artifact lives in Drive. A new `artifact_index_url` field on the record points to the meta JSON. Keeps the WASM record lean.
3. **Should Fireflies transcripts also flow through this path on import?** Yes — same mechanism, written to `transcript.md` in the meeting folder. The current Fireflies import already populates the transcript; redirect the write target.
4. **Quota of the bot user** — Workspace Drive quota is per-user. Bot user gets the standard Workspace allotment (typically 2TB). Calculate: 1000 meetings × ~10MB average = 10GB. Fine for years; revisit at 1TB.

---

## References

- ADR-011: MVP Credential Proxy Pattern — preserved for OAuth credentials, deferred per ADR-035 Level 3
- ADR-014: Publishing-Attribute Processing Rules — generates the descriptions stored here
- ADR-015: Fireflies Import Integration — current source of one transcript stream
- ADR-032: Runtime Memory Pressure Detection — informs the LRU cache size
- ADR-033: Multi-Origin Dedupe — its "Find duplicates" scan needs Drive batching guidance
- ADR-034: Chat-Query MCP for Live Broadcasts — different "chat" (live broadcast viewers), but informs the `chat.md` schema choice
- ADR-035: Persistence Topology — this ADR carves out transcripts from Level 2; rest of Level 2 stays
- ADR-036: Workspace Authentication — operator group model used here for read access
