# Video Bridge: User Flows

This document describes the primary user flows through the application, end to end.

---

## Flow 1: First-Time Setup

```
User opens Video Bridge
  |
  v
Dashboard loads (WASM boots)
  |
  v
Click "Connections" tab
  |
  +---> Enter Zoom credentials (Account ID, Client ID, Client Secret)
  |       |
  |       v
  |     Click "Save" --> per-operator override saved to localStorage,
  |     OR Admin clicks "Save as shared default" --> written to Google
  |     Secret Manager so every operator inherits it (ADR-042).
  |
  +---> Enter YouTube credentials (Client ID, Client Secret)
  |       |
  |       v
  |     Click "Authorize"
  |       |
  |       v
  |     Redirect to Google OAuth consent screen
  |       |
  |       v
  |     User grants youtube.upload + youtube.readonly scope
  |       |
  |       v
  |     Redirect back to /youtube-callback
  |       |
  |       v
  |     Refresh token stored in localStorage
  |       |
  |       v
  |     Channel name displayed on Connections card
  |
  +---> (Optional) Enter Fireflies API Key, OpenRouter API Key,
  |     OpusClip API Key. Kaltura is shared-only (Admin sets it via
  |     Secret Manager). Loom needs no credentials — manual URL import.
  |
  v
Setup complete --> return to Dashboard
```

**Outcome:** Platform connections saved. Ready to import.

---

## Flow 2: Import Zoom Recordings

```
Click "Import" tab --> "Zoom" sub-tab
  |
  v
Select date range (e.g. last 90 days)
  |
  v
(Optional) Set filters: title contains "Standup", min duration 15 min
  |
  v
Click "Fetch Recordings"
  |
  v
POST /api/zoom/recordings
  |--> Exchange credentials for Zoom access token
  |--> Paginate through /v2/users/me/recordings
  |--> Return meeting list to client
  |
  v
Display list: title, date, duration, participants for each
  |
  v
User checks desired recordings
  |
  v
Click "Import Selected"
  |
  v
For each selected meeting:
  |--> Create WasmVideoRecord via WASM index() command
  |--> VideoIndexed event emitted
  |--> Record added to in-memory store
  |--> Persisted to data/catalog.json on the FUSE-mounted GCS bucket
  |    (ADR-035 L2); localStorage holds a fast-boot cache + offline fallback
  |
  v
Videos appear on Dashboard as "Discovered"
  |
  v
Event Log: "Imported 23 recordings from Zoom"
```

**Outcome:** Zoom recordings indexed in the catalog.

---

## Flow 3: Rules-Based Triage

```
Click "Rules" tab
  |
  v
Click "Add Rule"
  |
  v
Configure rule:
  - Title contains: "Weekly Sync"
  - Day of week: Monday, Wednesday, Friday
  - Duration: 20-90 minutes
  - Action: Mark In Scope
  - Priority: 1
  |
  v
Click "Save Rule"
  |
  v
Rule POSTed to /api/rules → data/rules.json on FUSE bucket (server-authoritative
per ADR-031); localStorage holds a cache that re-hydrates on boot.
  |
  v
Automatic runner evaluates every 60 seconds
  (or click "Run Now" for immediate evaluation)
  |
  v
For each Discovered video:
  |--> Check against rules in priority order
  |--> First matching rule's action is applied
  |--> WASM mark_in_scope() / approve() / skip() command
  |--> Status transition event emitted
  |
  v
Dashboard updates: "42 videos moved to InScope"
  |
  v
Runner status shows: last run timestamp, 42 matches
```

**Outcome:** Bulk triage without manual review of every video.

---

## Flow 4: Review and Approve

```
Dashboard filtered to "InScope"
  |
  v
Review video cards:
  |
  +---> Card shows title, duration, source, recording date
  |
  +---> Expand card for full details:
  |       - Description, participants, tags
  |       - Transcript (click "Fetch Transcript" if not loaded)
  |       - Notes from team members
  |
  +---> Decision per video:
          |
          +---> Click "Approve" --> status: Approved
          |
          +---> Click "Skip" --> status: Skipped
          |
          +---> Click "Exclude" --> status: Abandoned
          |       (added to exclusion list, won't be re-imported)
          |
          +---> Edit metadata before approving:
                  - Change title, description, tags
                  - Add notes
  |
  v
(Or) Click "Bulk Approve All InScope" on Dashboard header
  |
  v
All InScope videos --> Approved
  |
  v
Event Log: "Bulk approved 42 InScope videos"
```

