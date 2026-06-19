# Domain-Driven Design (DDD) — Video Bridge

This directory contains the Domain-Driven Design artifacts for the **Unified Video Indexing & Publishing Bridge** (VID-BRIDGE-01).

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Video Record** | The normalized metadata representation of a video from any source platform. |
| **Source Platform** | An external service that originates video content. Currently: Zoom (server-to-server OAuth + webhooks), Fireflies (API key), YouTube Live (per-operator brand account), Kaltura (admin secret), and Loom (manual URL only — vendor dropped API access). |
| **Destination Platform** | An external service where video content is published. Currently: YouTube (per-operator brand account) and Kaltura (org-shared). |
| **Ingestion** | The process of discovering and importing video metadata from a source platform. |
| **Publishing** | The process of transferring a video file from a source to a destination platform. |
| **Publish Job** | A unit of work representing a single video transfer operation. |
| **Source Connection** | A configured link to a source platform, including credentials and polling settings. |
| **Destination Connection** | A configured link to a destination platform, including credentials and upload settings. |
| **Catalog** | The searchable index of all video records. |
| **Curation Checklist** | The review queue where all discovered videos land. Curators approve or skip items before they can be published (ADR-009). |
| **Discovered** | A video that has been ingested but not yet reviewed by a curator. |
| **Approved** | A video that a curator has reviewed and marked as eligible for publishing. |
| **Skipped** | A video that a curator has decided not to publish. Reversible. |
| **Curator** | A user (ADMIN or PUBLISHER role) who reviews the checklist and approves/skips videos. |
| **Note** | An internal annotation attached to a video by a curator, owner, or moderator. Not published to destinations. |
| **Owner** | A user responsible for a video's content. Derived initially from the source platform (e.g., meeting organizer). Conceptually can manage the video and assign moderators. *Not yet modelled as a first-class entity — currently derived ad-hoc from `VideoRecord.host_email`.* |
| **Moderator** | A user granted permission to curate (approve/skip), annotate, and edit metadata on a specific video. *Not yet modelled as a first-class entity — current authorization is role-based via Cloud Identity Groups (ADR-036) rather than per-video grants.* |
| **Transcript** | The text transcription of a video's audio content. |
| **Artifact** | A human-readable resource (transcript, description, summary, chat log) persisted to a Workspace Shared Drive so operators and content owners can edit it outside the app (ADR-039). |
| **Audit Log** | The append-only stream of API request entries (actor, route, classification = `access` or `mutation`, request id, latency). Surfaced to Cloud Logging and the in-app EventLog within ~8 seconds (ADR-041). |
| **Backfill Profile** | A named, org-shared configuration describing how to import a historical window of recordings (source, date range, filters). Shared across operators by ADR-043. |
| **Backfill Queue** | The org-shared queue of pending backfill items awaiting processing — visible and editable by any operator (ADR-043). |
| **Exclusion** | An org-shared rule that prevents a meeting/recording from being ingested or approved (e.g., 1:1s, recurring stand-ups). Shared across operators by ADR-043. |
| **Sibling Suggestion** | A candidate match between two `VideoRecord`s computed via Jaccard scoring (ADR-033) — used to merge duplicates discovered across platforms. |
| **Brand Account** | A YouTube channel attached to a Google Workspace user via the YouTube *Brand Account Access* mechanism. Video Bridge uploads to YouTube as the operator's brand account, so each upload carries that operator's identity (ADR-042 §"YouTube brand account"). |
| **Side-Publish** | Publishing the same `VideoRecord` to a secondary destination (typically Kaltura) in addition to YouTube. |

## Bounded Contexts

See [ADR-008](../adr/ADR-008-ddd-bounded-contexts.md) for the architectural decision.

| Context | Directory | Description |
|---------|-----------|-------------|
| [Ingestion](bounded-contexts/ingestion.md) | `src/ingestion/` | Source platform adapters and video discovery |
| [Catalog](bounded-contexts/catalog.md) | `src/catalog/` | Unified video index, curation checklist, and search |
| [Publishing](bounded-contexts/publishing.md) | `src/publishing/` | Destination platform uploads and job management |
| [Identity](bounded-contexts/identity.md) | `src/identity/` | Users, tenants, and credential management |

