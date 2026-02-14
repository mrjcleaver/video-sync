# ADR-008: Domain-Driven Design Bounded Contexts

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-02-14 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The Video Bridge system spans multiple domains: ingesting videos from external platforms, maintaining a searchable index, and publishing to destination platforms. These concerns have different rates of change, different external dependencies, and different scaling characteristics.

Without clear boundaries, the codebase risks becoming a tightly coupled monolith where a Zoom API change could break the YouTube publishing logic.

## Decision

We will structure the system using **Domain-Driven Design (DDD)** with four bounded contexts:

### 1. Ingestion Context
- **Responsibility**: Discovering and fetching video metadata from source platforms.
- **Key Aggregates**: `SourceConnection`, `IngestionJob`
- **Domain Events Produced**: `VideoDiscovered`
- **External Dependencies**: Zoom API, Loom API, Fireflies GraphQL API

### 2. Catalog Context
- **Responsibility**: Storing, normalizing, and searching the unified video index.
- **Key Aggregates**: `VideoRecord`
- **Domain Events Consumed**: `VideoDiscovered`
- **Domain Events Produced**: `VideoIndexed`
- **External Dependencies**: PostgreSQL (storage + search)

### 3. Publishing Context
- **Responsibility**: Transferring video files to destination platforms and tracking publish status.
- **Key Aggregates**: `PublishJob`, `DestinationConnection`
- **Domain Events Consumed**: `PublishRequested` (from user action)
- **Domain Events Produced**: `PublishCompleted`, `PublishFailed`
- **External Dependencies**: YouTube API, Kaltura API, S3 temp storage

### 4. Identity Context
- **Responsibility**: User authentication, authorization, and tenant/credential management.
- **Key Aggregates**: `User`, `Tenant`, `PlatformCredential`
- **Domain Events Produced**: `CredentialInvalidated`
- **External Dependencies**: OAuth providers, secrets manager

### Context Mapping

```
┌─────────────────┐     VideoDiscovered     ┌──────────────────┐
│   INGESTION     │ ───────────────────────> │     CATALOG      │
│   CONTEXT       │                          │     CONTEXT      │
└─────────────────┘                          └──────────────────┘
        │                                            │
        │ uses credentials                           │ PublishRequested
        v                                            v
┌─────────────────┐                          ┌──────────────────┐
│   IDENTITY      │ <─────────────────────── │   PUBLISHING     │
│   CONTEXT       │     uses credentials     │   CONTEXT        │
└─────────────────┘                          └──────────────────┘
```

### Integration Patterns
- **Ingestion -> Catalog**: Async domain events via the job queue (Published Language pattern).
- **Catalog -> Publishing**: User-initiated command triggers a `PublishRequested` event.
- **Identity -> All**: Shared Kernel for credential access (the `TokenManager` is a shared service).

## Consequences

### Positive
- Each context can be developed, tested, and deployed independently.
- Source adapter changes (Ingestion) do not ripple into Publishing.
- Clear ownership boundaries for team scaling.
- Domain events provide a natural audit trail.

### Negative
- Cross-context queries (e.g., "show me all videos from Zoom that were published to YouTube") require joining data across contexts — handled via read models / materialized views.
- Shared Kernel (Identity) must maintain backwards compatibility as other contexts evolve.

### Future Considerations
- These bounded contexts can be extracted into separate microservices if scaling demands it, with the event bus upgraded to a distributed message broker (e.g., Kafka).
