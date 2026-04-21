# ADR-035: Persistence Topology and Single-Browser Constraint

**Status**: Accepted (describes current behaviour; sequences future work)
**Date**: 2026-04-21
**Deciders**: Architecture Team
**Scope**: All storage decisions (ADR-011, ADR-016, ADR-017, ADR-018, ADR-031, plus this ADR)

---

## Context

The app has accumulated storage responsibilities across several ADRs without a single place naming what lives where. This ADR fills that gap and commits to a sequence of future migrations.

The operator asked a direct question on 2026-04-21:

> The dependency on localStorage — what is the extent of this? Is anything saved server side such that use from a different browser or user provides a common view?

The short answer: **the app today is effectively single-user, single-browser**. A different browser opens to an empty catalog. This ADR documents why, what's durable, and the levelled plan to change it.

---

## Current topology (2026-04-21)

### Client-side (browser localStorage — per browser, not shared)

| Key | What it holds | If a different browser opens |
|-----|---------------|------------------------------|
| `video-sync:records` | **The video catalog.** WASM-serialised `VideoRecord` JSON per video. | Empty — no videos |
| `video-sync:transcripts` | Full transcript text, stored out-of-band to keep the WASM heap lean | Empty — no transcripts |
| `video-sync:connections` | Zoom / YouTube / Fireflies / Loom / Kaltura / OpenRouter / OpusClip credentials (ADR-011) | Empty — must re-authorise every platform |
| `video-sync:rules` / `:processing-rules` / `:post-processing-rules` | Cached copies; server is authoritative (ADR-031) | Re-synced from server on boot |
| `video-sync:backfill-profiles` / `:backfill-queue` / `:backfill-state` | Profiles + queue + client-tracked quota | Empty except quota which re-syncs from server |
| `video-sync:exclusions` | Operator's "don't re-import this" list | Empty |
| `video-sync:eventlog` | Structured log buffer (last 500 entries) | Empty |
| `video-sync:yt-privacy` / `:yt-uploads` | YouTube privacy + uploads cache (1-hour TTL) | Empty; one click to refill via Fill Privacy / Auto-lookup |
| `video-sync:rejected-yt-matches` / `:rejected-sibling-matches` | "Not a match" dismissals (ADR-033) | Empty — rejections reappear as suggestions |
| `video-sync:import-tab` | UI: last-selected source tab | Defaults to Fireflies |

### Server-side (four files in `/app/data/`, currently ephemeral)

| File | Written by | Authoritative? |
|------|-----------|----------------|
| `data/rules.json` | `POST /api/rules` (ADR-031) | Yes — but clients also cache in localStorage and re-POST on boot |
| `data/backfill-state.json` | `POST /api/backfill/state` | Yes for `uploads_today` quota accounting |
| `data/server.log` | `serverLogger.ts` | No — Cloud Logging captures stdout, this file is a dev convenience |
| `/tmp` (upload scratch) | `/api/youtube/upload` | No — single-request lifetime |

**Critical caveat**: Cloud Run's filesystem is ephemeral without the GCS FUSE mount. ADR-018 specified that mount; it is **not currently active** (see ADR-018 addendum for the IAM blocker). Consequence: even the "authoritative" files above are wiped on every cold start, with the client localStorage re-push paper-covering the rules loss.

### External state owned outside the app

Not everything needs to be in our storage. These live on the platform they belong to:

- YouTube Data API: the canonical destination metadata (title, description, privacy, upload date)
- Zoom / Fireflies: the canonical source recordings and transcripts
- Cloud Logging: structured log history (indefinitely, via Log Router)
- Google Cloud Build / Artifact Registry: build + image history

---

## The single-browser constraint

Because the catalog itself is in browser localStorage:

- Opening the app on a second browser shows **no videos**. Operators would have to re-run imports.
- Two operators on the same URL do not see each other's work. Each operates on a parallel catalog with shared rules.
- "Switching browsers" (e.g. laptop → phone) is not a supported workflow — the catalog doesn't travel.
- Operator exclusions, rejections, and the privacy cache are per-browser and rebuild naturally as the operator interacts.

This constraint is **acceptable for MVP** because there's one operator and they mostly use one machine. It is **not acceptable** as a long-term position if any of the following become true:

- More than one operator curates simultaneously.
- The operator needs device mobility.
- The app is exposed to viewers or contributors beyond the curator.
- Browser storage corruption, extension conflicts, or accidental `Clear site data` wipes the catalog.

---

## Decision: four-level sequencing

State migration is sequenced from cheapest/lowest-risk to most complex:

### Level 1 — Activate GCS FUSE mount for `/app/data` (blocked on IAM)

**Target state**: the existing server-side files (`rules.json`, `backfill-state.json`, `server.log`) survive Cloud Run revisions, cold starts, and instance shutdowns.

**Scope**:
- Create `gs://video-sync-data-agentics-487016` in `us-central1`
- Grant runtime SA `roles/storage.objectUser`
- Add `--execution-environment=gen2` + `--add-volume` + `--add-volume-mount` to `deploy.sh`

**Blocker**: operator account lacks `roles/serviceusage.serviceUsageAdmin` and `roles/storage.admin`. Setup script (`scripts/gcs-fuse-setup.sh`) is ready; waiting on IAM grant or admin to run it. ADR-018 addendum documents the specifics.

**Scope explicitly excluded from Level 1**: the catalog, credentials, rejections, caches. All remain in localStorage.

### Level 2 — Move the video catalog to the server

**Target state**: two browsers on the same URL see the same list of videos.

