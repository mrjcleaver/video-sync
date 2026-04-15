# Video Bridge: User Guide

This guide walks you through every feature of Video Bridge, from initial setup to daily operation.

---

## 1. Getting Started

### Opening the Dashboard

Navigate to your Video Bridge URL (e.g. `https://video-sync-HASH.a.run.app`). The app loads a WebAssembly module on first visit — you'll see "Loading WASM module..." briefly.

Once loaded, the dashboard shows:

- **Header**: App name, build version badge, and navigation tabs
- **Filter bar**: Status filter tabs (Active, All, individual statuses, Done)
- **Video cards**: One card per indexed video showing title, duration, status, and actions
- **Burndown summary**: Total videos, excluded count, breakdown by status
- **Event Log**: Collapsible activity stream at the bottom

### First-Time Setup: Connect Your Platforms

Before importing, connect at least one source platform and one destination platform.

1. Click the **Connections** tab in the header
2. For each platform, enter the required credentials:

| Platform | Credentials needed | How to get them |
|----------|-------------------|-----------------|
| **Zoom** | Account ID, Client ID, Client Secret | Zoom Marketplace > Server-to-Server OAuth app |
| **YouTube** | Client ID, Client Secret | Google Cloud Console > APIs & Services > Credentials > OAuth 2.0 |
| **Fireflies** | API Key | Fireflies.ai > Settings > API |
| **Loom** | API Key | Loom > Settings > Developer |
| **OpenRouter** | API Key | openrouter.ai > Keys (for AI summaries) |
| **OpusClip** | API Key | opusclip.pro > API settings (for Shorts) |

3. For YouTube, after entering Client ID and Client Secret, click **Authorize** to complete the OAuth flow. You'll be redirected to Google's consent screen, then back to Video Bridge with your channel connected.

4. Credentials are stored in your browser's localStorage. They are never sent to any server other than the Video Bridge backend (same-origin API routes).

---

## 2. Importing Videos

Click the **Import** tab. You have four import methods:

### Zoom Import

1. Select a **date range** using the date pickers (default: last 30 days)
2. Optionally add filters:
   - **Title contains**: only import recordings matching a keyword
   - **Min duration**: skip short recordings (e.g. 5-minute test calls)
   - **Day of week**: only import recordings from specific days
3. Click **Fetch Recordings**
4. Review the list of discovered recordings — each shows title, date, duration, and participant count
5. Check the ones you want, then click **Import Selected**
6. Imported videos appear on the dashboard with status **Discovered**

### Fireflies Import

1. Click the **Fireflies** tab within Import
2. Click **Fetch Transcripts** to pull recent meetings from Fireflies
3. Review and select transcripts to import
4. Imported records include the AI-generated summary and full transcript

### URL Import

1. Click the **URL** tab within Import
2. Paste a direct video URL (Loom share link, MP4 URL, etc.)
3. Enter a title and optional metadata
4. Click **Import** — the video is indexed with the URL as its source location

### Manual Entry

1. Click the **Manual** tab within Import
2. Fill in the full metadata form: title, description, duration, platform, external ID
3. Click **Index** to add the video to the catalog

---

## 3. The Video Lifecycle

Every video moves through a status pipeline:

```
Discovered  -->  InScope  -->  Approved  -->  Publishing  -->  Published
                                                  |
                                                  v
                                               Failed  -->  ToRetry
```

Alternative paths:
- **Discovered/InScope** --> **Skipped** (operator decides not to publish)
- Any status --> **Abandoned** (operator permanently excludes)

### Status Definitions

| Status | Meaning | Action needed |
|--------|---------|---------------|
| **Discovered** | Imported but not yet evaluated | Review or let rules engine triage |
| **InScope** | Matched an ingestion rule — flagged for review | Approve or skip |
| **Approved** | Ready for publication | Publish manually or via backfill |
| **Publishing** | Upload in progress | Wait for completion |
| **Published** | Successfully uploaded to destination | None — done |
| **Failed** | Upload encountered an error | Review error, retry |
| **ToRetry** | Marked for retry after failure | Will be picked up by next publish attempt |
| **Skipped** | Operator decided not to publish | Can be reversed |
| **Abandoned** | Permanently excluded from pipeline | Requires manual re-inclusion |

