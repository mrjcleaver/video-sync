# ADR-071: Google Drive Video Ingest — Contributor Public Link + Publisher Authenticated Pull

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-08-06 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-002 (unified schema), ADR-004 (temporary storage), ADR-005 (source integration), ADR-007 (OAuth), ADR-042 (shared credential vault), ADR-053 (transcript provenance), ADR-065 (contributor role) |

---

## Context

Community contributors and publishers routinely have recordings that live in Google Drive rather than YouTube / Loom / Zoom Cloud:

- A chapter organiser records a local meetup on a phone and uploads the MP4 to a shared Drive folder.
- A guest presenter's laptop screen recording lands in their Drive; they share the link with the org.
- The Agentics Foundation Ops team has an archive Drive folder full of pre-video-sync recordings that predate our source integrations.

Today the `/contribute` page's "Other sources" disclosure tells contributors to drop Drive links into `#agentics-contributions` on Discord for a curator to ingest manually. That's a hand-carried workflow — the curator downloads the file locally, re-uploads it somewhere with a real integration, and manually creates a catalog record. It doesn't scale, contributor attribution is lost, and the file's Drive-native metadata (name, mimeType, duration, thumbnail, `createdTime`, `modifiedTime`) is discarded on the round trip.

Two forces make it worth building a real ingest path now:

1. **ADR-065** landed the Contributor role and the `/contribute` page as first-class product surface. Drive was called out as spec'd-but-not-wired (§5). Contributors are actively asking for it.
2. **ADR-042** already gives us org-shared Google credentials (the same access token the app uses to write show-notes docs to Drive can read files from Drive), and the FUSE-mounted `video-sync-data-agentics-487016` GCS bucket already stores per-record artifacts (transcripts, backups). The infrastructure the ingest needs is already deployed.

We considered three shapes for the ingest (see AskUserQuestion history 2026-08-06):

- **Public-share only**: contributor pastes a "share with anyone with link" URL; we resolve metadata via the un-authenticated Drive endpoint. Simple. Fails whenever the sharer forgot to open permissions or the org policy blocks external sharing.
- **Publisher-triggered OAuth pull**: only Publisher/Admin (whose IAP identity has Drive access) can pull; contributor's role is to submit a link that a curator later actions. Robust, but blocks the self-service path public YouTube / Loom / Zoom-share links enjoy.
- **Both**: public-link path works self-service like YouTube; anything private routes to a curator queue with an "Ingest from Drive" button.

We chose the third — it matches the two audiences (contributor self-service, publisher curation) and preserves the ADR-065 role lattice without collapsing them into one code path.

For the file itself we chose to **copy the bytes into the FUSE bucket at import time**, rather than storing a reference-only `drive://` URL. Two reasons:

- **Durability**: a share link revoked (by the contributor cleaning up their Drive, or by an org retention policy) would silently break the catalog record without the copy.
- **Enables downstream work**: local Whisper transcription (deferred to a follow-up ADR) needs the file bytes on disk; a reference-only path would require re-downloading at transcription time and again at any future analysis step.

The cost is storage: the FUSE bucket already holds transcripts + description backups; adding video binaries roughly ~100 MB per hour of 720p H.264 makes it materially larger. That is the price of durability and we accept it (see §Consequences).

---

## Decision

### 1. Two ingest paths, one code shape

Add a `google-drive` platform to `URLImport`'s detection (contributor self-service path) and a new `DriveImport` panel on `/import` (publisher-triggered path). Both write to the same `POST /api/drive/ingest` endpoint with different auth modes.

#### Detection (`URLImport.tsx`)

```ts
// google.com/file/d/<id>  (shared file)
// google.com/open?id=<id>  (legacy link)
// drive.google.com/uc?id=<id>&export=download  (direct-media)
// docs.google.com/…/d/<id>  (a Google-hosted asset — rejected, we want video files only)
m = s.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{25,})/i);
m ||= s.match(/drive\.google\.com\/(?:open|uc)\?[^"']*id=([a-zA-Z0-9_-]{25,})/i);
if (m) return { raw: s, platform: "google-drive", id: m[1] };
```