**Outcome:** Videos vetted and ready for publication.

---

## Flow 5: Publish to YouTube

```
On an Approved video card, click "Publish"
  |
  v
(Optional) Edit title, description, tags in the publish dialog
  |
  v
Click "Confirm Publish"
  |
  v
Status transitions: Approved --> Publishing
  |
  v
Client sends POST /api/youtube/upload with:
  - Video source URL (Zoom download link, Loom URL, etc.)
  - YouTube credentials (refresh token from localStorage — YouTube is
    per-operator only by design, ADR-042 §"YouTube brand account")
  - Metadata (title, description, tags, privacy)
  |
  v
Server-side pipeline:
  |--> Refresh YouTube access token
  |--> Stream download from source platform
  |--> Initiate YouTube resumable upload
  |--> Upload in chunks (progress via SSE to client)
  |--> On success: return YouTube video ID + URL
  |
  v
Client receives success:
  |--> WASM mark_published(youtube_id, youtube_url)
  |--> VideoPublished event emitted
  |--> Status: Published
  |--> YouTube URL displayed on card
  |
  v
Post-processing rules fire:
  |--> Webhook: POST to configured URL with video metadata
  |--> Email: Send notification via Gmail
  |
  v
(If failure):
  |--> WASM mark_failed(error_message)
  |--> Status: Failed
  |--> Error displayed on card and in Event Log
  |--> Operator can click "Retry" --> ToRetry --> Publishing
```

**Outcome:** Video live on YouTube with provenance metadata.

---

## Flow 6: Backfill Large Libraries

```
Click "Backfill" tab
  |
  v
Click "Add Profile"
  |
  v
Configure profile:
  - Date range: 2024-01-01 to 2025-12-31
  - Source: Zoom
  - Duration: 20+ minutes
  - Day of week: weekdays only
  - Daily quota: 6 uploads/day
  - Time window: 08:00-18:00 UTC
  |
  v
Click "Save Profile"
  |
  v
Click "Populate Queue"
  |
  v
Queue fills with Approved videos matching profile criteria
  |
  v
Review queue: drag to reorder, remove unwanted items
  |
  v
Click "Start Orchestrator"
  |
  v
Orchestrator loop (server-side tick every 30s):
  |
  +--> Check: uploads_today < daily_quota?
  |      |
  |      No --> pause, log "quota exhausted, resuming tomorrow"
  |      |
  |      Yes --> continue
  |
  +--> Check: current time within time_window?
  |      |
  |      No --> pause, log "outside upload window"
  |      |
  |      Yes --> continue
  |
  +--> Pick next video from queue
  |      |
  |      v
  |    Execute publish flow (same as Flow 5)
  |      |
  |      v
  |    On success: increment uploads_today, remove from queue
  |    On failure: mark Failed, log error, continue to next
  |
  +--> Repeat until queue empty or quota/window exhausted
  |
  v
Dashboard shows progress:
  - Uploads today: 4/6
  - Queue remaining: 127
  - Estimated completion: ~21 days
```

**Outcome:** Systematic publication of a large library, quota-aware.

---

## Flow 7: Generate and Publish Shorts

```
On a Published video card, click "Generate Shorts"
  |
  v
POST /api/shorts/generate with YouTube URL
  |
  v
Server calls Opus Clip API:
  |--> Submit video for analysis
  |--> Poll job status until complete
  |--> Return ranked clip list with virality scores
  |
  v
Clips indexed as new VideoRecords:
  - source_platform: "OpusClip"
  - status: Discovered
  - upstream_link: ClipOf(parent_video_id)
  |
  v
Go to "Shorts" tab
  |
  v
Filter: Pending clips
  |
  v
For each clip:
  |--> Preview content
  |--> See virality score
  |--> Edit title if desired
  |--> Click "Approve" or "Reject"
  |
  v
Approved clips are published to YouTube:
  - Title: "Original Title #Shorts"
  - Description: includes link to parent video
  - Privacy: same as parent
  |
  v
Clip status --> Published
Provenance graph updated: Parent --> ClipOf --> Short
```

