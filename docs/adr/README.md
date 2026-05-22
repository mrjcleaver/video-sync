# Architecture Decision Records (ADRs)

This directory contains the Architecture Decision Records for **video-sync** (a.k.a. the **Unified Video Indexing & Publishing Bridge**, VID-BRIDGE-01).

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](ADR-001-event-driven-ingestion.md) | Event-Driven Architecture for Video Ingestion | Accepted |
| [ADR-002](ADR-002-unified-video-metadata-schema.md) | Unified Video Metadata Schema | Accepted |
| [ADR-003](ADR-003-async-job-queue-transfer.md) | Async Job Queue for Video Transfer Pipeline | Accepted |
| [ADR-004](ADR-004-temporary-storage-strategy.md) | Temporary Storage Strategy for Video Binaries | Accepted |
| [ADR-005](ADR-005-source-integration-strategy.md) | Source Platform Integration Strategy | Accepted |
| [ADR-006](ADR-006-search-engine-selection.md) | Search Engine for Full-Text Video Search | Accepted |
| [ADR-007](ADR-007-oauth2-token-management.md) | OAuth 2.0 and API Token Management | Accepted |
| [ADR-008](ADR-008-ddd-bounded-contexts.md) | Domain-Driven Design Bounded Contexts | Accepted |
| [ADR-009](ADR-009-checklist-curation.md) | Checklist-Based Video Curation | Accepted |
| [ADR-010](ADR-010-authentication-configuration.md) | Authentication Configuration for External Services | Proposed |
| [ADR-011](ADR-011-mvp-credential-proxy.md) | MVP Credential Proxy Pattern | Accepted |
| [ADR-012](ADR-012-youtube-publish-integration.md) | YouTube Publish Integration | Proposed |
| [ADR-013](ADR-013-batch-ingestion-rules-engine.md) | Batch Ingestion with Rules Engine and Operator Memory | Proposed |
| [ADR-014](ADR-014-publishing-attribute-processing-rules.md) | Publishing Attribute Processing Rules | Proposed |
| [ADR-015](ADR-015-fireflies-import-integration.md) | Fireflies.ai Import Integration | Proposed |
| [ADR-016](ADR-016-retrospective-backfill-uploader.md) | Retrospective Backfill Uploader | Proposed |
| [ADR-017](ADR-017-observability-and-structured-logging.md) | Observability and Structured Logging | Accepted |
| [ADR-018](ADR-018-google-cloud-hosting.md) | Google Cloud Hosting | Proposed |
| [ADR-019](ADR-019-video-provenance-graph.md) | Video Provenance Graph | Proposed |
| [ADR-020](ADR-020-import-ux-preview-title-and-destination.md) | Import UX Enhancements — Preview Title Display and Destination Visibility | Accepted |
| [ADR-021](ADR-021-zoom-origin-preference-and-fireflies-trim.md) | Zoom Origin Preference and Fireflies Pre-Run Trim | Accepted (policy) / Proposed (trim feature) |
| [ADR-022](ADR-022-youtube-description-provenance-footer.md) | YouTube Description Provenance Footer | Accepted |
| [ADR-023](ADR-023-pre-processing-trim-to-boundary.md) | Pre-processing Trim-to-Boundary Rule | Accepted |
| [ADR-024](ADR-024-post-processing-webhook-and-email.md) | Post-processing Rules — Webhook and Email Notification | Accepted |
| [ADR-025](ADR-025-loom-source-integration.md) | Loom Source Integration | Accepted |
| [ADR-026](ADR-026-production-domain.md) | Production Domain — videosync.agentics.org | Accepted |
| [ADR-027](ADR-027-youtube-source-ingestion.md) | YouTube as a Source for Video Ingestion | Proposed |
| [ADR-028](ADR-028-youtube-download-reupload-policy.md) | YouTube Download and Re-upload Policy | Accepted |
| [ADR-029](ADR-029-auto-shorts-generation.md) | Automated Short-Form Clip Generation | Proposed |
| [ADR-030](ADR-030-build-version-api.md) | Build Version API Endpoint | Accepted |
| [ADR-031](ADR-031-server-side-rule-persistence.md) | Server-Side Rule Persistence | Accepted |
| [ADR-032](ADR-032-runtime-memory-pressure-detection.md) | Runtime Memory Pressure Detection | Proposed |
| [ADR-033](ADR-033-multi-origin-dedupe-and-live-streams.md) | Multi-Origin Deduplication, Description Enrichment, and Live-Stream Semantics | Proposed (exploration) |
| [ADR-034](ADR-034-chat-query-mcp-for-live-broadcasts.md) | MCP Server for Querying Live-Broadcast Chat Messages | Proposed (exploration) |
| [ADR-035](ADR-035-persistence-topology-and-single-browser-constraint.md) | Persistence Topology and Single-Browser Constraint | Accepted (describes current behaviour; sequences future work) |
| [ADR-036](ADR-036-google-workspace-authentication.md) | Google Workspace Authentication and Role-Based Access | Accepted (live as of 2026-04-27, Cloud Run revision `video-sync-00035-lqq`) |
| [ADR-037](ADR-037-kaltura-publish-integration.md) | Kaltura Publish Integration | Proposed |
| [ADR-038](ADR-038-build-cache-hygiene.md) | Build Cache Hygiene and Disk Reclamation | Accepted |
| [ADR-039](ADR-039-drive-based-artifact-storage.md) | Drive-Based Artifact Storage for Transcripts, Descriptions, Summaries, and In-Meeting Chat | Accepted (implemented 2026-04-30 through three slices: storage + artifacts API, webhook payload, Zoom CHAT capture) |
| [ADR-040](ADR-040-broaden-source-imports.md) | Broaden Source Imports — Kaltura, YouTube Live, Multi-Origin Per Date | Accepted (implemented 2026-04-30) |
| [ADR-041](ADR-041-app-level-audit-log.md) | App-Level Audit Log of Access and Mutation Attempts | Accepted (implemented 2026-05-01) |
| [ADR-042](ADR-042-server-side-credentials-with-operator-override.md) | Server-Side Credentials With Operator Override | Accepted (Phases 1+2 implemented 2026-05-01; Phase 3 cache-flush + Phase 4 migration helpers deferred) |
| [ADR-043](ADR-043-share-backfill-state-and-exclusions.md) | Share Backfill Profiles, Queue, and Exclusions Across Operators | Accepted (implemented 2026-05-02) |
| [ADR-044](ADR-044-always-show-kaltura-presence.md) | Always Show Kaltura Presence Alongside YouTube | Accepted (implemented 2026-05-22 — referenceId + provenance-footer match; fuzzy match deferred) |
| [ADR-045](ADR-045-redirect-unauthorized-to-wiki.md) | Wider IAP Gate + App-Level Redirect for Unauthorized Users | Accepted (implemented 2026-05-22) |

## ADR Format

Each ADR follows the standard format:
- **Status**: Proposed / Accepted / Deprecated / Superseded (some records are marked *Proposed (exploration)* for design ADRs that don't commit to an implementation)
- **Context**: The forces at play
- **Decision**: What we decided
- **Consequences**: The resulting context

Addenda may be appended to an ADR when the decision evolves in a way that doesn't invalidate the original — see ADR-012, ADR-016, ADR-017, ADR-018 for examples.

## Regenerating this index

This file is generated from the ADR headers. To refresh after adding or editing ADRs:

```bash
bash scripts/gen-adr-index.sh
```

Commit the result alongside the ADR change.
