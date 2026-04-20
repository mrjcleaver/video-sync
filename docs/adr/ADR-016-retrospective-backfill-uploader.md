# ADR-016: Retrospective Backfill Uploader

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-03-05 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The operator has approximately 20 months of recorded sessions spread across Zoom, Fireflies, and (potentially) Loom that have never been published to YouTube. The content follows recognisable patterns: sessions typically run on **Thursdays or Fridays**, are **45 minutes to 2 hours** long, and share recurring title conventions (e.g. "Live Vibe Coding", "Office Hours"). These sessions have accumulated faster than any manual curation and upload workflow could handle.

Two related but distinct problems need solving:

1. **Bulk backfill** — Get all qualifying content onto YouTube as quickly as quotas allow, with minimal operator involvement per video. Metadata quality can be "good enough for now."
2. **Metadata refinement** — At a later date (when processing rules are more mature, transcripts have been reviewed, and description templates are agreed upon), revisit the uploaded videos and update titles, descriptions, and tags in-place on YouTube without re-uploading the media.

The system must:

- Automatically discover, classify, and queue all qualifying historical recordings from connected sources.
- Present a **calendar view** that shows which sessions have source material and whether each has been published — so operators can see gaps at a glance.
- Run the upload pipeline **as a background service** that survives server restarts and continues working through the backlog autonomously.
- Respect **YouTube's daily upload quota** (default: ~6 uploads/day on a standard API key; higher with quota increases) and any source platform's rate limits.
- Support **deferred metadata refinement** on already-uploaded content without re-uploading the video file.

ADR-012 (YouTube Publish Integration) addressed single manual uploads. ADR-013 (Batch Ingestion Rules) addressed classification and filtering. ADR-014 (Processing Rules) addressed attribute transformation. This ADR addresses the orchestration layer that drives the backfill pipeline end-to-end at scale.

---

## Decision

### 1. Two-Phase Strategy: Bulk Upload → Metadata Refinement

The operator concern is explicit: publish 20 months of content now, refine later. This decouples two independent problems with different urgency and different tooling maturity.

```
Phase 1 — Bulk Upload (urgent)
  ├── Import from Zoom/Fireflies/Loom (ADR-011/015)
  ├── Classify via Ingestion Rules (ADR-013)
  ├── Apply minimal Processing Rules (ADR-014): title template + privacy = unlisted
  ├── Queue for upload respecting daily quota
  └── Mark Published + record YouTube video ID

Phase 2 — Metadata Refinement (deferred, iterative)
  ├── Identify Published videos needing description/tag/title update
  ├── Apply updated Processing Rules (more mature by then)
  └── Call YouTube videos.update (not videos.insert) — media not touched
```

Phase 1 content is published as `unlisted` by default so it is accessible but not surfaced in YouTube search while metadata is still rough. Phase 2 can change privacy to `public` on individual videos or in bulk.

### 2. Calendar View

A new **BackfillCalendar** UI panel shows a month-grid (or week-list) view of session coverage across the backfill window:

```
Each calendar cell represents one session slot (e.g., "Thu 6 Feb 2025"):
  ● Green  — Published to YouTube (link stored)
  ● Yellow — Source exists, queued or in backlog
  ● Red    — Source exists, upload failed (with retry button)
  ● Grey   — No source material found for this slot
  ● Empty  — Not a target slot (e.g., not Thu/Fri)
```

The calendar is driven by:
- The **target slot criteria** (days of week, time window, title pattern, min/max duration) stored as a `BackfillProfile`
- The **discovered VideoRecords** for the date range, joined by `recorded_at` to the calendar date
- The **published status** from `VideoRecord.status === "Published"` and `VideoRecord.locations` for the YouTube destination

The calendar spans from a configurable start date (e.g., `2024-08-01`) to the present. Future dates are not shown.

**Implementation**: Client-side, computed from the existing `videoStore` contents. No new API route required at MVP. The operator imports a date range from each source, the calendar auto-populates.

### 3. BackfillProfile: Target Criteria

A `BackfillProfile` captures the recurring session pattern. It reuses `RuleCriteria` from ADR-013 and extends it with backfill-specific fields:

```ts
interface BackfillProfile {
  id: string;
  name: string;
  enabled: boolean;

  // Source selection
  source_platforms: ("Zoom" | "Fireflies" | "Loom")[];
  date_from: string;   // ISO date — oldest session to include
  date_to?: string;    // ISO date — defaults to today

  // Matching (reuses ADR-013 RuleCriteria)
  criteria: {
    days_of_week?: number[];    // 0=Sun … 6=Sat; e.g. [4, 5] for Thu/Fri
    min_duration_minutes?: number;  // e.g. 45
    max_duration_minutes?: number;  // e.g. 120
    title_pattern?: string;         // regex
  };

  // Publishing defaults
  default_privacy: "private" | "unlisted" | "public";
  processing_rule_id?: string;  // Which ADR-014 processing rule to apply

  // Quota / pacing
  max_uploads_per_day: number;  // e.g. 5 (leave headroom below the hard limit)
  upload_window_start_hour?: number;  // UTC hour to begin daily uploads (e.g. 2 = 2AM)
}
```

Multiple profiles can coexist (e.g., one for "Live Vibe Coding", another for "Office Hours").

### 4. Backfill Queue and Persistence

The queue must survive process restarts. At MVP (no Redis, no PostgreSQL), queue state is persisted to:

```
localStorage["video-sync:backfill-queue"]  — ordered list of VideoRecord IDs pending upload
localStorage["video-sync:backfill-state"]  — { date, uploads_today, last_reset_date }
```

A **BackfillOrchestrator** runs in the Next.js API tier as a singleton process (not a separate worker at MVP). It is driven by a polling interval (every 5 minutes by default):

```
BackfillOrchestrator.tick():
  1. Check if upload window is open (current hour ≥ window_start_hour)
  2. Load backfill state; if last_reset_date < today, reset uploads_today to 0
  3. If uploads_today >= max_uploads_per_day: stop (quota exhausted for today)
  4. Dequeue next VideoRecord from the pending queue (status = Approved, not yet Published)
  5. Apply processing rules → compute publish attributes
  6. Call YouTube upload API (ADR-012 flow)
  7. On success: mark_published, increment uploads_today, persist state
  8. On failure: mark_failed, push to retry queue with backoff, persist state
  9. Loop to step 3 if uploads_today < max_uploads_per_day
```

