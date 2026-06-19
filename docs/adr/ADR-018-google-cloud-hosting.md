# ADR-018: Google Cloud Hosting

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-03-05 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

The application is currently run in a local devcontainer. To make it available to operators who are not running a local environment, it needs to be hosted on a managed cloud platform. Google Cloud has been selected as the target cloud provider.

The application's current characteristics that constrain hosting choices:

| Characteristic | Detail |
|----------------|--------|
| Runtime | Next.js 15 (Node.js 20+), SSR + API routes |
| WASM module | Bundled into the Next.js client bundle — no server-side WASM concerns |
| File-based state | `data/backfill-state.json`, `data/server.log` — written by API routes |
| Client state | `localStorage` — purely browser-side, no server concern |
| Long-running requests | YouTube upload pipeline: up to 10 minutes per video (ADR-012) |
| Secrets | OAuth credentials currently passed in request body from localStorage (ADR-011) |
| External APIs | Zoom, Fireflies, YouTube Data API v3, OpenRouter — all outbound HTTPS |
| No database | MVP state is file-backed; ADR-016 specifies SQLite/Postgres in Tier 2 |

Two problems must be solved for cloud deployment:

1. **Ephemeral filesystem**: Cloud container runtimes do not persist the local filesystem between instances or restarts. The `data/` directory must be moved to durable storage.
2. **Long-running uploads**: The default Cloud Run request timeout is 5 minutes; YouTube uploads of large recordings can take longer.

---

## Decision

### 1. Compute: Cloud Run (fully managed)