## Aggregates

| Aggregate | Context | Description |
|-----------|---------|-------------|
| [VideoRecord](aggregates/video-record.md) | Catalog | Central video metadata entity |
| [PublishJob](aggregates/publish-job.md) | Publishing | Video transfer work unit |
| [SourceConnection](aggregates/source-connection.md) | Ingestion | Source platform configuration |
| [DestinationConnection](aggregates/destination-connection.md) | Publishing | Destination platform configuration |

## Domain Events

| Event | Producer | Consumer(s) | Description |
|-------|----------|-------------|-------------|
| [VideoDiscovered](domain-events/video-discovered.md) | Ingestion | Catalog | A new video was found on a source platform |
| [VideoIndexed](domain-events/video-indexed.md) | Catalog | — | A video was added to the searchable index |
| [VideoApproved](domain-events/video-approved.md) | Catalog | — | A curator approved a video for publishing |
| [VideoSkipped](domain-events/video-skipped.md) | Catalog | — | A curator skipped a video from the checklist |
| [PublishRequested](domain-events/publish-requested.md) | UI / API | Publishing | A user requested publishing an approved video |
| [PublishCompleted](domain-events/publish-completed.md) | Publishing | Catalog | A video was successfully published |
| [PublishFailed](domain-events/publish-failed.md) | Publishing | Catalog | A publish attempt failed |
| [CredentialInvalidated](domain-events/credential-invalidated.md) | Identity | Ingestion, Publishing | A platform credential became invalid |

## Context Map

```
                       ┌──────────────────────────────────────────────────────────────┐
                       │                       VIDEO BRIDGE                           │
                       │                                                              │
  Zoom (S2S OAuth) ──┐ │  ┌─────────────┐   VideoDiscovered   ┌──────────────┐       │
  Fireflies (API)  ──┤ │  │  INGESTION  │ ──────────────────> │   CATALOG    │       │
  YouTube Live ─────┤ ├─>│   CONTEXT   │                     │   CONTEXT    │       │
  Kaltura (admin)  ──┤ │  │             │                     │  ┌────────┐  │       │
  Loom (URL only)  ──┘ │  └──────┬──────┘                     │  │CURATION│  │       │
                       │         │                            │  │CHECKLIST│ │       │
                       │         │ getToken()                 │  └───┬────┘  │       │
                       │         │                            └──────┼───────┘       │
                       │         │                                   │ approve       │
                       │         │                                   v then          │
                       │         │                                   publish         │
                       │  ┌─────────────┐                     ┌──────────────┐       │     ┌──> YouTube (brand account)
                       │  │  IDENTITY   │ <────────────────── │  PUBLISHING  │ ──────┼─────┤
                       │  │   CONTEXT   │      getToken()     │   CONTEXT    │       │     └──> Kaltura (side-publish)
                       │  │ (IAP+Groups)│                     │              │       │
                       │  └─────────────┘                     └──────┬───────┘       │
                       │         ▲                                   │               │
                       │         │ audit (actor, route)              │ artifact      │
                       │         │                                   │ (transcript,  │
                       │  ┌──────┴───────┐                           v  description) │
                       │  │  AUDIT LOG   │                  ┌──────────────────┐    │
                       │  │ (ADR-041)    │                  │ Workspace Shared │    │
                       │  └──────────────┘                  │ Drive (ADR-039)  │    │
                       │                                    └──────────────────┘    │
                       └──────────────────────────────────────────────────────────────┘
```

Notes:
- **Loom** is shown as a source for completeness but only enters via manual URL submission — the vendor has dropped API access (see ADR top-level decisions and `docs/guide.md`). All Loom enrichment (`createdAt`, transcript, owner, chapters) is scraped from the public Apollo state.
- **Identity Context** is fronted by Google Cloud IAP plus Cloud Identity Groups (ADR-036). Audit entries are emitted for every API call (ADR-041).
- **Backfill Profile / Queue / Exclusions** are org-shared catalog projections persisted via the Catalog Context (ADR-043).