**Outcome:** Short-form clips on YouTube driving discovery of full videos.

---

## Flow 8: Track Provenance

```
Record a webinar on Zoom
  |
  v
Import to Video Bridge (Flow 2) --> Origin location: Zoom
  |
  v
Fireflies auto-transcribes the meeting
  |
  v
Import Fireflies transcript (Fireflies Import)
  |
  v
Link upstream: "TranscribedFrom" the Zoom recording
  |
  v
Edit the recording in Loom (add intro, captions)
  |
  v
Import Loom URL via URL Import
  |
  v
Add Location: platform=Loom, role=Intermediate, ordinal=1
  |
  v
Publish to YouTube (Flow 5) --> Destination location: YouTube
  |
  v
Generate Shorts (Flow 7) --> Clip locations: YouTube Shorts
  |
  v
Switch to "Provenance" view on Dashboard
  |
  v
Graph displays:

  [Zoom Recording] --TranscribedFrom--> [Fireflies Transcript]
        |
        +--SameEvent--> [Loom Edit]
                            |
                            +---> [YouTube Full Video]
                                        |
                                        +--ClipOf--> [YouTube Short 1]
                                        +--ClipOf--> [YouTube Short 2]
```

**Outcome:** Complete chain of custody visible at a glance.

---

## Flow 9: Monitor System Health

```
Dashboard loads
  |
  v
useMemoryHealth hook starts polling /api/health every 30s
  |
  v
Server responds with:
  - Memory snapshot: rss_mb, heap_used_mb, limit_mb, ratio, level
  - Recent alerts (if any)
  |
  v
If alerts exist:
  |--> Injected into client-side structured log
  |--> Visible in Event Log (Structured View)
  |--> "runtime:memory — memory pressure" (warn) or "memory critical" (error)
  |
  v
In parallel: EventLog polls /api/audit/recent every 8s (ADR-041)
  |--> Returns the most recent ~50 audit entries server-side
  |--> Each entry: { actor_email, route, method, classification, rid, status, latency_ms, ts }
  |--> classification: "access" (read) or "mutation" (write)
  |--> Merged into the in-app structured log so any operator's activity
       is visible to all logged-in operators in near-real-time
  |
  v
Event Log also shows:
  - API request/response logs with correlation IDs
  - Import activity
  - Upload progress and completion
  - Rule engine matches
  - Post-processing webhook/email results
  - Audit entries from /api/audit/recent (cross-operator visibility)
  |
  v
Click "Download .jsonl" to export full log for support
```

**Outcome:** Operator has full visibility into system behavior.

---

## Flow 10: Recover a Failed or Orphaned Video from YouTube

Covers two related cases:
- An upload finished on the server side but the SSE progress stream dropped before the browser saw the completion event → record is stuck in Failed.
- A video was uploaded to YouTube out-of-band (YouTube Studio, external tool) and should be linked back to its catalog entry.

```
Expand the Failed (or Discovered/InScope/Approved) card
  |
  v
  +--> Banner already visible? ("Possible YouTube match: ...")
  |      |
  |      v
  |    Click "Link & mark Published" → jump to the verify step below
  |
  +--> No banner: click "Recover from YouTube"
         |
         v
       Recover panel opens. Two entry points:
         |
         +--> Click "Auto-lookup on YouTube"
         |      |
         |      v
         |    fetchChannelUploads() hits /api/youtube/channel-uploads
         |    (cached for 1 hour; ~40 quota units for a 1000-video channel)
         |      |
         |      v
         |    rankCandidates scores title + date proximity
         |      |
         |      v
         |    Top 5 matches shown with % score and ✓ for ≤31 day date
         |      |
         |      v
         |    Click "Use this" on the right candidate
         |
         +--> OR paste watch URL / Studio URL / short URL / 11-char ID
                |
                v
              Click "Recover"
  |
  v
  (verify step)
  POST /api/youtube/status?videoId=<id>
  |
  +--> 404 → abort with error, record untouched
  |
  +--> 200 → cache privacy, proceed
          |
          v
        Chain WASM transitions to Published:
          - if status not Approved/Publishing/Published: approve()
          - if status now Approved: request_publish()
          - mark_published(destination_id, destination_url, platform=YouTube)
          |
          v
        mark_published idempotently adds the Destination location
          |
          v
        Emit VideoRecovered event, refresh card
          |
          v
        Card → Published with privacy-coloured YouTube badge
```