The orchestrator is triggered by:
- A `GET /api/backfill/tick` endpoint (triggered by an external cron or the browser's `setInterval` while the dashboard is open)
- On app startup (Next.js `instrumentation.ts` hook)

**Restart survival**: Because the queue and upload count are in localStorage (browser) and Next.js server (file-based or in-memory), the queue persists across browser sessions. The `uploads_today` counter resets based on date, not process lifetime. If the server restarts, the orchestrator re-initialises from localStorage on the next tick.

**Tier 2 migration**: Replace localStorage queue with a SQLite or Postgres-backed job table, and the polling with a proper cron job (Node `cron` library or system cron). The API shape is unchanged.

### 5. YouTube Quota Accounting

YouTube's default quota is 10,000 units/day. A video upload (`videos.insert`) costs 1,600 units. This yields a maximum of **6 uploads/day** on default credentials. Operators who have applied for quota increases can raise `max_uploads_per_day` accordingly.

```
Quota tracking:
  uploads_today:   integer count of successful uploads today
  last_reset_date: "YYYY-MM-DD" in UTC; when current date differs, reset counter
  upload_cost:     1600 units per upload (configurable in profile)
  daily_budget:    max_uploads_per_day × upload_cost
```

If a video fails to upload (network, quota 403, etc.), it does NOT count against the daily budget. The orchestrator retries it on the next day's window (exponential backoff: 1 day, 2 days, 4 days max).

The orchestrator surfaces quota state in the UI:
```
"Backfill: 3 / 5 uploads today · 47 videos in queue · Next upload: tomorrow at 2:00 AM"
```

### 6. Metadata Refinement (Phase 2)

Uploaded videos already have a `youtube_video_id` (stored as `destination_id` on the VideoRecord and as a `Destination` location). Phase 2 updates metadata in-place using the YouTube **`videos.update`** API call, not `videos.insert`. The video binary is not re-transferred.

```ts
interface MetadataRefinementJob {
  video_record_id: string;
  youtube_video_id: string;
  updates: {
    title?: string;
    description?: string;
    tags?: string[];
    category_id?: string;
    privacy_status?: "private" | "unlisted" | "public";
  };
}
```

The refinement flow:
1. Operator updates processing rules (ADR-014) with richer templates/descriptions.
2. Operator selects a set of Published videos (e.g., all in a given month) from the calendar.
3. System applies new processing rules to compute updated attributes.
4. Preview is shown (same `PublishAttributes` preview as Phase 1).
5. Operator approves → system calls `YouTube.videos.update` for each, respecting a separate daily update budget (updates cost 50 units each — far cheaper, ~200/day on default quota).
6. `VideoRecord.status` stays `Published`; a new `MetadataRefined` domain event is emitted.

Phase 2 is **not implemented in this ADR** but the schema above is reserved. The `VideoRecord` aggregate and the `VideoRecord.locations` structure already support tracking the YouTube destination ID necessary for updates.

### 7. Idempotency and Deduplication

The same video must never be uploaded to YouTube twice.

- **Primary guard**: `VideoRecord.status === "Published"` prevents re-queueing. The backfill queue skips any record not in `Approved` status.
- **Secondary guard**: The `VideoRecord.locations` array stores the YouTube `external_id` (video ID). Before uploading, the orchestrator checks for a `Destination` location on YouTube. If present, it skips the upload even if status is not yet `Published` (handles the race condition where upload succeeded but `mark_published` was lost due to a crash).
- **Source deduplication**: `source_id` uniqueness prevents re-importing the same Zoom/Fireflies recording.

### 8. Calendar Data Model

The calendar is computed client-side from `VideoRecordJSON[]`. No dedicated calendar data model is stored.

```ts
interface CalendarSlot {
  date: string;            // "YYYY-MM-DD"
  day_of_week: number;     // 0–6
  is_target: boolean;      // matches profile criteria for this day
  videos: {
    id: string;
    title: string;
    duration_seconds: number;
    source_platform: string;
    status: string;         // Discovered | InScope | Approved | Publishing | Published | Failed
    youtube_url?: string;
  }[];
}
```

The `BackfillCalendar` component generates one `CalendarSlot` per day in the configured window, fills in matching `VideoRecordJSON` entries by `recorded_at` date, and renders the colour-coded grid.

---

## Consequences

### Positive

- Operators can survey 20 months of content in one calendar view rather than scrolling through an undifferentiated list.
- The quota-aware orchestrator prevents accidental quota exhaustion and gives predictable progress ("~10 days to clear the backlog at 5 uploads/day").
- Phase 2 refinement is explicitly decoupled from Phase 1 uploads — operators can start publishing now without perfect metadata.
- Restart survival means the backfill continues even after server maintenance without operator re-intervention.
- Reuses ADR-013 `RuleCriteria` (no new matching logic) and ADR-014 `ProcessingRules` (no new transform logic).

### Negative

- `setInterval`-based tick at MVP is fragile: the dashboard must be open in a browser for uploads to proceed. Mitigation: document this clearly; Tier 2 moves to server-side cron.
- YouTube's 6 uploads/day default quota means a backlog of 200 videos takes ~33 days. Operators should apply for a quota increase early.
- Metadata refinement (Phase 2) adds a new interaction with YouTube's API that requires fresh OAuth token management; this is deferred but the token refresh infrastructure must be in place first (ADR-007).

### Risks

- **Quota exhaustion on non-backfill activity**: If an operator manually uploads videos while the backfill is running, the shared daily quota can be consumed before the orchestrator's budget. Mitigation: the orchestrator reads from a shared quota counter that manual uploads also increment.
- **Source URL expiry**: Zoom `download_url` values expire (typically 24 hours). The orchestrator must fetch a fresh URL immediately before upload, not when the job is queued. For Fireflies, the CDN URL must be re-fetched from the API.
- **Partial upload state**: If the server crashes mid-upload and the YouTube upload session URI is lost, the partial upload cannot be resumed. The video remains in `Publishing` status (stalled). Mitigation: a watchdog that moves stale `Publishing` records (older than 2 hours) back to `Approved` for re-queueing.
- **Duplicate uploads on retry**: If `mark_published` is called but the network drops before the response reaches the client, the video may be in `Publishing` status with a YouTube video already created. The secondary guard (check `locations` for an existing YouTube entry) handles this.

---

## Addendum: Multi-Month Overview and Timezone Fix (2026-04-20)

### Problem: Single-Month Calendar Inadequate for 18-Month Backlogs

The original `BackfillCalendar` showed one month at a time. For an 18-month backlog (~78 weeks of content), operators had to click through months individually with no way to see the full picture — total progress, gaps across the entire period, or estimated completion.

### Problem: Day-of-Week Timezone Bug

`new Date("YYYY-MM-DD").getDay()` parses the string as UTC midnight but returns the day in local time. In timezones east of UTC, this shifts the day-of-week forward by one (e.g. Thu → Fri), causing target-day filtering and calendar rendering to highlight the wrong days. The same bug affected `matchesProfile()` when filtering videos by day-of-week criteria.

### Solution

**1. Timezone fix** — Both `buildCalendarMonth()` and `matchesProfile()` now use `new Date(year, month, day).getDay()` (local-time constructor) instead of parsing ISO date strings. This ensures the day-of-week matches the operator's local timezone regardless of UTC offset.

**2. Multi-month overview** (`BackfillOverview` component, "Overview" tab) — Shows the entire profile date range at once:

- **Summary bar**: Total progress percentage, counts by status (published, approved, backlog, failed, gaps), and estimated days to clear at current upload rate.
- **Progress bar**: Visual percentage of target days published.
- **Month rows**: One row per month with a stacked bar showing published (green), approved (purple), failed (red), and backlog (yellow) proportions. Each row shows `published/target · N gaps`.
- **Expandable detail**: Click a month to see its inline mini-grid calendar with day-level status dots.
- **Target-days toggle**: Same as the single-month calendar — hides non-target days when active.

```ts
interface MonthSummary {
  year: number;
  month: number;
  label: string;         // "Jan 2025"
  target_days: number;   // total target slots
  published: number;
  approved: number;
  in_backlog: number;
  failed: number;
  gaps: number;          // target days with no video
  slots: CalendarSlot[];
}
```

The existing single-month "Calendar" tab remains for detailed day-by-day inspection of a specific month.

---

## Implementation Phases

| Phase | Scope | Quota impact |
|-------|-------|-------------|
| **MVP** | Calendar view (client-side). Manual "Add to backfill queue" per video. Orchestrator driven by browser `setInterval`. Queue + state in localStorage. | Respects `max_uploads_per_day` |
| **Tier 1** | `GET /api/backfill/tick` endpoint. Orchestrator runs server-side on each tick call. Auto-populate queue from BackfillProfile matching all Approved records. Quota tracking persisted to a JSON file on disk (survives server restart without a database). | Same |
| **Tier 2** | Replace JSON file with SQLite/Postgres job table. Server-side cron replaces polling. Retry queue with exponential backoff. Real-time progress via SSE. | Shared quota counter with manual uploads |
| **Phase 2** | Metadata refinement: `videos.update` flow, bulk refinement UI, `MetadataRefined` domain event. | ~200 updates/day on default quota |

---

## References

- ADR-003: Async Job Queue (production worker infrastructure)
- ADR-004: Temporary Storage (video binary buffering)
- ADR-005: Source Integration Strategy (Zoom, Fireflies, Loom adapters)
- ADR-007: OAuth2 Token Management (YouTube token refresh for update calls)
- ADR-012: YouTube Publish Integration (upload API, resumable upload, quota)
- ADR-013: Batch Ingestion Rules Engine (RuleCriteria reuse, InScope status)
- ADR-014: Publishing Attribute Processing Rules (title/description templates)
- ADR-015: Fireflies Import Integration (source adapter)
- [YouTube Data API — Quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- [YouTube Data API — Videos.update](https://developers.google.com/youtube/v3/docs/videos/update)
