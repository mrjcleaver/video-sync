# ADR-013: Batch Ingestion with Rules Engine and Operator Memory

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-02-16 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The team has 18+ months of Zoom recordings to migrate to YouTube. The backlog is large (hundreds of meetings) but the target subset is specific: recordings from Thursdays and Fridays around lunchtime with particular host/topic names. Many recordings are unusable (too short, test calls, wrong content). The operator needs to:

1. **Filter** the backlog by day-of-week, time-of-day, duration, title patterns, and participants.
2. **Exclude** bad recordings (short duration, known junk titles) and have the system remember those decisions across restarts.
3. **Prevent duplicate uploads** — the same Zoom recording must never be uploaded to YouTube twice, even if the operator re-runs a batch.
4. **Set rules** so the system can work through the backlog in the background without constant manual intervention.

ADR-009 introduced the manual checklist curation workflow and explicitly deferred a rule engine to "start manual, automate later." The current system processes one video at a time with no filtering beyond status. This ADR introduces the "automate later" piece.

## Decision

### 1. Extended Status Lifecycle: Discovered → InScope → Approved

The current status lifecycle jumps from `Discovered` straight to `Approved`, which conflates "matches our criteria" with "operator has reviewed and confirmed." For batch processing this distinction matters — the operator needs to see what the rules selected before committing.

**New status: `InScope`**

```
Discovered   — Raw import, unclassified
    ↓ (rule engine matches criteria)
InScope      — Rules say this recording is a candidate
    ↓ (operator bulk-approves, or auto-approve rule)
Approved     — Confirmed for publishing
    ↓
Publishing → Published | Failed
```

This requires a Rust domain model change:

```rust
pub enum VideoStatus {
    Discovered,
    InScope,       // NEW — matched by a rule, awaiting operator review
    Approved,
    Skipped,
    Publishing,
    Published,
    Failed,
}

impl VideoStatus {
    pub fn can_scope(&self) -> bool {
        matches!(self, VideoStatus::Discovered)
    }

    pub fn can_approve(&self) -> bool {
        matches!(self, VideoStatus::InScope | VideoStatus::Skipped | VideoStatus::Failed)
    }
    // ... rest unchanged
}
```

**Why a separate status instead of a tag or filter?**
- It's a real workflow gate — the operator reviews the `InScope` queue as a batch before anything gets published.
- It survives restarts and is visible in the dashboard filter tabs.
- It prevents the rule engine from directly publishing without an approval checkpoint (unless the operator explicitly enables `auto_approve`).

### 2. Ingestion Rules

A **Rule** is a named, persisted filter + action pair that the system evaluates against incoming or existing video records.

```
Rule {
  id:          string (UUID)
  name:        string              // "Thursday/Friday lunch recordings"
  enabled:     boolean
  priority:    number              // Lower = evaluated first
  created_by:  ActorId
  created_at:  DateTime

  // Match criteria (all must match — AND logic)
  criteria: {
    source_platform?:  string      // "Zoom"
    title_pattern?:    string      // Regex or glob, e.g. "*Standup*"
    title_exclude?:    string      // Regex for titles to skip
    participant?:      string      // Email substring match
    days_of_week?:     number[]    // 0=Sun..6=Sat — [4,5] for Thu/Fri
    time_range?:       { after: string, before: string }  // "11:00","14:00"
    min_duration_secs?: number     // e.g. 300 (skip < 5 min)
    max_duration_secs?: number
    date_from?:        string      // ISO date — start of backlog window
    date_to?:          string      // ISO date — end of backlog window
    tags_include?:     string[]
    tags_exclude?:     string[]
  }

  // Action to take on match
  action: "mark_in_scope" | "auto_approve" | "auto_skip" | "auto_publish" | "tag"
  action_params?: {
    destination?:      string      // "YouTube" — for auto_publish
    privacy_status?:   string      // "unlisted" | "public" | "private"
    tags_to_add?:      string[]    // For "tag" action
  }
}
```

**Default workflow:** Rules use `mark_in_scope` to classify recordings. The operator reviews the InScope queue and bulk-approves. Only rules with `auto_approve` or `auto_publish` skip the human checkpoint.

### 3. Progressive Burndown

The dashboard shows a burndown view of the batch:

```
Total imported:     347
Excluded:            52   (operator decisions, persisted)
Out of scope:       189   (didn't match rules, still Discovered)
─────────────────────────
In Scope:            71   ← operator reviews this queue
Approved:            23   ← waiting to publish
Publishing:           1   ← currently uploading
Published:           11   ← done
Failed:               0
```

The burndown tracks:
- **Scope narrowing**: how many of the raw imports matched the rules vs. were excluded or ignored.
- **Approval progress**: how many InScope recordings the operator has reviewed.
- **Publish progress**: how many approved recordings have been uploaded, at what daily rate, and estimated completion date.