**Outcome:** Record state matches reality — YouTube has the video, Video Bridge records it as Published, privacy is visible.

---

## Flow 11: Link Same-Event Siblings (cross-source dedupe)

When Zoom and Fireflies both captured the same meeting, the records arrive as two separate cards. Linking them makes the provenance graph accurate and (in future) enables cross-record metadata enrichment.

```
Card appears with purple banner:
  "Possibly same event: Fireflies: AI Hackerspace Live · 2026-03-20 · 72% match"
  |
  v
Click the "view" link to scroll to the sibling card (optional sanity check)
  |
  v
Back on the current card, click "Link as same event"
  |
  v
WASM command: link_upstream(
    platform=<sibling source>,
    external_id=<sibling source_id>,
    relation=SameEvent,
    linked_by=Auto-suggestion,
)
  |
  v
UpstreamLink appears on this record
  |
  v
Banner disappears (the pair is now linked)
```

**Scoring:** 0.4 × participant-email Jaccard + 0.3 × recording-start proximity + 0.3 × title token overlap. Duration deliberately not used — Zoom records early, Fireflies joins late.

**To dismiss** a wrong suggestion instead of accepting it: click **Not a match**. The pair is persistently rejected in `localStorage["video-sync:rejected-sibling-matches"]` (symmetric — dismissing A↔B dismisses both directions).

**Outcome:** Same event, multiple captures, one logical group.

---

## Flow 12: Post-Import YouTube Auto-Association

Happens automatically after any source import. Operator sees the result but doesn't have to trigger it.

```
Complete any import (Fireflies, Zoom, URL, YouTube, Manual)
  |
  v
onImported callback in page.tsx → refreshWithYouTube()
  |
  +--> Refresh video state from store
  |
  +--> Fire-and-forget fetchChannelUploads(false):
          - Respects 1-hour cache TTL (warm = 0 API cost)
          - Silent on failure (YouTube might not be configured)
          - Seeds privacy cache for every upload that has privacyStatus
  |
  v
Each VideoCard re-renders with fresh data
  |
  v
VideoCard's autoSuggestion useMemo runs per card:
  - Skip if Published / Publishing / Abandoned
  - Skip if already has YouTube Destination location
  - Skip if match is in rejection store
  - Find top candidate from cached uploads (≥ 0.7 score)
  |
  v
Blue "Possible YouTube match" banner shows on matching cards
  |
  v
Operator sees suggestions, clicks Accept / Not a match / preview as appropriate
```

**Outcome:** For operators with an 18-month backlog already partly on YouTube, one import populates the channel-uploads cache and lights up every auto-associable card at once.

---

## Flow 13a: IAP Sign-In and Role Assignment

Operators reach Video Bridge through Google Cloud IAP — there is no in-app login screen.

```
User opens https://video-sync.agentics.org
  |
  v
IAP intercepts request before it hits Cloud Run
  |
  +--> Not signed in to Google?
  |       |
  |       v
  |     Redirect to accounts.google.com → sign in with Workspace account
  |
  +--> Signed in but no IAP grant?
  |       |
  |       v
  |     403 "You don't have access" (admin must add user/group to
  |     roles/iap.httpsResourceAccessor on the backend service)
  |
  v
IAP forwards the request to Cloud Run with x-goog-iap-jwt-assertion header
  |
  v
Server (web/src/lib/auth.ts) verifies the JWT signature against IAP_AUDIENCE
  and Google's JWK set → extracts { email, sub }
  |
  v
Resolve role via Cloud Identity Groups (memberships:lookup per group):
  - video-sync-admins@agentics.org      → ADMIN
  - video-sync-publishers@agentics.org  → PUBLISHER
  - video-sync-operators@agentics.org   → VIEWER
  |
  v
Role attached to the request context; routes that require ADMIN
(e.g., PUT /api/admin/credentials/*) gate on it.
  |
  v
Every request emits an audit entry (ADR-041) so the actor's email is
recorded against every read/write.
```