Deploy the Next.js application as a Docker container to **Cloud Run** in the `europe-west1` region (or the operator's preferred region).

**Rationale over alternatives:**

| Option | Rejected reason |
|--------|----------------|
| App Engine Standard | No support for arbitrary Docker images; Node.js version constraints |
| App Engine Flexible | Slower deployments; more expensive at low traffic |
| GKE Autopilot | Over-engineered for a single-service app at this scale |
| Compute Engine VM | Requires manual OS patching, no auto-scaling, more ops overhead |

Cloud Run provides:
- Scale-to-zero when idle (cost: $0 when not in use)
- Managed TLS and custom domain via Cloud Run domain mappings
- Request timeout configurable up to **60 minutes** — sufficient for current upload sizes
- IAM-based access control (restrict to authorised users or a known IP range during early deployment)

**Cloud Run configuration:**

```yaml
# cloud-run service spec (abbreviated)
containerConcurrency: 1        # single-threaded Next.js; avoid shared in-memory state across requests
timeoutSeconds: 3600           # 60-minute max; covers large video uploads
memory: 512Mi
cpu: 1
minInstances: 0                # scale to zero when idle
maxInstances: 3                # cap cost; backfill is quota-limited to 5 uploads/day anyway
```

`containerConcurrency: 1` prevents multiple simultaneous requests sharing the same Node.js process memory. This is safe because the backfill orchestrator is driven from the browser, not the server.

### 2. Container Image: Artifact Registry + Cloud Build

```
Source (GitHub) → Cloud Build trigger → Docker build → Artifact Registry → Cloud Run deploy
```

**Dockerfile** (multi-stage):

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY web/package*.json ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3080
CMD ["node", "server.js"]
```

Next.js `output: "standalone"` must be set in `next.config.ts` to produce a self-contained bundle.

Cloud Build trigger fires on push to the `main` branch. The trigger builds, pushes to Artifact Registry, and deploys to Cloud Run automatically.

### 3. Persistent State: Cloud Storage FUSE

The `data/` directory (backfill state JSON, server log) is mounted into the Cloud Run container using **Cloud Storage FUSE** via the Cloud Run volume mount feature (GA as of 2025).

```yaml
volumes:
  - name: data-bucket
    csi:
      driver: gcsfuse.run.googleapis.com
      volumeAttributes:
        bucketName: video-sync-data-PROJECTID

volumeMounts:
  - name: data-bucket
    mountPath: /app/data
```

The bucket is created in the same region as the Cloud Run service with:
- **Uniform bucket-level access** (no per-object ACLs)
- **Versioning disabled** (state files are small and overwritten frequently; versioning adds unnecessary cost)
- **Lifecycle rule**: delete objects older than 90 days (log rotation handled by ADR-017; this is a safety net)

The Cloud Run service account is granted `roles/storage.objectAdmin` on this bucket only.

**Why not Firestore?** The current file-based state API (`readFile`/`writeFile` in the API routes) would require a rewrite to use the Firestore SDK. GCS FUSE preserves the existing code unchanged and is the correct migration path before the ADR-016 Tier 2 SQLite/Postgres transition.

**Consistency note:** GCS FUSE provides **eventual consistency** for metadata operations. Because the backfill orchestrator runs as a single browser session driving a single Cloud Run instance, concurrent write conflicts on `backfill-state.json` are not a concern at MVP. This should be re-evaluated when `containerConcurrency > 1`.

### 4. Secrets: Secret Manager

OAuth credentials (YouTube `client_id`, `client_secret`; Zoom `account_id` etc.) are currently stored in browser `localStorage` and passed in request bodies (ADR-011). This pattern is unchanged in the Cloud Run deployment — Secret Manager is used only for **server-side environment variables** that cannot be passed from the browser.

Environment variables stored in Secret Manager and injected into Cloud Run at deploy time:

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | LLM summarisation fallback (ADR-014) |
| `OPENROUTER_MODEL` | Optional model override |

YouTube and Zoom OAuth credentials remain browser-managed (ADR-011). A future ADR may migrate these to server-side Secret Manager entries when multi-user support is added.

**Secret Manager access:** The Cloud Run service account is granted `roles/secretmanager.secretAccessor` on named secrets only (not project-wide).

### 5. Networking and Access Control

At initial deployment, the Cloud Run service is set to **`--no-allow-unauthenticated`**, requiring a Google identity to invoke it. The operator accesses the app via:

```
https://video-sync-HASH-ew.a.run.app
```

with `gcloud auth print-identity-token` or by adding their Google account to the Cloud Run Invoker IAM binding.

When the service is ready for wider access:
- Enable `--allow-unauthenticated`
- Add a **Cloud Armor** security policy to restrict by IP or enable Google Identity-Aware Proxy (IAP) for Google Workspace SSO

Custom domain mapping (e.g. `video-sync.example.com`) is configured via Cloud Run domain mappings, which provision a Google-managed TLS certificate automatically.

### 6. CI/CD Pipeline

```
.github/workflows/deploy.yml  (or cloudbuild.yaml)
  ↓
gcloud builds submit --config cloudbuild.yaml
  ↓
docker build + push to europe-west1-docker.pkg.dev/PROJECT/video-sync/app:SHA
  ↓
gcloud run deploy video-sync --image=... --region=europe-west1
```

The `cloudbuild.yaml` substitutions (`_REGION`, `_PROJECT_ID`) are set in the Cloud Build trigger configuration so no secrets are in the repository.

---

## Consequences

### Positive

- Zero-downtime deployments via Cloud Run's traffic splitting (new revision receives 0% traffic, rolled to 100% after health check passes).
- Scale-to-zero means no idle cost when the operator is not using the dashboard.
- GCS FUSE mount preserves all existing file-based API route code with no changes.
- Secret Manager removes the only server-side secret (`OPENROUTER_API_KEY`) from environment files.
- The 60-minute Cloud Run timeout covers all current upload sizes without switching to an async job queue (ADR-003 deferred to Tier 2).

### Negative

- **GCS FUSE latency**: File reads/writes to `data/` are slower than local disk (~10–100ms vs <1ms). For backfill state (a few KB, written once per upload), this is acceptable. For log appends (ADR-017, frequent), it adds latency. Mitigation: buffer log writes in memory and flush periodically, or write logs only to stdout (already the primary transport in ADR-017) and keep the GCS mount for state only.
- **Cold start**: With `minInstances: 0`, the first request after idle incurs a cold start (~2–4 seconds for a Next.js standalone bundle). Mitigation: set `minInstances: 1` during active backfill periods.
- **Single-instance state**: The backfill orchestrator's in-memory interval timer lives in the browser, not the server — this is unchanged from local operation. No server-side singleton state is required.
- **No WebSocket support**: Cloud Run does not support WebSocket upgrades on HTTP/1.1; HTTP/2 streaming (SSE) works. The existing SSE-based progress reporting (ADR-016 Tier 2) is compatible; WebSocket would not be.

### Risks

- **GCS FUSE mount failure at startup**: If the bucket does not exist or IAM is misconfigured, the container fails to start. Mitigation: the `data/` directory write failures are already swallowed in `serverLogger.ts` — the app degrades gracefully (no state persistence) rather than crashing. Alert on Cloud Monitoring metric `run.googleapis.com/container/startup_latency` p99 spike.
- **Concurrent instance writes**: If Cloud Run scales to more than one instance simultaneously, two instances could write `backfill-state.json` concurrently. Mitigation: `maxInstances: 3` combined with `containerConcurrency: 1` and the browser-driven orchestrator (one tab = one active uploader) makes this unlikely. The ADR-016 Tier 2 SQLite migration removes this risk entirely.

---

## Implementation Steps

| Step | Action | Owner |
|------|--------|-------|
| 1 | Add `output: "standalone"` to `next.config.ts` | Engineering |
| 2 | Write `Dockerfile` (multi-stage, as above) | Engineering |
| 3 | Create GCP project, enable Cloud Run, Artifact Registry, Cloud Build, Secret Manager, GCS APIs | Ops |
| 4 | Create GCS bucket `video-sync-data-PROJECTID` in target region | Ops |
| 5 | Create Cloud Run service account; grant GCS and Secret Manager roles | Ops |
| 6 | Store `OPENROUTER_API_KEY` in Secret Manager | Ops |
| 7 | Write `cloudbuild.yaml`; configure Cloud Build trigger on `main` | Engineering |
| 8 | Deploy first revision; verify health endpoint (`GET /api/backfill/state` → 200) | Engineering |
| 9 | Add operator Google account to Cloud Run Invoker IAM binding | Ops |
| 10 | (Optional) Configure custom domain and IAP | Ops |

---

## References

- ADR-003: Async Job Queue (deferred; Cloud Run timeout is sufficient for Tier 1)
- ADR-004: Temporary Storage (video binary buffering during upload — unchanged; Cloud Run has ephemeral `/tmp`)
- ADR-011: MVP Credential Proxy (localStorage credentials — unchanged)
- ADR-016: Backfill Orchestrator (Tier 2 SQLite migration replaces GCS FUSE for state)
- ADR-017: Observability (stdout JSON logs captured by Cloud Logging automatically)
- [Cloud Run — Volume mounts (GCS FUSE)](https://cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts)
- [Cloud Run — Request timeout](https://cloud.google.com/run/docs/configuring/request-timeout)
- [Next.js — Standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)

---

## Addendum: GCS FUSE remains DEFERRED (2026-04-21)

### Current state

The original ADR specified a GCS FUSE mount for `/app/data`, but **that mount is not active in production**. Cloud Run runs with an **ephemeral filesystem**: every cold start, revision rollout, or instance shutdown wipes `data/`.

An attempt was made on 2026-04-21 to add the mount flags to `deploy.sh` and run `scripts/gcs-fuse-setup.sh` to create the backing bucket. The setup script failed because the operator's account lacks both:

- `roles/serviceusage.serviceUsageAdmin` (to enable or verify `run.googleapis.com` / `storage.googleapis.com` / `iam.googleapis.com`), and
- `roles/storage.admin` (to create the bucket and set IAM on it).

Rather than hold up other work waiting on a support ticket, the FUSE flags were **reverted from `deploy.sh`** and the app now operates explicitly in ephemeral-filesystem mode. The setup script remains in the repo (`scripts/gcs-fuse-setup.sh`) for the day the IAM blocker is resolved.

### What that means right now

| File | Persistence today |
|------|-------------------|
| `data/rules.json` | Ephemeral. Survives in practice because every browser re-POSTs its localStorage copy on boot (ADR-031). If all browsers are closed during a redeploy the file is gone, but the next browser to connect re-seeds it. |
| `data/backfill-state.json` | Ephemeral. The **`uploads_today` quota counter resets on every cold start.** Clients keep their own copy in `localStorage["video-sync:backfill-state"]`, but server-tracked quota may under-count because the per-instance counter is transient. |
| `data/server.log` | Ephemeral. Not a practical loss — ADR-017 already routes all structured logs to stdout, which Cloud Logging captures automatically. The on-disk file was only ever a local-dev convenience. |
| `/tmp` during upload | Ephemeral. Expected — only used as a streaming buffer within a single request. |

### What needs to happen to turn FUSE on

Once IAM is granted (see support ticket text in the section below), two steps flip it live:

1. `bash scripts/gcs-fuse-setup.sh` — creates `gs://video-sync-data-agentics-487016` in `us-central1` and grants the Cloud Run runtime service account `roles/storage.objectUser` on the bucket.
2. Re-add the flags to `deploy.sh` under `gcloud run deploy`:
   ```
   --execution-environment=gen2
   --add-volume=name=data,type=cloud-storage,bucket=video-sync-data-agentics-487016
   --add-volume-mount=volume=data,mount-path=/app/data
   ```

### Support ticket request

Request one-time grants (can be revoked after setup completes):

- `roles/serviceusage.serviceUsageAdmin` — to confirm/enable the APIs
- `roles/storage.admin` — to create the bucket and grant IAM on it

Or: have an admin run `bash scripts/gcs-fuse-setup.sh` directly.

### Broader persistence question

This addendum is about **one specific bucket mount**. The wider question of what data lives in localStorage versus the server (and the multi-browser/multi-user implications) is captured in **ADR-035: Persistence Topology and Single-Browser Constraint**. That ADR frames the four-level sequencing (FUSE → catalog-to-server → credentials-to-server → multi-user identity) and is the authoritative document for the broader architectural direction. This addendum stays focused on the mechanics of the FUSE mount itself.
