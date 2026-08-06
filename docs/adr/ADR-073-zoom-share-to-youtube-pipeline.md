# ADR-073: Zoom-Share → YouTube Publication Pipeline

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-08-06 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-016 (retrospective backfill uploader), ADR-046 (show notes), ADR-053 (transcript provenance), ADR-064 (description strategy), ADR-065 (contributor role), ADR-067 (show notes → description), ADR-068 (bulk description sync), ADR-071 (Drive ingest), ADR-072 (Zoom-share transcript fallback ladder) |

---

## Context

A contributor pastes a Zoom recording share URL (`zoom.us/rec/share/<blob>`) on `/contribute`. Today the record lands as a placeholder — no title, no duration, no thumbnail, no transcript, and no video bytes. ADR-072 defined the transcript fallback ladder; this ADR defines what comes after — how the record gets from `Discovered` all the way to `Published` on the Agentics Foundation YouTube channel.

The pipeline breaks into four stages, and each has a decision point about where the human intervenes:

1. **Ingest** — contributor submits the URL. Record created at `Discovered`, tagged with `contributor_email` and `contributor_chapter` per ADR-065. *(Already shipped.)*
2. **Enrich video bytes** — the MP4 needs to reach a form YouTube's `videos.insert` API can consume. The Zoom share URL itself is not directly ingestible (see §Video bytes below).
3. **Author** — transcript (ADR-072 ladder), Show Notes (ADR-046), description (ADR-067). All three already exist as isolated primitives; this stage sequences them.
4. **Publish** — YouTube upload via `videos.insert`, provenance links (Zoom share as Origin, YouTube video as Destination), record advances to `Publishing → Published`, description sync (ADR-068).

Nothing about stages 3–4 is Zoom-specific. What's new is stage 2 (video bytes) and the sequencing that ties them together for this source in particular. Meetup and chapter-organiser Zoom recordings are the most-requested contributor path (they're already the highest-volume contributor source per the /contribute logs since ADR-065 landed) so making this a one-click curator flow matters.

### Video bytes

Getting the MP4 is the crux. Four options considered:

**A. Contributor uploads to Drive, we ingest via ADR-071.** Contributor clicks Zoom's own "Download" button on the share page (this exists in Zoom's UI regardless of who owns the meeting — the sharer chose to make it downloadable when they generated the share), uploads the MP4 to any Google Drive (personal, chapter, or org Shared Drive), pastes the Drive link. We use ADR-071's Drive ingest to stream the bytes to `data/videos/<record-id>.mp4` on the FUSE mount. Then upload to YouTube from FUSE. Effort: **zero new code** — every piece already exists. Contributor friction: one extra step (download → upload).

**B. Playwright headless scrape of the signed player URL.** Cloud Run container renders the Zoom share page, waits for the video XHR, downloads the direct-media URL, writes to FUSE. Effort: ~1–2 engineering days plus a ~200 MB Chromium container. Brittle to Zoom UI revisions. Zoom ToS ambiguity (same posture as ADR-072 §Deferred).

**C. Curator downloads locally and re-uploads via /import.** Manual path — curator clicks Zoom's Download button themselves, uploads via the existing YouTube Upload panel or by adding a Drive link. Effort: zero code; friction on the curator side scales linearly with contribution volume.

**D. Ask the contributor to share the Drive link directly, skip the Zoom share entirely.** Update `/contribute` copy: "if this is a Zoom recording, download it first and paste the Drive link instead". Effort: docs-only. But wastes the Zoom share URL's *provenance* value (the share is a durable link back to the source) and asks the contributor to make a decision they may not have context for.

**Choice: A + C as the two blessed paths.** A is the self-service default. C is the escalation path for contributors who can't or won't upload to Drive (e.g. large files, slow connections). B stays deferred with the same trigger conditions as ADR-072 §Deferred (≥ 10 blocked records/month sustained + ToS review). D is rejected — the Zoom share URL is a first-class provenance record and shouldn't be discarded to save one workflow step.

The key insight: **the Zoom share record and the Drive/upload record are the same catalog row, not two different rows.** Contributor submits Zoom share → placeholder record created → curator (or contributor) adds a Drive link → we ingest bytes → we upload to YouTube. The record's provenance graph carries both: Zoom share as Origin (URL preserved from ADR-065 ingest), Drive as Intermediate (transient, may or may not be preserved), YouTube as Destination.