The regex intentionally rejects `docs.google.com/document/…` and `docs.google.com/spreadsheets/…` (Google-native docs are not videos and would fail the mimeType guard downstream) — that keeps failure modes fast and legible in the URL-import previews.

#### Contributor path — public share resolution

`URLImport.fetchAll()` calls `POST /api/drive/metadata` with the file ID. Server-side:

1. `GET https://www.googleapis.com/drive/v3/files/<id>?fields=name,mimeType,size,videoMediaMetadata,createdTime,modifiedTime,thumbnailLink,webViewLink&supportsAllDrives=true` **without** an access token. Drive's v3 API answers un-authenticated only when the file's sharing scope is "anyone with the link". A `404`/`403` here signals a private file; we return `{ requires_auth: true }` to the client, which surfaces a "This file needs a curator to pull it (private)" hint and stashes the link in a pending-curator queue (see §2).
2. On success, return the metadata. `URLImport` displays a preview like every other source — title = `file.name`, duration = `videoMediaMetadata.durationMillis / 1000`, thumbnail via a signed `thumbnailLink` (or Drive's built-in `thumbnailLink` if the file is public).
3. mimeType guard: reject anything that doesn't start with `video/` (blocks Google-native docs, images, PDFs pasted by accident). The contributor sees "That link points to a `application/pdf` file, not a video."

#### Publisher path — authenticated Drive OAuth

New `web/src/components/DriveImport.tsx` panel on `/import` (Publisher+ only, same gate as YouTube-Live). Two entry modes:

- **Curator queue**: rows from §2 that contributors submitted but couldn't publicly resolve; one-click "Ingest".
- **Ad-hoc Drive picker / paste**: publisher pastes a link OR uses the Google Picker JS SDK (loaded from `apis.google.com/js/api.js` per RFC — see §Security) to browse the org account's Drive.

Both feed the same server endpoint (`POST /api/drive/ingest`), which uses the operator's IAP-derived Google identity to acquire a Drive OAuth token from the ADR-042 credential vault, then calls `files.get` with the token to fetch metadata + `files.get?alt=media` to stream bytes.

Access-scope hardening: the OAuth scope requested is `https://www.googleapis.com/auth/drive.readonly`, not full `drive`. The service account never writes to Drive; only reads.

### 2. Pending-curator queue (contributor → publisher handoff)

Records submitted by a contributor with a private Drive link — where `POST /api/drive/metadata` returned `{ requires_auth: true }` — are created at status `Discovered` with `metadata_extra.drive_pending_curator = "1"` and `metadata_extra.drive_file_id = <id>`. They appear in a new "Drive pending pull" card on `/maintain` (Publisher+ only). One click on the "Pull" button re-invokes the ingest path with the publisher's OAuth token.

This keeps the contributor's submission in the catalog immediately (so they see it in "Your contributions" on `/contribute`) without pretending we have the file yet. The record's status stays `Discovered` until the publisher actions the pull; on success it advances to `InScope` and the pending flag clears.

### 3. File copy to FUSE bucket

`POST /api/drive/ingest` streams `files.get?alt=media` directly to `gs://video-sync-data-agentics-487016/videos/<record-id>.<ext>` via the FUSE mount. Streaming (not buffering in Node memory) is essential — a 4 GB screen recording would OOM the Cloud Run container otherwise.

- **Filename**: `<record-id>.<ext>` where `<ext>` is derived from Drive's `name` (`.mp4`, `.mov`, `.webm`, `.mkv`). If the name has no extension, fall back to `.mp4` (Drive's most common video mimeType is `video/mp4`).
- **Concurrency**: one ingest at a time per record; a second POST to the same `record_id` returns `409 Conflict`. The client re-queries `/api/drive/status?record_id=<id>` for progress (percent copied, bytes total).
- **Timeout / resumption**: Cloud Run's request timeout is 60 minutes (default). Files that stream longer than that fail; the client sees a persistent error and can retry (idempotent — the partial file gets truncated on the retry). Files >10 GB should probably be split by the contributor; we don't attempt chunked / resumable ingest in this ADR (deferred).
- **Bucket versioning**: the bucket already has GCS Object Versioning enabled (ADR-042 §5). Overwriting `<record-id>.mp4` on a re-pull retains the old version — cheap safety-net against a bad re-pull.