---

## 4. Working with Video Cards

Each video on the dashboard is a card showing:

- **Title** and duration
- **Status badge** with color coding
- **Source platform** icon and recording date
- **Expand arrow** to reveal full details

### Expanded Card Actions

**Metadata:**
- View and edit title, description, tags, participants
- View transcript (fetched from Fireflies or Zoom)
- Add internal notes with timestamps

**Status Actions:**
- **Approve**: Move to Approved (ready for publish)
- **Skip**: Mark as Skipped
- **Exclude**: Permanently abandon

**Publishing:**
- **Publish to YouTube**: Downloads from source, uploads to YouTube with current metadata
- **Generate Shorts**: Send to Opus Clip for short-form clip generation

**Provenance:**
- **Locations**: See every platform this video exists on (Origin, Intermediate, Destination) with external links
- **Add Location**: Manually attach an enriched version (e.g. a Loom edit of a Zoom recording)
- **Link Upstream**: Connect this video to a related recording (same event, transcribed from, etc.)

### Bulk Operations

- **Bulk Approve**: Button on the main dashboard approves all videos currently in **InScope** status
- **Filter tabs**: Switch between Active/Done/individual statuses to focus your review

---

## 5. Rules Engine

Video Bridge has three layers of rules that progressively automate the pipeline.

### Ingestion Rules (Triage)

Found in the **Rules** tab. These run automatically every 60 seconds (or on-demand via "Run Now") and evaluate all Discovered videos.

**Creating a rule:**

1. Click **Add Rule**
2. Set criteria (all optional — combine as needed):
   - **Title pattern**: regex or substring match
   - **Day of week**: e.g. only Thursday and Friday recordings
   - **Duration range**: min and/or max minutes
   - **Date window**: only videos recorded within a date range
   - **Participants**: match by name or email
   - **Tags**: match by tag
3. Choose an action:
   - **Mark In Scope**: moves matching videos to InScope for human review
   - **Auto Approve**: skips InScope, moves directly to Approved
   - **Auto Skip**: marks matching videos as Skipped
4. Set priority (lower number = evaluated first)
5. Enable/disable the rule

**Testing rules:**
- Click **Dry Run** to see which videos would match without making changes
- The dashboard shows a runner status indicator: last run time and match count

### Processing Rules (Metadata Transformation)

Found in the **Processing Rules** tab. These transform metadata when a video is approved or published.

**Capabilities:**
- **Title templates**: `{{title}} - {{date:D MMM YYYY}}` produces "Team Standup - 15 Mar 2026"
- **Description templates**: Include `{{participants}}`, `{{source_platform}}`, `{{transcript_summary}}`
- **Tag transforms**: Add, remove, or replace tags based on criteria
- **LLM summary**: Request an AI-generated description via OpenRouter

### Post-Processing Rules (Notifications)

Found in the **Post-Processing Rules** tab. These fire after a video is published.

**Actions:**
- **Webhook**: POST to a URL with video metadata (title, YouTube URL, status)
- **Email**: Send notification via Gmail with customizable template

**Triggers:** On success, on failure, or always.

---

## 6. Backfill Orchestration

For publishing large batches of approved videos (e.g. 18 months of backlog), use the **Backfill** tab.

### Setting Up a Backfill Profile

1. Click **Add Profile**
2. Configure:
   - **Date range**: Which recording dates to include
   - **Source platforms**: Zoom, Fireflies, Loom, or all
   - **Criteria**: Duration, day-of-week, title filters
   - **Daily quota**: Max uploads per day (default: 6, respecting YouTube API limits)
   - **Time window**: Hours during which uploads should run (e.g. 09:00–17:00 UTC)
3. Save the profile

### Running Backfill

1. Click **Populate Queue** to fill the upload queue from approved videos matching the profile
2. Review the queue — drag to reorder, remove individual items
3. Click **Start Orchestrator** to begin
4. The orchestrator:
   - Checks if the daily quota has been reached
   - Checks if the current time is within the configured window
   - If both pass, uploads the next video in the queue
   - Logs progress to the Event Log
   - Pauses automatically when quota is exhausted or window closes
