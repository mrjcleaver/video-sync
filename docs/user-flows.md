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
  |     Click "Save" --> credentials stored in localStorage
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
  +---> (Optional) Enter Fireflies API Key, Loom API Key,
  |     OpenRouter API Key, OpusClip API Key
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
  |--> Persisted to localStorage
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
Rule saved to localStorage + synced to server (POST /api/rules)
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
  - YouTube credentials (refresh token from localStorage)
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
Event Log also shows:
  - API request/response logs with correlation IDs
  - Import activity
  - Upload progress and completion
  - Rule engine matches
  - Post-processing webhook/email results
  |
  v
Click "Download .jsonl" to export full log for support
```

**Outcome:** Operator has full visibility into system behavior.
