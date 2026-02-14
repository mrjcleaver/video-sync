# ADR-009: Checklist-Based Video Curation

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-02-14 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The initial design assumed that all ingested videos would immediately be searchable and publishable. In practice, organizations ingest far more video than they intend to distribute. A weekly team of 20 people generates dozens of Zoom recordings, most of which are internal-only and should never reach YouTube or Kaltura.

Users need an explicit **curation step** between ingestion and publishing — a checklist where they can review all discovered videos and decide which ones are worth pushing downstream.

## Decision

We will introduce a **curation checklist** as the primary workflow between the Ingestion and Publishing contexts:

### 1. Checklist as the Default Landing State

All newly ingested videos land in the checklist with status `DISCOVERED`. This is the initial state — the video is visible in the catalog but **not yet eligible for publishing**.

### 2. Curation Actions

A curator (ADMIN or PUBLISHER role) reviews the checklist and takes one of two actions per video:

- **Approve**: Marks the video as `APPROVED`, making it eligible for publishing to destination platforms. The curator may edit metadata (title, description, tags) at this point.
- **Skip**: Marks the video as `SKIPPED`, indicating it should not be published. Skipped videos remain in the catalog for search but are filtered out of the publish-ready view.

### 3. Updated Video Lifecycle

```
DISCOVERED ──> APPROVED ──> PUBLISHING ──> PUBLISHED
     │              ^            │
     v              │            v
  SKIPPED ──────────┘         FAILED ──> APPROVED (retry)
```

- `DISCOVERED`: Just ingested, awaiting curation.
- `APPROVED`: Curator has reviewed and approved for publishing.
- `SKIPPED`: Curator has decided not to publish (reversible).
- `PUBLISHING`: Active transfer in progress.
- `PUBLISHED`: Successfully delivered to a destination.
- `FAILED`: Transfer failed (retries exhausted); can be re-approved.

### 4. Checklist View

The dashboard (US-1) presents the checklist grouped by:
- **Needs Review**: Videos in `DISCOVERED` state, sorted by `created_at` descending.
- **Approved**: Videos in `APPROVED` state, ready to be pushed.
- **Published**: Videos in `PUBLISHED` state, with destination links.
- **Skipped**: Collapsed section of `SKIPPED` videos (can be re-approved).

### 5. Bulk Actions

The checklist supports bulk operations:
- Select multiple videos and approve or skip them in one action.
- Select multiple approved videos and publish them to the same destination in one batch.

## Consequences

### Positive
- Prevents accidental publishing of internal-only content.
- Gives curators explicit control over what reaches external platforms.
- The checklist serves as a natural review queue, making the dashboard immediately useful even before any publishing is configured.
- Bulk actions reduce the effort for high-volume organizations.

### Negative
- Adds a manual step to the pipeline — no video is auto-published without curation.
- Organizations that want fully automated publishing must approve videos manually (or a future auto-approve rule engine can be added).

### Future Considerations
- **Auto-Approve Rules**: A rule engine could auto-approve videos matching certain criteria (e.g., "all Loom videos from the marketing team"). This is intentionally deferred — start manual, automate later.
- **Approval Workflows**: Multi-step approval (review -> approve -> final sign-off) could be layered on top of this model if needed.