The `WasmVideoRecord` gets:

- `source_id: drive-<file-id>` — namespaced away from other Drive-touching sources (show-notes docs use a different prefix).
- `source_platform: "GoogleDrive"` — new enum value on the Rust side.
- `download_url: gs://video-sync-data-agentics-487016/videos/<record-id>.<ext>` — the FUSE path, which the existing playback surface (video card modal) knows how to sign into a `https://storage.googleapis.com/...` signed URL for viewing.
- `metadata_extra.drive_file_id`, `metadata_extra.drive_web_view_link` (Drive's UI link, for provenance), `metadata_extra.contributor_submitted: "1"` (when applicable), `metadata_extra.drive_original_owner_email` (from `files.get?fields=owners`, best-effort — helps a curator disambiguate identical filenames).
- `recorded_at: file.createdTime` from Drive (falls back to `modifiedTime` if unset).

### 4. Transcript resolution

No Drive-native transcript exists — Drive is just file storage. Three resolution paths on ingest, tried in order:

1. **Contributor-provided VTT/text** — `/contribute` gains an optional "Transcript (paste)" field that stashes the text alongside the URL submission. If present, it lands on the record via `videoStore.setTranscript(record.id(), text)` at ingest time, same as Loom's auto-transcript flow.
2. **ADR-053 borrowed transcript** — the ingested record's title + `recorded_at` are matched against sibling catalog records; a paired Zoom / Fireflies transcript can source-of-truth the audio.
3. **Deferred: Whisper transcription** — because the file bytes are now on FUSE (§3), a background job could run Whisper. Out of scope for this ADR; a follow-up ADR is intended to cover local-transcription cost, provenance, and prompt semantics.

### 5. UI surfaces

- **`/contribute`**: URL box already accepts YouTube / Loom / Zoom-share (ADR-065, 8b46826). Adds Drive links. "Other sources" disclosure copy updates: Drive links now work self-service for public files; private files "route to a curator queue and get pulled on approval — you'll see the status transition in Your contributions."
- **`/contribute`**: new optional "Transcript (paste)" collapsed disclosure — useful for Drive files where no automatic transcript source exists. Applies to every submission, not Drive-only, since Zoom-share contributors face the same gap.
- **`/import` → new "Drive" tab**: Publisher/Admin only. Ad-hoc pull for org-scoped files.
- **`/maintain` → new "Drive pending pull" card**: Publisher/Admin only. Shows contributor-submitted rows whose file needs authenticated resolution.
- **Video-card provenance**: adds a Drive location row (`platform: GoogleDrive`, `link: <webViewLink>`). Same shape as YouTube/Loom entries so existing provenance-graph rendering handles it.

### 6. Rate limiting & quota

Drive API v3 shares the org's overall Workspace quota (10,000 QPS for `files.get`, effectively unbounded for our use). The bottleneck is bandwidth into Cloud Run + write bandwidth to the FUSE bucket. We rate-limit ingests to **2 concurrent** per Cloud Run instance to avoid contending with the show-notes / description-sync write paths already using FUSE. The queue is client-side; the server returns `429` if a third ingest starts.

---

## Consequences

### Positive

- Contributors get first-class Drive support instead of the Discord hand-off — matches the ADR-065 promise. Their submission lands in the catalog immediately, even for private files, with a legible pending-curator status.
- Publishers can pull org-scoped Drive files without leaving the app. The org's existing OAuth (ADR-042) covers auth; no new credential vault needed.
- File bytes are durable in the FUSE bucket — a contributor deleting the Drive original or revoking the share does not break the catalog.
- Enables downstream: local Whisper transcription, waveform preview, per-record thumbnails without Drive's own thumbnail service. All deferred but unblocked.
- Drive-native metadata (`createdTime`, `owners`, `videoMediaMetadata.durationMillis`) preserves provenance the Discord workflow was discarding.

### Negative

- **Storage cost.** A 720p H.264 hour is roughly 100–300 MB; a chapter uploading a monthly 2-hour meetup adds ~500 MB/month. At scale (say, 30 chapters, 12 months) that's ~180 GB/year — non-trivial for a shared bucket but well within GCS Nearline pricing (~$10/mo per TB). Callout: this ADR does NOT commit to a retention policy; a follow-up ADR should decide when video binaries can be tiered to Coldline or deleted.
- **Cloud Run ingest window is 60 minutes.** Files that exceed that timeout require the contributor to split-and-reupload, or the publisher to re-run. Chunked / resumable ingest is deferred.
- **Drive scope creep.** `drive.readonly` grants read to *any* file the org's OAuth identity can see, not just the file being pulled. We narrow the surface by requiring the operator to paste (or Picker-select) an explicit file ID; the ingest endpoint refuses to enumerate. The scope grant is still broader than "just this file" — Google's API doesn't offer a per-file scope. This is the same posture as ADR-042's show-notes doc write and is accepted for the same reason.
- **`mimeType` guard rejects Google-native docs.** If a contributor thinks they're pasting a video and are actually pasting a Google Doc, they get a legible error but the frustration is real. We accept this — the alternative (attempting a `files.export?mimeType=video/mp4`) would silently succeed with nonsense output.
- **Contributor's transcript-paste field is trust-based.** A contributor can paste a transcript that doesn't match the video (garbage or malicious content). Provenance marks it `source: "contributor-provided"` so any downstream operator can see where it came from; auditing is out of scope.

### Neutral

- The `GoogleDrive` platform is a fifth first-class source alongside `YouTube`, `Loom`, `Zoom`, `Fireflies`. The Rust `SourcePlatform` enum grows by one variant; every match statement over sources gets the new arm.
- Provenance-graph rendering already tolerates unknown platforms (falls back to a generic node); no work needed there beyond the enum extension.

---

## Deferred / Follow-ups

1. **Local Whisper transcription on file bytes** — separate ADR. Covers cost per minute, model choice (whisper-large-v3 vs distil-whisper), provenance markers, editability, and how to reconcile with a Fireflies-paired transcript.
2. **Storage retention policy for `videos/<record-id>.<ext>`** — when can a binary be tiered to Coldline? Deleted? Restored on demand? Separate ADR.
3. **Chunked / resumable ingest for files > 60 min ingest window** — Google's Resumable Uploads pattern applied in reverse (resumable *downloads*). Only worth building if a real file exceeds the timeout.
4. **Google Picker JS SDK integration on the Drive tab** — nice-to-have; paste-a-link works fine for MVP.
5. **`SourcePlatform::GoogleDrive` in the WASM enum** — Rust change alongside the TS/API work.
6. **Contributor-provided transcript field on `/contribute`** — decoupled from Drive but sequenced with this work since Drive is the source most likely to arrive without a machine transcript.
7. **Drive-video thumbnail** — Drive's own `thumbnailLink` is short-lived. On ingest, extract a poster frame via `ffmpeg` on the copied file and store under `thumbnails/<record-id>.jpg`. Not blocking for MVP; falls back to the mime-type icon.

---

## Open questions

- Should the "Drive pending pull" curator queue emit a Discord notification, or is /maintain visibility enough? (Leaning: /maintain badge count for MVP; Discord ping can be added later.)
- Do we accept Google Drive Shared Drives (`supportsAllDrives=true`) or restrict to My Drive? Shared Drives are cleaner for org content but require the operator's OAuth to be a Shared Drive member. Leaning: accept, since the flag adds it for free.
- Should the ingest also record a hash (`md5Checksum` from Drive) so a re-pull of the same file bytes is a no-op? Marginal, but cheap.