The operator's workflow is:
1. Fetch 18 months of Zoom recordings (paginated).
2. Rules run and move matches to `InScope`. Dashboard shows "71 in scope out of 347 imported."
3. Operator reviews the InScope list, bulk-approves good ones, skips/excludes bad ones.
4. System publishes approved recordings to YouTube, 6/day on default quota.
5. Operator checks burndown daily — "23 remaining, ~4 days to complete."

### 4. Operator Decision Memory

Operator decisions persist through two mechanisms:

**Video status** — approve, skip, and scope decisions are stored on each record and survive restarts via localStorage (MVP) or database (production).

**Exclusion list** — A dedicated persisted list of `(source_platform, source_id)` pairs that the operator has explicitly excluded. Stored separately from video records so that excluded recordings are never re-imported, even if the operator clears the catalog and re-fetches.

```
ExclusionEntry {
  source_platform:  string
  source_id:        string
  excluded_at:      DateTime
  excluded_by:      ActorId
  reason?:          string      // "Too short", "Test call", etc.
}
```

**Storage:** `localStorage["video-sync:exclusions"]` for MVP. The exclusion list is checked:
- At import time (ZoomImport skips excluded IDs)
- At rule evaluation time (rules skip excluded IDs)
- When the operator clicks "Exclude" on a card (adds to list + sets status to Skipped)

### 5. Upload Deduplication

The existing `PlatformLocation` system tracks where each video exists:

```
PlatformLocation {
  platform:     "YouTube"
  external_id:  "dQw4w9WgXcQ"    // YouTube video ID
  role:         "Destination"
  synced_at:    DateTime
}
```

**Deduplication rule:** Before any publish action (manual or rule-driven), the system checks:
1. Does this record already have a `PlatformLocation` with `platform == destination && role == "Destination"`?
2. If yes, skip — the video is already published there.

This check exists in the Rust domain model (`add_location` returns `DuplicateLocation`) but is not enforced at the UI/API layer before initiating an upload. This ADR makes it a hard gate.

### 6. Source Lineage and Preferred Publish Source

A single meeting often exists across multiple platforms in an enrichment chain:

```
Zoom (Origin) → Loom (Intermediate) → Veed.io (Intermediate) → YouTube (Destination)
```

Each platform adds value:
- **Zoom**: Raw recording (Origin — canonical identity for deduplication)
- **Loom**: Speed-ups, hesitation word removal, basic editing
- **Veed.io**: Captions, intros/outros, further post-production

The video record's **identity** always comes from the origin (Zoom meeting ID = `source_id`), but the **file uploaded to YouTube** should come from the best available intermediate — the one furthest along the enrichment chain.

#### Location Ordering

The existing `PlatformLocation` tracks platform + external_id + role, but does not capture ordering among multiple intermediates. Add an `ordinal` field:

```
PlatformLocation {
  platform:     "Loom"
  external_id:  "loom-abc123"
  external_url: "https://www.loom.com/share/abc123"
  role:         "Intermediate"
  ordinal:      1                   // Position in enrichment chain
  synced_at:    DateTime
}
```

Ordinal values: Origin is always 0, intermediates are 1, 2, 3, ... in enrichment order, Destination is omitted (set on publish).

#### Preferred Source Selection

When publishing, the system selects the download source by:

1. Find all locations with `role == "Intermediate"`, sorted by `ordinal` descending.
2. Pick the highest-ordinal intermediate that has a usable download mechanism.
3. If no intermediates exist, fall back to the origin.

"Usable download mechanism" depends on the platform:

| Platform | Download method | Automated? |
|----------|----------------|------------|
| Zoom | API with access token (`zoom://recording/{id}`) | Yes |
| Loom | No public download API; manual download or scraper | No (MVP) |
| Veed.io | Export URL from Veed dashboard; no public API | No (MVP) |
| Direct URL | HTTP fetch | Yes |

For platforms without download APIs, the operator manually downloads the enriched file and uploads it to the system. The upload form attaches the file to the existing record as a local `download_url` (e.g., a presigned S3 URL or a local file reference). This overrides the automated source selection.

#### Operator Workflow for Enriched Content

1. Zoom recordings are imported automatically (ZoomImport).
2. Operator edits selected recordings in Loom or Veed.io.
3. Operator adds the Loom/Veed.io location to the record via the "+ Location" form, setting role to Intermediate and the appropriate ordinal.
4. For Loom: operator downloads the MP4 from Loom's web UI and uploads it via a file upload form (or pastes a direct URL if available).
5. System publishes to YouTube using the enriched file, not the raw Zoom recording.
6. The record's locations show the full lineage: Zoom → Loom → YouTube.

