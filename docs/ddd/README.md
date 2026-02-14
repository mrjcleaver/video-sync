# Domain-Driven Design (DDD) — Video Bridge

This directory contains the Domain-Driven Design artifacts for the **Unified Video Indexing & Publishing Bridge** (VID-BRIDGE-01).

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Video Record** | The normalized metadata representation of a video from any source platform. |
| **Source Platform** | An external service that originates video content (Zoom, Loom, Fireflies). |
| **Destination Platform** | An external service where video content is published (YouTube, Kaltura). |
| **Ingestion** | The process of discovering and importing video metadata from a source platform. |
| **Publishing** | The process of transferring a video file from a source to a destination platform. |
| **Publish Job** | A unit of work representing a single video transfer operation. |
| **Source Connection** | A configured link to a source platform, including credentials and polling settings. |
| **Destination Connection** | A configured link to a destination platform, including credentials and upload settings. |
| **Catalog** | The searchable index of all video records. |
| **Transcript** | The text transcription of a video's audio content. |

## Bounded Contexts

See [ADR-008](../adr/ADR-008-ddd-bounded-contexts.md) for the architectural decision.

| Context | Directory | Description |
|---------|-----------|-------------|
| [Ingestion](bounded-contexts/ingestion.md) | `src/ingestion/` | Source platform adapters and video discovery |
| [Catalog](bounded-contexts/catalog.md) | `src/catalog/` | Unified video index and search |
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
| [PublishRequested](domain-events/publish-requested.md) | UI / API | Publishing | A user requested publishing a video |
| [PublishCompleted](domain-events/publish-completed.md) | Publishing | Catalog | A video was successfully published |
| [PublishFailed](domain-events/publish-failed.md) | Publishing | Catalog | A publish attempt failed |
| [CredentialInvalidated](domain-events/credential-invalidated.md) | Identity | Ingestion, Publishing | A platform credential became invalid |

## Context Map

```
                    ┌───────────────────────────────────────────────────────────┐
                    │                     VIDEO BRIDGE                          │
                    │                                                           │
  Zoom ─────┐      │  ┌─────────────┐   VideoDiscovered   ┌──────────────┐    │
  Loom ─────┼──────┼─>│  INGESTION  │ ──────────────────> │   CATALOG    │    │
  Fireflies ┘      │  │   CONTEXT   │                     │   CONTEXT    │    │
                    │  └──────┬──────┘                     └──────┬───────┘    │
                    │         │                                    │            │
                    │         │ getToken()                         │ user       │
                    │         v                                    v publish    │
                    │  ┌─────────────┐                     ┌──────────────┐    │
                    │  │  IDENTITY   │ <────────────────── │  PUBLISHING  │    │     ┌──> YouTube
                    │  │   CONTEXT   │      getToken()     │   CONTEXT    │────┼─────┤
                    │  └─────────────┘                     └──────────────┘    │     └──> Kaltura
                    │                                                           │
                    └───────────────────────────────────────────────────────────┘
```