**Scope**:
- New API: `GET /api/catalog` (paginated), `POST /api/videos` (upsert), `DELETE /api/videos/:id`
- Server-side storage: JSON file initially (in the FUSE-mounted `data/catalog.json`), migrate to SQLite at Tier 2 (ADR-016) when queries get expensive
- Client-side: `videoStore` becomes an HTTP-backed cache rather than the source of truth. localStorage remains as offline cache with last-sync timestamp.
- Conflict resolution: last-writer-wins on the aggregate root. WASM event sourcing already produces deterministic state; server becomes the canonical event log.
- Transcripts move to the server alongside the catalog — but remain fetchable lazily so they're not included in the initial `GET /api/catalog` payload.

**Tradeoffs**:
- Positive: multi-browser catalog view, durable across storage wipes, supports the "Find duplicates" scan (ADR-033 Q3) across the whole corpus instead of just one browser's view.
- Negative: every status transition becomes a network round-trip. Offline operation degrades (though the localStorage cache keeps the UI responsive).
- Negative: publishing to YouTube still needs credentials, which are still browser-local — so the *publish* workflow remains single-browser even after catalog is shared.

**Depends on**: Level 1 (for durable server storage).

### Level 3 — Move credentials to server-side Secret Manager

**Target state**: OAuth tokens and API keys live on the server; any authenticated browser can drive the publish pipeline.

**Scope**:
- Per-operator Secret Manager entries keyed by operator identity (see Level 4 — this level is meaningless without per-operator identity)
- Server-side encrypted credential vault (Google Secret Manager already GA)
- Replace the ADR-011 pattern: API routes read credentials from the vault using the caller's identity, not from the request body
- Client `ConnectionsPanel` becomes a write-through to the vault; no localStorage mirror

**Tradeoffs**:
- Positive: publish from any authenticated browser; credentials survive browser wipes; XSS in the app can no longer exfiltrate OAuth refresh tokens.
- Negative: significant security-surface expansion. Credential rotation, revocation, audit logging, scoping.
- Negative: requires Level 4 (identity) as a prerequisite — otherwise "server-side credentials" is just "credentials for whoever can reach the URL," which is worse.

**Depends on**: Level 4.

### Level 4 — Multi-user identity + per-user state

**Target state**: the app has real user accounts, not just "whoever can reach the URL."

**Scope**:
- Identity-Aware Proxy (IAP) or similar on the Cloud Run service — or an app-level OAuth with allowlist
- `Users` concept in the domain model
- Row-level authorisation: which user can see / edit / publish which video
- Per-user exclusions, rejections, privacy caches
- Audit log of who did what (event sourcing makes this free; just needs actor attribution actually enforced instead of the current hard-coded `ADMIN_ACTOR`)

**Tradeoffs**:
- Positive: real multi-user workflows. Compliance (ADR-022) gets real attribution. Rejections are per-user (your "Not a match" doesn't affect someone else's suggestions).
- Negative: largest scope of the four levels. Touches the domain model, auth, UI, every API route. Probably a quarter-length project.

**Depends on**: Level 2 (can't do per-user state without server-side state).

---

## Consequences

### Positive

- The topology is now documented in one place instead of scattered across ADRs 011/016/017/018/031/033.
- Future work has a clear sequence with explicit dependencies: Level 1 (unblock-ready), Level 2 (next major), Levels 3+4 (a project).
- The single-browser constraint is named explicitly so operators and future reviewers know what they're working inside.

### Negative

- Committing to a sequence constrains some "jump ahead" shortcuts. E.g. we won't implement per-user rejection lists before multi-user identity.
- The ADR is descriptive of the current state, not purely prescriptive; if the team disagrees with the sequencing, this ADR needs revisiting.

### Risks

- **Operator expectation drift**: once one of the Level-2+ features is on the roadmap, operators may expect multi-browser behaviour before it ships. Mitigation: in-app banner / about page noting the current constraint.
- **localStorage corruption today** would wipe the catalog. Mitigation: the Export feature (download .jsonl of structured log) exists for event-log recovery; add a "Export catalog" dump for the video records as a pre-Level-2 safety net.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **Move everything to the server in one go** | Too large; blocks all other work. Also creates a security-surface delta (Level 3) without the identity to support it (Level 4). |
| **Stay single-browser forever, document as permanent** | Operator's own question implied expectation of eventual multi-browser access. Not aligned with where the product wants to go. |
| **Use IndexedDB instead of localStorage** | Bigger quota, same browser-locality problem. Doesn't address the multi-browser question at all. |
| **Sync catalog between browsers via CRDT / WebRTC** | Much higher complexity than server-side catalog; CRDT conflict resolution is overkill when we already have event-sourced domain commands. |
| **Skip Level 1 (FUSE) and go straight to Level 2** | FUSE is blocked-on-IAM, not blocked-on-effort. It's the cheapest durability fix and unblocks quota tracking independently of catalog migration. No reason to skip. |

---

## References

- **ADR-011**: MVP Credential Proxy Pattern — the pattern Level 3 replaces.
- **ADR-016**: Retrospective Backfill Uploader — Tier 2 migration to SQLite anticipates Level 2.
- **ADR-017**: Observability & Structured Logging — stdout capture means `server.log` loss on ephemeral filesystem is not critical.
- **ADR-018**: Google Cloud Hosting — the FUSE mount spec lives here; addendum documents its deferred state (Level 1 blocker).
- **ADR-031**: Server-Side Rule Persistence — first server-side state; template for Level 2's catalog migration.
- **ADR-033**: Multi-origin dedupe — the "Find duplicates" scan in Q3 benefits significantly from Level 2.