#### Why Not a Separate Record Per Platform?

Each platform copy is **the same content** at different stages of enrichment, not a different video. Using a single record with multiple locations:
- Preserves the identity chain (the Zoom meeting ID is always the root).
- Prevents the same content from being published multiple times to YouTube (dedup checks the origin identity, not the intermediate).
- Keeps operator decisions (approve, skip, exclude) attached to the logical video, not scattered across platform-specific records.

### 7. Execution Model

This section addresses where the system runs, what needs to be open, and the constraints of each tier.

#### Tier 1: Browser-only (current MVP)

```
┌─────────────────────────────────────────────┐
│  Browser Tab                                │
│  ┌────────┐  ┌──────────┐  ┌────────────┐  │
│  │ WASM   │  │ Rule     │  │ React UI   │  │
│  │ Store  │  │ Runner   │  │ Dashboard  │  │
│  └────┬───┘  └────┬─────┘  └────────────┘  │
│       │           │                         │
│       └─── localStorage ───┘                │
│                                             │
│  ──── fetch() ──→ Next.js API Routes ────→  │  Zoom API / YouTube API
└─────────────────────────────────────────────┘
```

**How it works:** The WASM module, store, rules engine, and burndown tracker all live in the browser. A React hook (`useRuleRunner`) runs rule evaluation every 60 seconds. Next.js API routes proxy to Zoom and YouTube APIs.

**Constraint: the browser tab must be open.** When the tab is closed or the laptop sleeps, processing stops. When re-opened, it resumes from where it left off (all state is in localStorage). The `visibilitychange` API pauses the runner when the tab is hidden to avoid wasted evaluation cycles.

**Suitable for:** Backlog of <100 videos, operator actively monitoring. The operator opens the dashboard in the morning, lets it run through the day (6 publishes), closes at night.

#### Tier 2: Next.js server-side (near-term upgrade)

```
┌─────────────────────────────────────────────┐
│  Next.js Server (always running)            │
│  ┌────────────┐  ┌──────────────────────┐   │
│  │ API Routes │  │ Background Worker    │   │
│  │ /api/...   │  │ (setInterval / cron) │   │
│  └────────────┘  └──────────┬───────────┘   │
│                             │               │
│  ──── JSON file or SQLite ──┘               │
└─────────────────────────────────────────────┘
         ↕                           ↕
    Zoom API                   YouTube API
```

**How it works:** Move the RuleRunner to a Next.js server-side process. Rules and records are stored in a JSON file or SQLite database on the server. The `next dev` process runs continuously (Codespaces keeps it alive). A `setInterval` in a server module or a lightweight cron triggers rule evaluation.

**Key constraint: WASM cannot run server-side in Next.js easily.** The current WASM module is compiled for `wasm32-unknown-unknown` and loaded via `wasm-bindgen` in the browser. To run it server-side, options are:

| Option | Effort | Trade-off |
|--------|--------|-----------|
| **Recompile WASM for Node** (`wasm32-wasi` target) | Medium | Needs build pipeline change; `wasm-bindgen` doesn't directly support Node CJS |
| **Use the Rust code natively** via `napi-rs` or as a CLI | Medium | Best performance; needs Node native addon build |
| **Reimplement domain logic in TypeScript** | Low | Only need status transitions + dedup checks for the runner; full domain stays in Rust for the browser |
| **Use a headless browser** (Puppeteer) | Low | Hacky but works; runs the existing WASM in a real browser context |

**Recommended for near-term:** Reimplement the subset of domain logic needed by the RuleRunner in TypeScript (status transitions, dedup checks, rule matching). The full WASM domain model remains the source of truth in the browser for interactive use. The server-side runner only needs to read records, evaluate rules, and call API routes.

**No browser needed.** The Codespaces dev server runs continuously. The operator configures rules in the browser, then can close it. The server burns down the backlog autonomously.

#### Tier 3: Dedicated worker (production)

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐
│  Web App         │    │  Job Queue       │    │  Worker      │
│  (browser + API) │───→│  (Redis/SQS)     │───→│  (Rust CLI)  │
│                  │    │                  │    │              │
└──────────────────┘    └──────────────────┘    └──────────────┘
         ↕                                            ↕
    PostgreSQL                              Zoom API / YouTube API
