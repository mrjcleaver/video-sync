# Video Bridge: Mission and Vision

## Mission

Video Bridge exists to give organizations a single, authoritative catalog of their video content — no matter where that content was recorded, edited, or published.

Teams produce video constantly: Zoom meetings, Fireflies transcriptions, Loom walkthroughs, webinar recordings. These recordings scatter across platforms with no unified view of what exists, what's been reviewed, or what's been published. Video Bridge solves this by providing a discovery-to-publication pipeline that indexes video from source platforms, lets curators review and approve content through a rules-driven workflow, publishes approved videos to destination platforms like YouTube, and tracks the full provenance chain across every platform a video touches.

## Vision

**Every organizational video has a known location, a known status, and a clear chain of custody.**

In practice this means:

1. **Zero video goes missing.** If it was recorded on Zoom, imported to Fireflies for transcription, edited in Loom, and published to YouTube — Video Bridge knows about all four locations and how they relate.

2. **Curation scales without manual overhead.** Rules engines handle the bulk triage (scope by day-of-week, duration, title pattern, participants). Operators review only the exceptions.

3. **Publication is repeatable and auditable.** Every published video carries provenance metadata linking it back to its source. Post-processing webhooks and notifications keep downstream systems informed.

4. **The system grows with the organization.** Start with a single operator importing Zoom recordings. Scale to automated backfill of 18 months of content with quota-aware orchestration. Add Shorts generation. Add new source platforms via the adapter pattern.

## Guiding Principles

| Principle | What it means in practice |
|-----------|--------------------------|
| **Source of truth** | The Video Bridge catalog is the canonical record of where every video exists. Platform-specific dashboards are views; Video Bridge is the index. |
| **Human in the loop** | Automation handles discovery and triage. Publication always requires explicit approval (or an explicit auto-approve rule). No video reaches YouTube without a deliberate decision. |
| **Provenance first** | Every video tracks its origin, intermediates (edits, transcriptions), and destinations. The provenance graph is not optional — it is the core data model. |
| **Progressive automation** | Start manual, add rules as patterns emerge. Ingestion rules for scoping, processing rules for metadata templating, post-processing rules for notifications. Each layer is optional. |
| **Platform agnostic** | Source and destination adapters are pluggable. Adding a new platform means implementing an adapter, not redesigning the pipeline. |
| **Operator visibility** | Structured logging, memory pressure monitoring, quota tracking, and an in-app event log ensure the operator always knows what happened and why. |

## Where this stands today

Pieces of the vision that have shipped and now shape the system's character:

- **Multi-destination publishing.** YouTube (per-operator brand-account OAuth so uploads carry the actual operator's identity for accountability) **and** Kaltura (org-shared admin credential). Kaltura is also a source — operators can import existing Kaltura entries, including live broadcasts streamed via OBS/Streamyard/Wirecast (ADR-040).
- **Org-shared state.** Video catalog, transcripts, ingestion / processing / post-processing rules, backfill profiles + queue, and exclusions all live on the server (a FUSE-mounted GCS bucket and a Workspace Shared Drive for human-readable artifacts). Two operators on the same URL see the same view (ADR-035 L1+L2, ADR-039, ADR-043).
- **Identity and audit.** Google Cloud IAP gates the door; roles (Admin / Publisher / Viewer) come from Cloud Identity Groups (ADR-036). Every API request emits an audit entry tagged `access` or `mutation` with the actor's email, surfaced both to Cloud Logging and to the in-app EventLog within 8 seconds (ADR-041).
- **Hybrid credentials.** Shared platform credentials (Zoom, Fireflies, Kaltura, OpenRouter, OpusClip) live in Google Secret Manager and are managed by Admins; operators can override locally if they need to use a personal account. YouTube remains per-operator on purpose (ADR-042).
