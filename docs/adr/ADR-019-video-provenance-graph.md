# ADR-019: Video Provenance Graph

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-03-06 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

---

## Context

The same meeting or session routinely exists on multiple platforms simultaneously, each platform producing an independent `VideoRecord`. The current model treats every `VideoRecord` as a standalone entity with no awareness of sibling records representing the same event.

### Platform roles in the pipeline

The platforms play distinct roles and are **not interchangeable**:

| Platform | Role | API access | Primary use |
|----------|------|-----------|-------------|
| Zoom (`ruv@ruv.net` or `agent@agentics.org`) | Origin | Full REST API | Raw recording source |
| Fireflies (`agent@agentics.org`) | Automated intermediary | Full GraphQL API | Bulk backfill (ADR-016): programmatic import of transcripts and recordings at scale |
| Loom (`agent@agentics.org`) | Curated intermediary | **No public API** (removed post-Atlassian acquisition) | Refined subsequent backfill: Loom recordings benefit from manual editing and hesitation-phrase removal, making them higher-quality sources — but they must be imported manually |
| YouTube, Kaltura | Destination | Full APIs | Publication |

**Fireflies** is the workhorse for automated backfill. Its API enables the ADR-016 orchestrator to bulk-import hundreds of meetings without human intervention.

**Loom** is a bonus quality layer. When a Loom recording exists for a session, it is likely the best available version — edited, cleaned up, without filler words. However, because Loom has no public API, it cannot participate in automated bulk backfill. It enters the pipeline only when a curator manually imports a Loom video. The provenance graph should surface "a Loom recording exists for this session" as a signal to pause automated Fireflies-based publishing and prefer the Loom version instead.

### Observed topology

Each meeting is recorded by **exactly one** Zoom account — either `ruv@ruv.net` or `agent@agentics.org`, whichever hosted it. Fireflies and Loom (both on `agent@agentics.org`) independently capture from that single Zoom session. They are siblings, not a chain.

```
  ruv@ruv.net (Zoom)
        │                      ← one account OR the other per meeting
  agent@agentics.org (Zoom)
        │
        │  one Zoom recording
        ├──────────────────────────┐
        │                          │
   Fireflies                    Loom
   (automated, bulk)        (manual, curated)
        │                          │
        │  preferred if            │  preferred when available
        │  Loom absent             │  (higher quality)
        └──────────┬───────────────┘
                   │
          ┌────────┴────────┐
          │                 │
       YouTube           Kaltura
```

The complexity arises from three facts:
1. The Zoom account that hosted the meeting may not be connected to this system (e.g. a meeting was hosted on `ruv@ruv.net` but only `agent@agentics.org` is configured here), so the Zoom `VideoRecord` may be absent — a **phantom node**.
2. The Fireflies and Loom records for the same meeting are indexed as independent `VideoRecord`s with no link between them or back to their Zoom origin.
3. The curator has no signal today that a Loom alternative exists when reviewing a Fireflies record — so the better source goes unnoticed.

Specific problems this creates today:

| Problem | Impact |
|---------|--------|
| A Fireflies record and its Zoom origin are unrelated in the UI | Curator has no context about the raw source; inconsistent publish decisions |
| When the Zoom recording is from an unconnected account (`ruv@ruv.net`), the relationship is invisible | No audit trail for "this derived from a Zoom we don't manage" |
| A Loom and a Fireflies record of the same session are not linked — the curator sees them as unrelated | May publish the Fireflies version without knowing a better Loom version exists |
| No read-model for "all representations of meeting X" | Cannot answer "has anything from this session already been published?" |

### What the current data model provides

`VideoRecord` already has:
- `source_platform: SourcePlatform` — the indexing source
- `locations: Vec<PlatformLocation>` — where the video exists (`Origin | Intermediate | Destination`)
- `recorded_at: Option<DateTime>` — when the meeting happened

What it lacks:
- Any cross-record link expressing "this record is a representation of the same event as that record"
- The concept of a **phantom node** — a platform location for which no `VideoRecord` exists in this system (e.g. the `ruv@ruv.net` Zoom recording)
- The `account_id` of the platform credential that produced a recording

---

## Decision

### 1. Extend `VideoRecord` with upstream provenance links

Add an `upstream_links: Vec<UpstreamLink>` field to `VideoRecord`:

```rust
/// A directional provenance link from this record to its upstream source.
/// `video_id` is None when the upstream record is a phantom (not indexed
/// in this system), identified only by platform + external_id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpstreamLink {
    /// ID of the upstream VideoRecord in this catalog, if known.
    pub video_id: Option<Uuid>,
    /// Platform of the upstream recording.
    pub platform: Platform,
    /// Platform-specific ID of the upstream recording.
    pub external_id: String,
    /// Optional display hint for the account that owns the upstream recording.
    /// e.g. "ruv@ruv.net" — stored as plain text, not a foreign key.
    pub account_hint: Option<String>,
    /// How the upstream content relates to this record.
    pub relation: DerivationType,
    /// Whether the link was detected automatically or asserted by a user.
    pub linked_by: LinkOrigin,
    /// When the link was established.
    pub linked_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum DerivationType {
    /// This record represents the same meeting as the upstream — different platform capture.
    SameEvent,
    /// This record's transcript was produced by processing the upstream video.
    TranscribedFrom,
    /// This record is a screen-recording or re-stream of the upstream.
    ScreenRecordingOf,
    /// This record is a time-bounded clip extracted from the upstream.
    ClipOf,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum LinkOrigin {
    Auto,   // matched by timestamp proximity and/or title similarity
    Manual, // asserted by a curator
}
```