---

## Decision

### 1. The four-stage state machine

Each stage has an explicit trigger and a small set of possible next states. Records don't skip stages; the operator can back out (Skip/Abandon) at any time.

```
[Ingest]      → Discovered
              ↓ (contributor or curator adds Drive/upload path)
[Enrich]      → Discovered (still) + drive_ingest_pending / drive_ingest_complete
              ↓ (transcript arrives via ADR-072 ladder; curator triggers Show Notes)
[Author]      → InScope (once transcript + show notes + description all present)
              ↓ (Publisher clicks Publish to YouTube)
[Publishing]  → Publishing
              ↓ (videos.insert succeeds; ADR-068 description push)
[Publish]     → Published
```

Status guards: a record can't move to `Publishing` unless `metadata_extra.drive_ingest_state === "complete"`, `transcript_text` is non-empty, and both `summary_doc_id` (Show Notes) and a non-empty `description` are present. Server-side check on `POST /api/youtube/upload` returns 412 Precondition Failed with a legible list of what's missing.

### 2. Per-record "Ready to publish?" checklist

New card on the video card that lists the four gates:

- ☐ / ☑ Video bytes on FUSE (`drive_ingest_state === "complete"`)
- ☐ / ☑ Transcript (any rung of ADR-072 ladder — inline resolves)
- ☐ / ☑ Show Notes generated (`summary_doc_id` set)
- ☐ / ☑ Description authored (`description` non-empty)

The checklist replaces the current Publish button on Zoom-share cards. When all four are ✅, the button unlocks. Each unchecked row deep-links to the corresponding action:

- Video bytes → "Paste Drive link" affordance (see §3) or /maintain Drive-pending-pull card if the contributor already submitted a Drive link (ADR-071 §2)
- Transcript → the video card's existing transcript-edit affordance (ADR-072 rung 3)
- Show Notes → "Generate Show Notes" button (uses transcript, ADR-046)
- Description → "Copy from Show Notes" or "Rewrite via LLM" button (ADR-067)

### 3. Drive-link paste on the Zoom-share card

A Publisher can paste a Google Drive URL directly on a Zoom-share record. The card:

- Detects `drive.google.com/file/d/<id>` in a small input under the checklist
- Calls `/api/drive/metadata` (ADR-071), then `/api/drive/ingest` with `auth=service_account`
- Adds a Drive location (Intermediate role) to the record's provenance graph
- Polls `/api/drive/status` and updates the checklist row on completion

This turns the ADR-071 §2 curator-queue flow into a per-card affordance for Zoom-shares specifically, which is where it's most needed. It doesn't replace the /maintain queue — that stays for the contributor-submitted-a-private-Drive-file case.

### 4. Publish action

The Publish button, when unlocked by §2, performs the following in order:

1. `POST /api/youtube/upload` — streams `data/videos/<record-id>.<ext>` to `videos.insert` with title, description, thumbnail (poster from Drive or ffmpeg-extracted if we ship ADR-071 §Follow-up #7). Server enforces the §1 status guard.
2. On success: creates a YouTube Destination location on the record (external_id = uploaded video ID); the existing publish-transition path advances status to `Publishing` → `Published`.
3. ADR-068's bulk-description-sync path is redundant for a fresh upload (we just wrote the description in step 1). But the same backup mechanism captures the initial YouTube snippet for future undo.

Failure modes: video-too-long (YouTube's per-account limits), quota exhausted (10,000 units/day default), or `videos.insert` rejecting the file for policy reasons. Each surfaces as a legible event log entry; record stays at `InScope`; retry is idempotent (uses the same record_id → deterministic filename on FUSE → same source content on re-upload).

### 5. Attribution + rights

Two additions to the description-generation flow (ADR-067) when a record has `contributor_email`:

- **Credit line at the top**: `Recorded and submitted by <contributor_display_name> · Agentics <contributor_chapter>.` — configurable in the ADR-067 prompt config.
- **Rights confirmation gate**: the Publish button surfaces a one-time confirmation dialog (`ConfirmDialog` from ADR-069) with the text: *"By publishing this recording, you confirm the Agentics Foundation has permission from the meeting host and all identifiable participants to make this recording public on the Agentics YouTube channel."* Accepted state persists in `metadata_extra.rights_confirmed_at`. The dialog does not fire on records with `source_platform ∈ { YouTube, Loom }` (already-public sources) — only on Zoom-share and Drive imports.

Rights confirmation is a legal posture question, not a technical guarantee. We record the click; the org's Publisher accepted the responsibility. Escalation (e.g. a takedown request from an unrecognised participant) is out of scope — handle via YouTube's own tooling.

### 6. Curator-visible pipeline card on /maintain

New card: **📤 Zoom shares ready to publish**. Shows every Zoom-share record whose checklist is complete but hasn't been published yet. Bulk-publish action is *not* included (each record has non-trivial per-record decisions — description tweaks, thumbnail choice, whether the participants really are all consenting) — the card is a *queue*, not a bulk action.

---

## Consequences

### Positive

- Contributor Zoom shares become fully first-class alongside YouTube / Loom / Drive imports, closing the ADR-065 promise.
- Every step of the pipeline is already-shipped work re-composed for this source; the new code is small (checklist UI + Publish button unlock + per-card Drive paste).
- The rights-confirmation gate makes the org's legal posture explicit and clickthrough-auditable, which is the substantive thing a legal review would ask for.
- The pipeline as defined generalises: swapping the Zoom-share detection for Loom / YouTube-broadcast source records would drive the same pipeline for those flows, if we later want a unified "prepare + publish" workflow.
- Publisher gets a legible readiness view instead of hunting through the card for the one missing field.

### Negative

- The state machine grows a de facto pre-`InScope` "ready" state that the WASM record's status enum doesn't have — we encode it in `metadata_extra.drive_ingest_state` + presence of transcript / show notes / description. That's fine for now (matches the ADR-071 pattern) but suggests eventually adding a formal `ReadyToPublish` status.
- The checklist replaces the current Publish button on Zoom-share cards specifically; the disparity ("YouTube cards have a plain Publish, Zoom-share cards have a checklist") is a discoverability wobble. We accept it because the Zoom-share workflow is genuinely different.
- Contributor path A (upload to Drive) still costs a download-and-reupload step the contributor may resist. Curators may end up doing this manually more often than the design assumes.
- Rights confirmation is a one-time boolean. Some publications warrant more scrutiny than a single dialog — the design deliberately doesn't gate hardest against that, on the theory that Publisher role is already the gate.

### Neutral

- YouTube upload path (`/api/youtube/upload`) already exists for ADR-016 backfill. This ADR extends the callers of that endpoint, doesn't build a new upload path.
- Provenance graph populates naturally — Origin = Zoom share, Intermediate = Drive (if used), Destination = YouTube — no schema change beyond what ADR-005 already supports.

---

## Deferred / Follow-ups

1. **Playwright-based Zoom-share MP4 extraction** — same trigger conditions as ADR-072 §Deferred. If self-service Drive-transfer proves too high friction, this earns the ADR.
2. **ffmpeg poster-frame extraction** — ADR-071 §Follow-up #7 dependency; would eliminate the manual "pick a YouTube thumbnail" step. Not blocking.
3. **`ReadyToPublish` status in the WASM enum** — formalises the four-gate pre-condition instead of hanging it off `metadata_extra`. Non-urgent until we want to make the state visible cross-record (e.g. filter the catalog by it).
4. **Rights-confirmation escalation** — a two-input confirmation (name + role check) instead of a single Yes button, for recordings flagged high-scrutiny. Deferred until we have an incident.
5. **Bulk publish action on /maintain "ready to publish"** — deferred by design; revisit only if per-record scrutiny proves excessive at scale.
6. **Contributor-visible pipeline status on /contribute** — currently the contributor only sees the record's `status` field. Surfacing the four-gate checklist to the contributor themselves would let them see where their submission is stuck. Nice-to-have.

---

## Open questions

- Should the rights-confirmation gate re-fire when the description is materially re-edited after acceptance? (Leaning: **no** — Publisher accepted the record as such; re-edits within the same session don't need a new dialog.)
- When both the contributor's Drive upload (§3) AND ADR-071's contributor-pending-pull queue could apply, which wins? (Leaning: the per-card paste (§3) wins for Zoom-shares because the record already exists; the /maintain queue is for "record was created via /contribute with a private Drive link".)
- Does the credit line (§5) belong in the description or in the YouTube video's title? Description keeps the title clean for search; title makes credit undismissable. (Leaning: **description**.)