```

**How it works:** Per ADR-003. Rules and records in PostgreSQL. A dedicated Rust worker process pulls jobs from a queue, downloads video, uploads to YouTube. Runs 24/7 on a server, scales horizontally.

**No browser, no WASM.** The Rust domain model runs natively. Full event sourcing and audit trail in the database.

#### Recommendation

For the 18-month backlog migration, **Tier 2 is the sweet spot.** It doesn't require the browser to be open, the dev server is already running in Codespaces, and the implementation effort is small (TypeScript rule matcher + `setInterval` in a server module). Tier 3 is overkill for a one-time migration.

### 8. Rule Management UI

A new `RulesPanel` component provides:
- List of rules with enable/disable toggles
- Rule editor form (criteria + action)
- "Dry Run" button — shows which records would match without applying actions
- "Run Now" button to trigger immediate evaluation
- Run history showing which records each rule matched and what action was taken
- Visual indicator when the runner is active

The dashboard gains:
- `InScope` tab in the filter bar (alongside Discovered, Approved, etc.)
- "Bulk Approve" button on the InScope view — approves all visible InScope records
- Burndown summary in the header stats area

### 9. Backlog Ingestion Strategy

For the 18-month backlog, the Zoom API returns recordings in 30-day pages. The ingestion flow:

1. **Operator configures a scoping rule** with `date_from` set 18 months ago and criteria for Thursday/Friday, lunchtime, specific names. Action: `mark_in_scope`.
2. **ZoomImport** gains a date range picker and "Fetch All Pages" mode that iterates through 30-day windows from `date_from` to today.
3. Each page of results is filtered against the exclusion list, then imported as `Discovered` records.
4. The RuleRunner evaluates the scoping rule, moving matching records to `InScope`.
5. The operator reviews the InScope list on the dashboard, bulk-approves the batch (or reviews individually).
6. The RuleRunner (or a server-side worker at Tier 2) publishes approved recordings to YouTube one at a time, respecting the daily quota.
7. The operator checks the burndown daily — "23 remaining, ~4 days to complete."

Estimated throughput: 6 videos/day on default YouTube quota. For ~100 in-scope videos, that's ~17 days. The operator should apply for a YouTube API quota increase to accelerate.

### 10. MVP Scope

| Feature | MVP (Tier 1) | Near-term (Tier 2) | Production (Tier 3) |
|---------|-------------|-------------------|-------------------|
| Rule storage | localStorage | JSON file on server | PostgreSQL |
| Rule evaluation | Browser hook, 60s interval | Server setInterval, 60s | Job queue worker |
| Browser required | Yes — must be open | No — server runs autonomously | No |
| Exclusion list | localStorage | JSON file on server | Database table |
| Upload dedup | Check locations before publish | Same | Same + distributed lock |
| Publish rate limit | In-memory counter, 6/day | Server-side counter | Redis counter with quota API |
| Status lifecycle | Discovered → InScope → Approved → Publishing → Published | Same | Same |
| Bulk approve | UI button on InScope view | Same + API endpoint | Same |
| Burndown | Dashboard stats | Same + server-side tracking | Same + dashboards |

## Consequences

### Positive

- `InScope` status creates a human review checkpoint between rule matching and publishing — the operator stays in control.
- Burndown tracking gives the operator visibility into progress and estimated completion.
- Tier 2 execution means the backlog burns down while the operator sleeps — no browser window required.
- Exclusion decisions persist across restarts — the operator never has to re-skip the same recording.
- Upload deduplication prevents wasted quota and duplicate content on YouTube.
- Rules are auditable — every auto-action is logged with the rule ID that triggered it.

### Negative

- Adding `InScope` status requires a Rust domain model change and WASM rebuild, which touches the core aggregate.
- Tier 2 requires reimplementing a subset of domain logic in TypeScript, creating a divergence risk between TS and Rust.
- YouTube's 6/day default quota means the full backlog will take weeks without a quota increase.

### Risks

- **Tier 2 logic divergence:** The TypeScript rule matcher could drift from the Rust domain model. Mitigation: the TS layer only handles rule matching and API calls; actual status transitions go through the WASM module when the browser is open, or are validated server-side with explicit status checks.
- **Rule misconfiguration** could auto-approve or auto-publish unintended content. Mitigation: default action is `mark_in_scope` (requires human bulk-approve); `auto_publish` is a separate opt-in action. "Dry run" mode shows matches before executing.
- **Large batch imports** (hundreds of records) may strain WASM memory during serialization. Mitigation: the `zoom://recording/{id}` URL scheme keeps stored data small.
- **YouTube quota exhaustion** mid-batch leaves some videos in `Publishing` state. Mitigation: RuleRunner checks quota before initiating upload and queues overflow for the next day.

## References

- ADR-002: Unified Video Metadata Schema (VideoRecord, PlatformLocation)
- ADR-003: Async Job Queue (production migration target for Tier 3)
- ADR-005: Source Platform Integration Strategy (Zoom adapter, polling)
- ADR-009: Checklist Curation (manual workflow, deferred rule engine)
- ADR-012: YouTube Publish Integration (upload flow, quota constraints)
