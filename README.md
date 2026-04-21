# Video Sync

A unified video indexing and publishing pipeline that discovers recordings on Zoom, Fireflies, Loom, and YouTube, lets a curator review and approve them, and publishes approved content to YouTube (with Kaltura and others as future destinations).

**Live**: [https://video-sync-667037737667.us-central1.run.app](https://video-sync-667037737667.us-central1.run.app)

The project is built as a Next.js 15 app with a Rust/WASM domain model. It runs on Google Cloud Run.

## What the app does

- **Import** video metadata from Zoom (OAuth), Fireflies (API), Loom, existing YouTube uploads, direct URLs, or manual entry
- **Triage** with a rules engine (day of week, duration, title patterns, participants, tags) — scope / auto-approve / auto-skip
- **Review** via a dashboard checklist with processing-rule previews, transcripts, notes, and per-video event logs
- **Publish** to YouTube with a resumable upload pipeline, title/description/tag templating, and quota-aware backfill orchestration over 18-month backlogs
- **Recover** videos whose upload SSE dropped or that were uploaded out-of-band, via auto-lookup against the authorized YouTube channel
- **Track provenance** across platforms (origin / intermediate / destination) with same-event sibling detection across sources
- **Generate shorts** via Opus Clip from published YouTube videos

## Repository layout

```
src/                  Rust domain model (compiled to WASM)
  catalog/            VideoRecord aggregate, value objects, events
web/                  Next.js app
  src/app/            App Router: pages + API routes
  src/components/     React components (VideoCard, BackfillPanel, …)
  src/lib/            Client-side libraries (store, processingRules, …)
  src/app/api/        Server-side API routes (Zoom, Fireflies, YouTube, …)
pkg/                  Built WASM artifacts (generated)
docs/                 User-facing and architectural documentation
  adr/                Architecture Decision Records (ADR-001…ADR-035)
scripts/              One-off utility scripts
deploy.sh             Manual deploy to Cloud Run
```

## Documentation

**Start here if you're a user:**

- [`docs/mission-and-vision.md`](docs/mission-and-vision.md) — what the app is for and why it exists
- [`docs/user-guide.md`](docs/user-guide.md) — comprehensive feature walkthrough (connections, import, review, publish, backfill, recovery)
- [`docs/user-flows.md`](docs/user-flows.md) — step-by-step diagrams of common workflows
- [`docs/stakeholders.md`](docs/stakeholders.md) — roles (Curator, Content Owner, Platform Admin, DevOps, Compliance)

**Start here if you're a developer:**

- [`CLAUDE.md`](CLAUDE.md) — project conventions for AI-assisted development
- [`docs/adr/`](docs/adr/) — all architectural decisions. Start with:
  - **ADR-002** Unified video metadata schema
  - **ADR-008** DDD bounded contexts
  - **ADR-011** MVP credential proxy pattern (why credentials live in the browser)
  - **ADR-016** Retrospective backfill uploader + Recover flow + multi-month Overview
  - **ADR-018** Google Cloud hosting
  - **ADR-033** Multi-origin dedupe and live-stream semantics
  - **ADR-034** MCP for querying live-broadcast chat (exploratory)
  - **ADR-035** Persistence topology and single-browser constraint ← read this to understand what's in localStorage vs. the server
- [`docs/guide.md`](docs/guide.md) — legacy short-form overview; prefer `docs/user-guide.md`

## Development

```bash
# Build the WASM domain model
wasm-pack build --target web --out-dir pkg

# Run the Next.js dev server
cd web && npm install && npm run dev

# Type-check and build for production
npm run build
```

Tests for the Rust domain live under `src/` (`cargo test`). The Next.js side has no test script wired today.

## Deployment

Deployment is currently manual via `./deploy.sh`. It builds the Docker image, pushes to Artifact Registry, and runs `gcloud run deploy`. Uses the operator's personal gcloud credentials because the project's org policy (`constraints/iam.disableServiceAccountKeyCreation`) blocks the GitHub Actions credentials_json path. The CI workflow (`.github/workflows/deploy.yml`) has its `push:` trigger commented out until Workload Identity Federation is wired up.

Before the first deploy on a new machine:

```bash
gcloud auth login
gcloud auth configure-docker us-central1-docker.pkg.dev
gcloud config set project agentics-487016
```

Then:

```bash
./deploy.sh
```

The script prints the Cloud Run service URL on success.

### Roll back

```bash
gcloud run services update-traffic video-sync \
  --region=us-central1 --to-revisions=<PREV_REVISION>=100
```

Cloud Run retains every revision — roll back via the console or the command above.

## Known constraints

- **Single-browser**: the video catalog lives in the browser's localStorage. Opening the app on a different browser shows an empty catalog. Rules are server-side and do sync. ADR-035 documents the four-level migration plan (FUSE mount → catalog to server → credentials to Secret Manager → multi-user identity).
- **`/app/data` is ephemeral**: the GCS FUSE mount specified in ADR-018 is not currently active (blocked on IAM permissions). In practice this means `backfill-state.json`'s `uploads_today` counter resets on every Cloud Run cold start.
- **YouTube API quota**: 10,000 units/day default. An upload costs 1,600 units (~6/day). Reads are 1 unit each. Check the ADR-012 and ADR-016 discussions for how the app works within this.

## License

Not yet licensed — this is an internal project. Discuss with the maintainer before using externally.