**Directionality**: links point **upstream** (child → parent). A Fireflies record links to its Zoom source; a YouTube destination does not link back up (destinations are already expressed via `LocationRole::Destination` on the Zoom/Fireflies record's `locations` list).

**Phantom nodes**: when the upstream Zoom recording is not in this catalog (e.g. a different user's account), `video_id` is `None`. The `platform + external_id + account_hint` tuple gives enough information to display the node in the provenance graph and to potentially re-link it if the record is later indexed.

### 2. Add `account_id` to `PlatformLocation`

```rust
pub struct PlatformLocation {
    pub platform: Platform,
    pub external_id: String,
    pub external_url: Option<String>,
    pub role: LocationRole,
    pub ordinal: u32,
    pub synced_at: DateTime<Utc>,
    pub status: Option<String>,
    /// Which platform account produced or hosts this location.
    /// e.g. "agent@agentics.org" for a Fireflies account, "ruv@ruv.net" for a Zoom account.
    #[serde(default)]
    pub account_id: Option<String>,
}
```

`account_id` is set at ingestion time from the credential used (passed as part of the import command). It is display-only — not used for authentication.

### 3. WASM commands

Two new commands on `WasmVideoRecord`:

```rust
/// Link this record to an upstream source.
pub fn link_upstream(&mut self, cmd_json: &str) -> Result<String, JsValue>;

/// Remove a previously established upstream link.
pub fn unlink_upstream(&mut self, cmd_json: &str) -> Result<String, JsValue>;
```

Command shapes:

```ts
interface LinkUpstreamCmd {
  actor: Actor;
  video_id?: string;           // UUID of the upstream VideoRecord, if in catalog
  platform: string;            // "Zoom" | "Loom" | "Fireflies" | …
  external_id: string;
  account_hint?: string;       // "ruv@ruv.net"
  relation: "SameEvent" | "TranscribedFrom" | "ScreenRecordingOf" | "ClipOf";
  linked_by: "Auto" | "Manual";
}

interface UnlinkUpstreamCmd {
  actor: Actor;
  platform: string;
  external_id: string;
}
```

### 4. Auto-linking at import time

When Zoom, Fireflies, or Loom recordings are imported, the importer runs an auto-linker against the current catalog before committing each record:

**Matching algorithm** (all three signals must agree, or a single high-confidence signal suffices):

| Signal | Method | Threshold |
|--------|--------|-----------|
| Timestamp proximity | `|recorded_at_A - recorded_at_B| < 15 min` | High confidence alone |
| Title similarity | Levenshtein ratio > 0.7 after stripping platform prefixes | Medium |
| Participant overlap | Jaccard similarity of participant lists > 0.5 | Medium |

Two medium signals together → auto-link with `linked_by: Auto`.
One high-confidence signal alone → auto-link with `linked_by: Auto`.

Auto-links are marked visually in the UI as "suggested" and can be confirmed or rejected by a curator. Rejected auto-links are stored as explicit non-links (a `rejected_links` list) to prevent re-suggestion on the next import.

**Import-time flow:**

```
Fireflies import receives meeting M
  ↓
Auto-linker scans all VideoRecords with recorded_at within 15 min of M.started_at
  ↓
  Zoom record found (same participants) → link_upstream(video_id=ZoomId, relation=SameEvent, linked_by=Auto)
  No Zoom record found, but meeting metadata contains zoom_uuid → link_upstream(video_id=None, platform=Zoom, external_id=zoom_uuid, account_hint=..., linked_by=Auto)
  Nothing found → no link created
```

Fireflies meeting metadata already includes `zoom_meeting_id` when the Fireflies bot joined a Zoom call. This is the primary matching signal and alone constitutes high-confidence.

### 5. UI: Provenance Graph component

A new `ProvenanceGraph` component renders the upstream→downstream DAG for a selected set of records (or for a single record's neighbourhood).

**Layout**: a left-to-right column layout using CSS grid — no SVG library required at Tier 1. Columns represent pipeline stages:

```
[ Zoom account ]  →  [ Zoom recording ]  →  [ Fireflies ]  →  [ YouTube ]
                                         ↘  [ Loom      ]  →  [ Kaltura ]
```

The Zoom column shows which account hosted the meeting (may be a phantom node). The intermediary column (Fireflies, Loom) shows the sibling records derived from that single Zoom source. The destination column shows where each intermediary was published.

Each node displays:
- Platform icon (text label at Tier 1, SVG icon at Tier 2)
- Record title (truncated to 40 chars)
- Status badge
- Account hint (muted, below title)
- Phantom nodes rendered with dashed border and "Not in catalog" label

Edges are rendered as CSS `border-left` connectors on the column containers — a simple chevron-based approach requiring zero canvas or SVG.

**Entry points:**
1. **Per-card "Provenance" button** — opens a modal or inline expansion showing only the graph neighbourhood of that record (its upstream links + downstream records that link to it).
2. **Global Provenance tab** — shows the full graph of all records with at least one link, grouped by meeting date.

**Interaction:**
- Click a node to jump to that VideoRecord's card.
- Click an edge to see link metadata (relation type, linked_by, linked_at).
- "Link manually" button on a card — opens a search-and-link dialog scoped to nearby records by date.
- Curator can toggle auto-suggested links: confirm → `linked_by: Manual`; reject → add to `rejected_links`.

---

## Provenance graph data model summary

```
VideoRecord {
  id, source_platform, recorded_at, locations[], ...

  upstream_links: [
    {
      video_id?: UUID,        // None = phantom
      platform,
      external_id,
      account_hint?,
      relation: DerivationType,
      linked_by: LinkOrigin,
      linked_at
    }
  ]
}
```

The full graph is reconstructed client-side by:

1. Collecting all `upstream_links` across all `VideoRecord`s.
2. Building a node set: all `video_id` references (resolved from the store) + phantom nodes (grouped by `platform + external_id`).
3. Building an edge set: `(this_record → upstream)` for each link.
4. Augmenting with `LocationRole::Destination` edges from `locations[]` to represent the YouTube/Kaltura layer.

No server-side graph database is required. The graph is derived entirely from the client-side `VideoStore`.

---

## Alternatives Considered

| Alternative | Rejected reason |
|-------------|----------------|
| **Separate `MeetingSession` aggregate** | Requires a new aggregate root, new WASM commands, new storage; over-engineered for MVP — a link field on `VideoRecord` achieves the same result with far less schema change |
| **Use existing `locations[]` for cross-record links** | `PlatformLocation` represents "where the file exists", not "where the content came from". Conflating derivation with location would make queries ambiguous |
| **External graph database (Neo4j, Memgraph)** | No operational infrastructure yet; the graph is small (hundreds of nodes); client-side reconstruction is sufficient |
| **D3.js / vis-network for visualization** | Adds ~200 KB to the bundle; a CSS column layout is sufficient and consistent with the existing zero-dependency UI philosophy (ADR-017: Tier 1 has zero new npm dependencies) |
| **Only store links on the downstream record (current direction)** | Chosen approach — upstream-pointing links on the child record keep the parent `VideoRecord` immutable when a new derivative is added, avoiding fan-out mutations |

---

## Consequences

### Positive

- A curator reviewing a Fireflies record sees immediately that it derived from a Zoom recording on `ruv@ruv.net` — even if that Zoom record is not in the catalog.
- When a Loom sibling exists for the same session, the provenance graph surfaces it as a quality-upgrade signal — the curator can switch from the Fireflies source to the Loom source before approving, rather than discovering it after publishing.
- The ADR-016 backfill orchestrator can surface the Loom sibling when processing a Fireflies record, letting the curator decide whether to substitute, supplement, or ignore it.
- Auto-linking using `zoom_meeting_id` from Fireflies metadata is deterministic and requires no heuristics.
- The phantom node concept models the real-world situation (multi-account Zoom) without requiring those accounts to be connected to the system.
- No new npm dependencies; no server-side graph store.
- The `account_id` field on `PlatformLocation` gives future multi-tenant filtering ("show me only videos from `agent@agentics.org`'s Zoom account").

### Negative

- `VideoRecord` gains more fields; WASM binary size increases marginally.
- Auto-linker adds O(n) work per import (scan all records within a 15-minute window). Acceptable at MVP scale (<1000 records); needs an index (by `recorded_at`) when the catalog exceeds ~5000 records.
- Graph reconstruction is done client-side on every render of `ProvenanceGraph` — needs memoization (`useMemo`) to avoid O(n²) re-renders in large catalogs.
- Phantom nodes can accumulate if the matching Zoom record is later deleted — requires a cleanup pass when records are removed.
- Because Loom has no API, the "Loom sibling exists" signal only appears after a curator manually imports the Loom video. The upgrade prompt (add / replace / ignore) then requires an explicit admin decision — it cannot be automated.

---

## Loom Upgrade Policy

When a Loom recording is imported for a session that was already published via automated backfill (Fireflies or Zoom source), the system presents the admin with an explicit upgrade prompt rather than acting automatically:

```
Session: "Vibe Coding #42 — 2026-03-04"
Already published: Fireflies → YouTube (unlisted)

A Loom recording is now available for this session.
Loom recordings are typically edited and have hesitation phrases removed.

[ Add to YouTube alongside existing ]   [ Replace existing YouTube video ]   [ Ignore ]
```

**Add**: publishes the Loom recording as a second YouTube video. Both remain live. Useful when the Fireflies version has already accumulated views or comments.

**Replace**: unpublishes (or deletes) the Fireflies-sourced YouTube video and publishes the Loom version in its place, preserving the original title and privacy setting. The old YouTube `video_id` is recorded in the provenance graph as a superseded destination.

**Ignore**: dismisses the prompt. The Loom record remains in the catalog at `Approved` status but is not published. The prompt does not reappear unless the admin manually opens the provenance view for that session.

The automated backfill orchestrator (ADR-016) never publishes a Loom record automatically — Loom records always require this explicit admin action.

---

## Implementation Plan

### Tier 1 — Data model + manual linking (current sprint)

1. **Rust / WASM**: Add `UpstreamLink`, `DerivationType`, `LinkOrigin` to `value_objects.rs`. Add `upstream_links: Vec<UpstreamLink>` and `rejected_links: Vec<RejectedLink>` to `VideoRecord`. Implement `link_upstream` and `unlink_upstream` commands.
2. **TypeScript types**: Extend `VideoRecordJSON` and `PlatformLocationJSON` with the new fields.
3. **Auto-linker**: `web/src/lib/provenanceLinker.ts` — `autoLink(incoming: VideoRecordJSON, catalog: VideoRecordJSON[]): UpstreamLink[]`. Used by `ZoomImport` and `FirefliesImport` after each batch import.
4. **UI — per-card**: Add a "Provenance" toggle to `VideoCard` that shows upstream links inline (text list, no graph at this tier).
5. **UI — manual link dialog**: A `LinkUpstreamDialog` component — search existing records by title/date, select one, choose relation type, confirm.

### Tier 2 — Graph visualization

6. **`ProvenanceGraph` component**: CSS column layout with chevron connectors.
7. **Global Provenance tab**: Added to the main dashboard tab bar.
8. **Auto-linker integration with Fireflies**: Extract `zoom_meeting_id` from Fireflies GraphQL response; use as high-confidence link signal.

### Tier 3 — Scale

9. **Indexed `recorded_at` lookup**: Replace O(n) scan with a sorted index when catalog > 5000 records.
10. **Server-side graph endpoint**: `GET /api/provenance/graph` for multi-user read models.

---

## References

- ADR-002: Unified Video Metadata Schema (VideoRecord structure)
- ADR-005: Source Integration Strategy (Fireflies `zoom_meeting_id` in GraphQL response)
- ADR-008: DDD Bounded Contexts (Catalog context is the owner of provenance data)
- ADR-011: MVP Credential Proxy (`account_id` passed from browser credentials at import time)
