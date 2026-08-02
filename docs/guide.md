# Video Bridge: legacy overview (archived)

> **⚠ This document is archived.** Its original content described an
> earlier architecture (Zoom webhooks, Fireflies / Loom polling, a Test
> Connection button, per-operator Kaltura credentials) that **no longer
> matches the deployed system**. New operators following it would set up
> integrations expecting features that don't exist.

For current behaviour, read instead:

- [`README.md`](../README.md) — what the app is, how to deploy, current-state summary
- [`docs/mission-and-vision.md`](mission-and-vision.md) — why the app exists
- [`docs/user-guide.md`](user-guide.md) — comprehensive feature walkthrough (connections, import, review, publish, backfill, recovery, what-lives-where)
- [`docs/user-flows.md`](user-flows.md) — step-by-step diagrams for common workflows
- [`docs/stakeholders.md`](stakeholders.md) — roles and touchpoints
- [`docs/capabilities.md`](capabilities.md) — capability matrix for comparison with other tools (status + ADR refs per row)
- [`docs/adr/`](adr/) — architectural decisions; start from the index in [`docs/adr/README.md`](adr/README.md)

Specific topics that moved on since this document was written:

| What you might be looking for | Where it lives now |
|---|---|
| How videos get into the catalog | `user-guide.md` §2 "Importing Videos" — all imports are operator-triggered (no background polling); Loom is URL-only after the vendor discontinued their public API in 2025 |
| Connections / credential setup | `user-guide.md` §1 "Connections" — shared defaults via Google Secret Manager (ADR-042), with per-operator override; YouTube is always per-operator (brand-account attribution) |
| Roles + access control | `ADR-036` (Google Workspace Authentication) — Admin / Publisher / Viewer derived from Cloud Identity Groups, gated by IAP |
| What lives where (server vs. browser) | `user-guide.md` §10 "What Lives Where" — catalog, transcripts, rules, backfill profiles + queue, exclusions all server-shared |
| Audit log | `ADR-041` (App-Level Audit Log) — surfaced both to Cloud Logging and the in-app EventLog |
| Show Notes prompt / Description strategy | `user-guide.md` §5 "Description Strategy (ADR-064)" and "Show Notes Prompt (ADR-046)" — both live on **Config** (formerly split across Maintain + code) |
| Fetching a transcript when the record has none | `user-guide.md` §12 "YouTube Transcript Fallback (ADR-063)" — progressive-reach captions API → InnerTube → yt-dlp cascade |
| Pushing local edits to the YouTube video | `user-guide.md` §12 "Push Title + Description to YouTube (ADR-064-adjacent)" — replaces the older Realign-and-push button |