5. Monitor progress: uploads today, queue depth, estimated completion

---

## 7. Shorts Generation

Generate short-form clips from published videos using Opus Clip.

### Manual Generation

1. On a Published video card, click **Generate Shorts**
2. Video Bridge sends the YouTube URL to Opus Clip
3. Opus Clip analyzes the video and returns ranked clips with virality scores
4. Clips appear in the **Shorts** tab

### Review and Publish

1. Go to the **Shorts** tab
2. Filter by Pending / Approved / Rejected
3. For each clip:
   - Preview the clip content
   - See the virality score
   - Edit the title if needed
   - **Approve** or **Reject**
4. Approved clips are published to YouTube as Shorts with:
   - Title appended with "#Shorts"
   - Description linking back to the parent video

---

## 8. Provenance Graph

Click the **Provenance** view toggle (next to "Videos") to see a visual graph of how your videos relate across platforms.

**Reading the graph:**
- **Nodes** represent videos on specific platforms (color-coded by platform)
- **Edges** show relationships:
  - **SameEvent**: Same meeting recorded on two platforms
  - **TranscribedFrom**: Fireflies transcript of a Zoom recording
  - **ScreenRecordingOf**: Loom screen recording of a meeting
  - **ClipOf**: Short clip generated from a longer video
- **Node roles**: Origin (source), Intermediate (edited version), Destination (published)
- Click a node to jump to its video card

---

## 9. Event Log

The Event Log at the bottom of the dashboard has two views:

### Session View

Real-time activity from the current browser session: imports, approvals, rule runs, upload progress, errors.

### Structured View

Persistent log entries stored across sessions. Each entry shows:
- Timestamp
- Level (DEBUG, INFO, WARN, ERROR)
- Component (e.g. `api:zoom/recordings`, `runtime:memory`, `backfill:upload`)
- Message and details

**Memory pressure alerts** from the server appear here automatically (polled every 30 seconds). If you see `runtime:memory` warnings, the server is approaching its memory limit.

**Actions:**
- **Download .jsonl**: Export the full log for support or debugging
- **Clear**: Reset the log buffer

---

## 10. Dashboard Filters and Sorting

### Status Filters

The filter bar at the top provides quick access:

| Filter | Shows |
|--------|-------|
| **Active** | Discovered, InScope, Approved, Publishing, Failed, ToRetry |
| **All** | Every video in the catalog |
| **Done** | Published, Skipped, Abandoned |
| Individual status | Only that specific status |

### Sorting

- **Recorded date**: When the original recording happened (default)
- **Last updated**: Most recently changed videos first

### Burndown Summary

Below the filters, a summary bar shows:
- Total videos in catalog
- Excluded count
- Breakdown by each status with counts

---

## 11. Troubleshooting

### "Request failed (502)" or upload errors

1. Open the **Event Log** and switch to **Structured view**
2. Look for `error` level entries around the time of failure
3. The `rid` (request ID) correlates server and client log entries
4. Check the `component` field to identify which integration failed (e.g. `ext:youtube-upload`)

### YouTube upload quota exceeded

YouTube allows approximately 6 uploads per day on a standard API quota. If you see quota errors:
- The backfill orchestrator pauses automatically and resumes the next day
- Manual publishes will fail with a quota error until the daily reset (midnight Pacific)

### Memory pressure warnings

If you see `runtime:memory — memory pressure` or `memory critical` in the Event Log:
- The server is using 80%+ of its allocated memory
- Current uploads may be using large buffers
- If the server is OOM-killed, Cloud Run will restart the instance automatically
- Contact your DevOps team if warnings are frequent — the memory limit may need increasing

### OAuth token expired

If YouTube or Zoom requests fail with 401/403:
- Go to **Connections** and re-authorize the affected platform
- For YouTube: click **Authorize** to get a fresh refresh token
- For Zoom: verify your Server-to-Server OAuth app is still active in the Zoom Marketplace

### Videos not matching rules

1. Go to **Rules** tab and click **Dry Run** on the rule in question
2. Check the criteria carefully — all conditions must match (AND logic)
3. Verify the rule is **enabled** and has the correct priority
4. Check the **Run Now** button to force an immediate evaluation