**Outcome:** No in-app login UI; auth is enforced at the IAP edge, roles are derived from Workspace groups, every action is attributable.

---

## Flow 13b: Open / Edit a Drive Artifact (transcript, description, summary, chat)

Human-readable artifacts live on a Workspace Shared Drive so operators and content owners can edit them in Google Docs without touching the app (ADR-039).

```
Expand a video card → "Artifacts" section shows links:
  Transcript · Description · Summary · Chat
  |
  v
Click "Transcript"
  |
  v
Client calls GET /api/drive/artifact?recordId=<id>&kind=transcript
  |
  v
Server (Drive lib):
  |--> Look up the artifact entry in catalog.json (Drive file id + folder name)
  |--> Resolve folder name via 24h cache
  |--> Return { driveFileUrl, lastModifiedTime, etag }
  |
  v
Client opens driveFileUrl in a new tab → user edits in Google Docs
  |
  v
On next card expand, server re-fetches lastModifiedTime; the EventLog
shows a "drive:artifact_modified" entry attributing the change to the
actor email (post-processing webhook also fires if configured).
```

For uploads (transcripts arriving from Fireflies/Zoom, descriptions from publishing):
```
Ingestion or publishing pipeline calls Drive lib createOrUpdateArtifact()
  |--> Folder layout: /{Channel}/{YYYY-MM}/{recordId}/{kind}.md
  |--> drive.file scope — only files we created are visible to the app
  |--> File id + lastModifiedTime persisted onto VideoRecord.artifacts
```

**Outcome:** Artifacts are first-class, editable, attributable, and survive Cloud Run cold starts.

---

## Flow 13c: Import from Kaltura / Side-Publish to Kaltura

```
Click "Import" tab → "Kaltura" sub-tab
  |
  v
Select date range
  |
  v
POST /api/kaltura/entries with admin-secret-derived ks (server-side)
  |--> Server pulls Kaltura entries (including live broadcasts streamed
       via OBS / Streamyard / Wirecast) for the window
  |--> Returns list with title, createdAt, duration, downloadUrl
  |
  v
Operator selects entries → "Import Selected"
  |--> Each becomes a VideoRecord with source_platform=Kaltura
  |--> Discovered status; normal triage from here
```

Side-publish (Kaltura as destination alongside YouTube):

```
On an Approved card, click "Publish" → choose destinations
  |
  +--> YouTube (per-operator brand account)
  +--> Kaltura  (org-shared admin secret)
  |
  v
Server publishes serially: YouTube first, then Kaltura
  |--> Kaltura: POST /api/kaltura/upload — uses shared credential from
       Secret Manager (ADR-042) unless operator override is set
  |--> Each destination becomes its own Destination Location on the
       provenance graph
```

**Outcome:** Kaltura is a peer of YouTube — both as source and as destination — without per-operator credential ceremony.

---

## Flow 13: Fill Privacy on the Overview

```
Open Backfill Uploader → Overview tab
  |
  v
Click "Fill privacy" in the header bar
  |
  v
Client collects all YouTube video IDs visible in summaries that
don't have cached privacy
  |
  v
POST /api/youtube/privacy-batch with { videoIds: [...] }
  |
  v
Server batches into chunks of 50, calls videos.list?part=status
(1 quota unit per chunk; ~4 units for 200 videos)
  |
  v
Response: { privacy: { id: status }, missing: [...] }
  |
  v
Client writes each { id, status } to youtubePrivacyCache
Missing IDs cached as "unknown" so repeat clicks don't re-query them
  |
  v
Overview re-renders: YouTube badges change colour
  green = Public · yellow = Unlisted · red = Private · slate = Unknown
```

**Outcome:** Every published video in the Overview shows its actual YouTube privacy at a glance.
