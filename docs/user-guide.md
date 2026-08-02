# Video Bridge: User Guide

This guide walks you through every feature of Video Bridge, from initial setup to daily operation.

---

## 1. Getting Started

### Opening the Dashboard

Navigate to [`https://video-sync.agentics.org`](https://video-sync.agentics.org). Access is gated by Google Cloud IAP — sign in with your Workspace account; your role (Admin / Publisher / Viewer) is derived from Cloud Identity Groups (ADR-036). The app loads a WebAssembly module on first visit — you'll see "Loading WASM module..." briefly.

Once loaded, the dashboard shows:

- **Header**: App name, build version badge, plus action buttons — Connections, View Logs, Feedback, Help
- **Filter bar**: Status filter tabs (Active, All, individual statuses, Done)
- **Video cards**: One card per indexed video showing title, duration, status, and actions
- **Burndown summary**: Total videos, excluded count, breakdown by status
- **Event Log**: Collapsible activity stream at the bottom

### First-Time Setup: Connect Your Platforms

Before importing, connect at least one source platform and one destination platform.

1. Click the **Connections** button in the header (the Connections panel expands inline)
2. For each platform, enter the required credentials:

| Platform | Credentials needed | How to get them |
|----------|-------------------|-----------------|
| **Zoom** | Account ID, Client ID, Client Secret | Zoom Marketplace > Server-to-Server OAuth app |
| **YouTube** | Client ID, Client Secret, refresh token | Google Cloud Console > APIs & Services > Credentials > OAuth 2.0 — **per-operator**, brand-account manager identity (ADR-042) |
| **Fireflies** | API Key | Fireflies.ai > Settings > API |
| **Kaltura** | Partner ID, Admin Secret | Kaltura Management Console — **shared default only** (admin secret is too privileged for per-operator entry) |
| **OpenRouter** | API Key | openrouter.ai > Keys (for AI summaries) |
| **OpusClip** | API Key | opusclip.pro > API settings (for Shorts) |
| **Loom** | *(no credentials)* | Loom's public API was discontinued in 2025; manual URL import only via the URL Import tab |

3. For YouTube, after entering Client ID and Client Secret, click **Authorize** to complete the OAuth flow. You'll be redirected to Google's consent screen, then back to Video Bridge with your channel connected. YouTube is intentionally per-operator — uploads carry your identity inside the brand account so the Content ID / copyright-dispute audit trail at YouTube's own layer reflects who performed the upload.

4. Credentials follow a **hybrid model** (ADR-042): shared defaults live in Google Secret Manager and are managed by Admins; operators may override locally in their browser. The status line under each connection card reads `● Shared default · set by …`, `● Override active (your browser)`, or `○ Not configured` so you always know which source a request will use. YouTube is the exception — always per-operator, no shared option.

---

## 2. Importing Videos

The **Import** panel sits directly under **Connections** and offers three source tabs: **Meetings** (default — stacks Fireflies, Zoom, Kaltura, and YouTube Live broadcasts with a shared date range), **URL** (manual paste for Loom share links and one-off YouTube URLs), and **Manual** (free-form entry).

> **What happens after import.** On every successful import the app automatically fetches your authorized YouTube channel's uploads (first call costs a few API quota units; cached for one hour). This populates the YouTube privacy cache and seeds "Possible YouTube match" banners on any newly imported card that looks like it's already on YouTube. See §4.

### Fireflies Import

1. Click the **Fireflies** tab within Import
2. Click **Fetch Transcripts** to pull recent meetings from Fireflies
3. Review and select transcripts to import
4. Imported records include the AI-generated summary, full transcript, and participant emails

### Zoom Import

1. Click the **Zoom** tab within Import
2. Select a **date range** using the date pickers (default: last 30 days)
2. Optionally add filters:
   - **Title contains**: only import recordings matching a keyword
   - **Min duration**: skip short recordings (e.g. 5-minute test calls)
   - **Day of week**: only import recordings from specific days
3. Click **Fetch Recordings**
4. Review the list of discovered recordings — each shows title, date, duration, and participant count
5. Check the ones you want, then click **Import Selected**
6. Imported videos appear on the dashboard with status **Discovered**

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

- **Title** (with the processing-rule transform applied — original shown in italics below if it differs)
- **Status badge** with color coding
- **Source platform**, duration, recording date, **participant count** (click to expand)
- **Suggestion banners** (blue and purple — see below)

### Suggestion banners (ADR-016, ADR-033)

Two kinds of banner appear automatically on non-Published cards when the app detects a likely match. Each banner has **Accept**, **Not a match**, and a preview/view link.

- **Blue — "Possible YouTube match: …"** — A cached YouTube upload from your channel appears to be this record (≥ 70% score). Click **Link & mark Published** to run the Recover flow: verifies via the YouTube API, caches privacy, creates the Destination location, transitions this record to Published. **Preview** opens the YouTube page so you can sanity-check first. **Not a match** dismisses the pair permanently (stored in `localStorage["video-sync:rejected-yt-matches"]`).
- **Purple — "Possibly same event: …"** — Another record in the catalog (different source platform) looks like a parallel capture of the same meeting (≥ 55% score, weighted by participant-email overlap, recording-start proximity, and title overlap — **not** duration, which diverges when Zoom starts earlier than Fireflies). Click **Link as same event** to create an `UpstreamLink(SameEvent)`. **View** scrolls to the sibling card. **Not a match** dismisses the pair.

### Expanded Card Actions

**Metadata:**
- View and edit title, description, tags
- **Participants (N)**: click to expand the full list (emails render in monospace so Fireflies/Zoom normalisation gaps are visible at a glance)
- View transcript (fetched from Fireflies or Zoom)
- Add internal notes with timestamps

**Status Actions:**
- **Approve**: Move to Approved (ready for publish)
- **Skip**: Mark as Skipped
- **Exclude**: Permanently abandon
- **Retry**: Re-attempt publishing after a failure

**Publishing:**
- **Publish to YouTube**: Downloads from source, uploads to YouTube with current metadata. On click, the main filter automatically switches to **Active** so you can watch the Publishing → Published/Failed transition.
- **Generate Shorts**: Send to Opus Clip for short-form clip generation

**Recovery (non-Published cards):**
- **Recover from YouTube**: opens a panel for linking an existing YouTube video to this record. Two ways:
  - **Auto-lookup on YouTube** — searches your authorized channel's cached uploads and shows the top 5 fuzzy matches with scores and a ✓ if the date is within 31 days. One click on **Use this** runs the recovery flow.
  - **Manual paste** — paste a watch URL, short URL, Studio URL, or 11-character ID and click **Recover**.
  Either path verifies the video exists, caches its privacy, and chains `approve → request_publish → mark_published` to reach the Published state. Useful for videos whose upload dropped the SSE stream (server succeeded but the browser thought it failed) or videos that were uploaded out-of-band.

**Provenance:**
- **Locations**: See every platform this video exists on (Origin, Intermediate, Destination) with external links. Each YouTube location has a **Check Status** button that calls the YouTube API — it updates the privacy cache as a side effect.
- **Add Location**: Manually attach an enriched version (e.g. a Loom edit of a Zoom recording)
- **Link Upstream**: Connect this video to a related recording (same event, transcribed from, etc.)

**Inspection:**
- **Log**: per-card event log. Shows only entries whose `video_id` matches this card — much quieter than the global Event Log.
- **Provenance**: toggles a detailed view of relationships on this card.

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
- **LLM summary**: Request an AI-generated description via OpenRouter. See §6a below — the default description strategy has been superseded by the Description Strategy panel (ADR-064).

### Description Strategy (ADR-064)

Found in **Config → 📝 Description strategy**. Controls how the paragraph description on each record (the one that ships to YouTube uploads) is produced. Two modes:

- **Copy from Show Notes** (default) — deterministic markdown → YouTube-plain-text conversion of the record's Show Notes doc. Emits `HH:MM:SS Chapter` lines that YouTube renders as clickable chapter jumps. No LLM call. Falls back to the transcript LLM path when a record has no Show Notes yet.
- **Generate from transcript** — LLM one-shot summariser fed the transcript directly. Ignores Show Notes even when present. Pre-ADR-064 behaviour.

A prompt textarea below the mode radio lets Admins tune the transcript-mode prompt. Ships with an embedded default; a `↺ Reset to default` button appears when the textarea drifts.

On each VideoCard, the button next to the Description label reflects the mode:
- **📋 Copy from Show Notes** when the record has a Show Notes doc AND the default mode is on.
- **✨ Regenerate from transcript** when either the mode is switched OR the record has no Show Notes.

### Show Notes Prompt (ADR-046)

Found in **Config → 📄 Show Notes prompt**. Formerly on Maintain; moved to Config alongside the Description Strategy panel. Edits the org-shared chapter-oriented prompt that produces the M/L/T/C section breakdown. Bulk-regen tools live in the same panel (skips locked records by default; cost cap protects against runaway spend).

### Post-Processing Rules (Notifications)

Found in the **Post-Processing Rules** tab. These fire after a video is published.

**Actions:**
- **Webhook**: POST to a URL with video metadata (title, YouTube URL, status)
- **Email**: Send notification via Gmail with customizable template

**Triggers:** On success, on failure, or always.

---

## 6. Backfill Orchestration

For publishing large batches of approved videos (e.g. 18 months of backlog), use the **Backfill Uploader** panel. The page layout is: Connections → Import → **Sync Status** (calendar / overview of every video's progress) → **Backfill Uploader** → Rules → Processing Rules → Post-Processing Rules → Shorts.

The panel has four tabs: **Overview** (default), **Profiles**, **Queue**, **Calendar**. The header has a **↻ refresh** button that re-pulls video data from the store — click it after an import if the views look stale.

### Overview tab

Shows the **entire profile date range at a glance**, designed for operators working through 18-month backlogs. Header bar:

- `pct% published` · counts by status (Published / Approved / Backlog / Failed / Gap) · `~N days to clear at K/day` estimate
- Green progress bar under the numbers
- **Fill privacy** button — batch-checks YouTube for the privacy of every published video in view (1 quota unit per 50 videos, so a 1000-video channel costs ~20 units). Results cache for one hour.
- **Target days only** toggle (on by default) — hides non-target weekdays so the view isn't cluttered

Below that, one row per month. Each row has:

- Month label (e.g. `Mar 2026`)
- Stacked status bar coloured by state proportion
- `published/target · N gaps` summary
- Click the row to expand a vertical per-date list with columns: date · status dot · transformed title · **Origin** badge (clickable) · **YouTube** badge (coloured by privacy: green=public, yellow=unlisted, red=private, slate=unknown; clickable; opens the video)
- Clicking a date row scrolls to the matching video card (auto-switches filter to `All` if the card is hidden)

Legend at the bottom distinguishes **Status** (short bars, matching the stacked bar in each month) from **YouTube privacy** (pill badges, matching the actual badges above).

### Calendar tab

A single month grid (pick the month with ‹ ›). Same dots, same click-to-jump behaviour, plus the "Target days only" toggle.

### Setting Up a Backfill Profile

1. Click **Profiles** tab → **Add Profile**
2. Configure:
   - **Date range**: Which recording dates to include
   - **Source platforms**: Zoom, Fireflies, Loom, or all
   - **Criteria**: Duration, day-of-week, title filters
   - **Daily quota**: Max uploads per day (default: 6, respecting YouTube API limits)
   - **Time window**: Hours during which uploads should run (e.g. 09:00–17:00 UTC)
3. Save the profile

### Running Backfill

1. Open the **Queue** tab, click **Populate Queue** to fill from approved videos matching the profile
2. Review the queue — drag to reorder, remove individual items
3. Header bar: click **▶ Start** to begin the orchestrator
4. The orchestrator:
   - Checks if the daily quota has been reached
   - Checks if the current time is within the configured window
   - If both pass, uploads the next video in the queue
   - Logs progress to the Event Log
   - Pauses automatically when quota is exhausted or window closes
5. Monitor progress: uploads today, queue depth, estimated completion — all visible in the Overview and in the header bar

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

There are two ways to see events: **global** (bottom of dashboard) and **per-video** (on each card).

### Per-video log

Click the **Log** button on any video card (next to Provenance) to see a filtered list of events whose `video_id` matches that card. This is usually what you want when investigating a specific video — the global log interleaves events from every card and rule run.

### Global Event Log

At the bottom of the dashboard. Two views:

**Session View** — real-time activity from the current browser session: imports, approvals, rule runs, upload progress, errors.

**Structured View** — persistent log entries stored across sessions. Each entry shows:
- Timestamp
- Level (DEBUG, INFO, WARN, ERROR)
- Component (e.g. `api:zoom/recordings`, `runtime:memory`, `backfill:upload`)
- Message and details

**Memory pressure alerts** from the server appear here automatically (polled every 30 seconds via `GET /api/health`). If you see `runtime:memory` warnings, the server is approaching its memory limit — investigate memory-heavy activity (concurrent uploads, large transcripts).

**Actions:**
- **Download .jsonl**: Export the full log for support or debugging
- **Clear**: Reset the log buffer (does not affect per-video logs the next time the page loads, since those are filtered from the same buffer)

---

## 10. What Lives Where

Most operationally relevant state is now shared across operators on the server. The practical answer to "if I open the app on a different browser":

| State | Where it lives | What you see on a fresh browser |
|---|---|---|
| Video catalog | `data/catalog.json` on FUSE-mounted GCS (ADR-035 Level 2) | **Same catalog as everyone else** |
| Transcripts, descriptions, summaries, chat | Workspace Shared Drive — one folder per meeting (ADR-039) | Same artifacts, openable in Drive |
| Ingestion / processing / post-processing rules | `data/rules.json` (ADR-031) | Same rules |
| Backfill profiles, queue, exclusions | `data/{backfill-profiles,backfill-queue,exclusions}.json` (ADR-043) | Same profiles + queue, no duplicate "don't re-import" decisions |
| Shared platform credentials (Zoom / Fireflies / Kaltura / OpenRouter / OpusClip) | Google Secret Manager, managed by Admins (ADR-042) | Same defaults — you can override locally if you want |
| YouTube credentials | Your browser only — per-operator by design (ADR-042) | **Empty** — re-authorise; YouTube uses your brand-account identity for accountability |
| Per-browser caches (YouTube privacy, YouTube uploads, sibling-match rejections) | `localStorage` | Empty until you click **Fill privacy** / **Auto-lookup**; rejected suggestions can reappear |
| Event log | `localStorage` (in-browser action history) | Empty; the server-side audit log (ADR-041) covers cross-operator visibility |
| UI state (which tab is open, search input) | `localStorage` | Defaults |

**Practical implication**: two operators on the same URL see the same catalog, same backfill state, same rules. The remaining per-browser items (YouTube auth + caches + UI state) all rebuild quickly.

### If you accidentally wipe browser data

- **Catalog, rules, profiles, queue, exclusions, transcripts** — preserved on the server; they hydrate back on next page load
- **YouTube** — re-run the OAuth flow from the Connections panel
- **Privacy / uploads caches** — one click on **Fill privacy** or **Auto-lookup on YouTube** rebuilds them

---

## 11. Dashboard Filters and Sorting

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

## 12. Catch-Up Maintenance

The **Catch-Up** side drawer (gear icon → Catch-Up) houses *operator-invoked maintenance passes* — bulk operations that act across the whole catalog at once. Distinct from §6 Backfill Orchestration: that fills the catalog with new imports; Catch-Up maintains the state of records already in it.

### Run Catch-Up (ADR-047)

The original per-record pipeline. Walks records in a chosen scope (date range / status filter), running three stages per record:

- `hydrate_transcript` — pulls captions from Kaltura when the record is a Kaltura source and the transcript field is empty.
- `link_siblings` — auto-link high-confidence sibling pairs (cross-platform captures of the same event). Threshold of 0.85 silently links; 0.6–0.85 surfaces via the existing banner for review.
- `ensure_summary` — regenerate when the summary is missing or stale. Uses the ADR-053 transcript-borrow resolver, so records without their own transcript can still be summarised via a paired record's text.

Has a cost cap (default $5.00) to protect against accidental large runs. Resumes on browser refresh — completed records drop out of the work list automatically.

### Broadcast-Pair Migration (purple card — ADR-049 slice 5)

One-shot cleanup of legacy data. Two effects:

1. Removes duplicate same-video Origin+Destination location entries (e.g. `Origin: youtube-X` + `Destination: X` pointing at the same video — the canonical 779fabe6 case ADR-049 was written to fix).
2. Reclassifies `SameEvent` upstream links to `BroadcastedFrom` / `TranscribedFrom` for known pair patterns: YouTube-Live ↔ {Zoom, Streamyard, OBS, Wirecast}, Fireflies ↔ meeting-source.

Idempotent. Safe to re-run.

### YouTube Row Backfill (green card — ADR-049/050 C1-A)

For every Destination-YouTube location on a host record (Zoom/Fireflies/Loom/Kaltura) that has no corresponding YouTube source row in the catalog, fetches metadata via the YouTube Data API and creates the source row with the correct `BroadcastedFrom` upstream link. Auto-advances new rows to Published per ADR-051 (born-on-YouTube records shouldn't sit at Discovered).

**Repair-on-rerun**: also catches "partial pair" cases — YouTube row exists but its upstream link is missing (e.g. a prior run was interrupted between ingest and link write). The scanner picks these up; the helper writes the missing link without re-fetching metadata.

The new row gets correctly classified per the ADR-049/050 rules:

| Host | Result |
|---|---|
| Zoom/Streamyard/OBS/Wirecast | `BroadcastedFrom → host` |
| Fireflies *with* a TranscribedFrom upstream to a meeting source still in catalog | `BroadcastedFrom → that-meeting-source` (skip the Fireflies "middleman") |
| Fireflies *standalone* (no meeting source in catalog — ADR-050 fallback canonical) | `BroadcastedFrom → host` (Fireflies-as-canonical) |
| Loom / Kaltura / YouTube | Created but not auto-linked; matcher decides |

Requires a Google API Key (for YouTube Data API metadata lookup) — either in **Connections → YouTube → Google API Key** for the operator's session, or as a `GOOGLE_API_KEY` env var on the Cloud Run service for everyone (recommended via Secret Manager per ADR-042).

### Show Notes Backfill (blue card — ADR-052)

Walks every record with a usable transcript and generates Show Notes docs that are **missing** (no `summary_doc_id`) or **stale** (prompt version drifted below current). Pre-flight count breaks down: `Run backfill (N missing, M stale, K via borrowed transcript)`. Formerly called "Summary Badge Backfill" — the underlying artifact ID (`summary_doc_id`) and API paths still use `summary` for stability; the UI is Show Notes.

Default **skips locked records** (records the operator deliberately froze with the lock icon on the `📄` badge). An **Include locked records (override)** checkbox surfaces in the card so override is one click and visible.

Cost cap **$5.00 USD per run** using `estimatePerRecordCost`. When the cap fires the run halts gracefully; re-clicking the button after starts a fresh budget — deliberate, so the operator splits intentional spend across sessions rather than being stuck with a cap they set hours ago.

**Resumes on browser refresh.** Records already processed (`summary_prompt_version === currentPromptVersion`) drop out of the work list automatically; the button shows the shrunk count. No separate run-state to lose.

### Transcript provenance lookup (ADR-053) — read-time, automatic

When a record's own `transcript_text` is empty, the system walks the provenance graph in a defined safe-relations set and uses a donor record's text. Affects: the Show Notes Backfill, the per-record **📄 Show Notes** button on each `VideoCard`, the description generator, and (when wired) any future feature needing a transcript (search, RAG, etc.).

### YouTube Transcript Fallback (ADR-063)

When a record has a YouTube location but no local `transcript_text` and no borrow-able sibling under ADR-053, the **📥 Fetch from YouTube** button appears next to the disabled Show Notes button. Uses progressive reach:

1. **YouTube Data API captions** (`captions.list` + `captions.download`) — official, requires video ownership; skipped when no YouTube OAuth headers.
2. **InnerTube player scrape** — same endpoint the YouTube web player uses; works for third-party videos as long as captions exist.
3. **yt-dlp** with `--write-auto-subs` — cascaded through `android`, `ios`, `tv_embedded,tv`, `web+ua` player clients. Cloud Run image ships yt-dlp already (ADR-027). `YOUTUBE_COOKIES_FILE` env var opts into a signed-in session fallback.

First that succeeds wins; failures return a `tried[]` audit trail so operators see which reach step blocked. On success the fetched transcript is stashed in the store's dedicated transcript cache (never touches WASM heap, never blows localStorage quota).

### Push Title + Description to YouTube (ADR-064-adjacent)

The **↗ Push title + description to YouTube** button on each card PUTs the record's current local `title` and `description` to the actual YouTube video via `videos.update`. Idempotent — no-op when both already match. Requires the `youtube.force-ssl` OAuth scope; the tooltip explains the reconnect step if the operator's token predates ADR-029. Replaces the older "Realign + push" button which coupled title-alignment to push; realignment is now a separate 🏷 Realign button, so operators can settle title AND description locally before syncing YouTube.

| Relation | Safe to borrow? | Why |
|---|---|---|
| `SameEvent` | ✅ both directions | Peer capture of same event |
| `BroadcastedFrom` | ✅ both directions | Same audio, full duration |
| `TranscribedFrom` | ✅ both directions | Transcript-bot purpose-built |
| `ClipOf` | ❌ | Partial — can't represent the full upstream |
| `ScreenRecordingOf` | ❌ | Different audio surface — may include voice-over, omit music |

**Donor priority** when multiple qualify:
1. Fireflies (diarised, highest fidelity)
2. Zoom / Streamyard / OBS / Wirecast (meeting-side auto-transcription)
3. YouTube auto-captions (no diarisation)
4. Kaltura captions (varies by upload pipeline)

Ties broken by transcript length — longer wins.

Borrowing is **read-time**, not at backfill time. No transcript copying; the donor's text stays on the donor's Drive. The badge UI gains (planned) a via-pair indicator (e.g. `📄 v3 ←FF`) for transparency.

---

## 13. Troubleshooting

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

### Video shows Failed but is actually live on YouTube

Most commonly this is a dropped SSE upload: the server finished the upload to YouTube, but the browser's upload-progress stream got cut before receiving the completion event, so the client marked the record Failed. To recover:

1. Open the failed card
2. Click **Recover from YouTube**
3. Click **Auto-lookup on YouTube** and pick the matching video (the inline blue suggestion banner may have already surfaced it)
4. The record transitions to Published with privacy correctly cached

This also works for videos you uploaded to YouTube out-of-band (e.g. via YouTube Studio) and want to link back to the catalog.

### "Possible YouTube match" banner is wrong

Click **Not a match** on the banner. The pair is dismissed permanently (per-browser) and the next candidate in the ranked list will surface on the next render.

### Duplicate records (same meeting from Zoom and Fireflies)

The app auto-suggests `SameEvent` links via the purple banner when it detects parallel captures (ADR-033). Click **Link as same event** to connect them. This doesn't merge the records — each stays as its own capture (Zoom has the video file, Fireflies has the transcript) — but it links them in the provenance graph so Processing Rules can pull description/transcript enrichment across the link in future versions.
