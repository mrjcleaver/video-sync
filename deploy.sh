#!/usr/bin/bash
#
# Manual deploy to Cloud Run (video-sync service, agentics-487016 project).
#
# ─── Why this script exists ──────────────────────────────────────────────
# The org enforces constraints/iam.disableServiceAccountKeyCreation, so the
# GitHub Actions workflow (.github/workflows/deploy.yml) that used
# credentials_json cannot authenticate. Until that workflow is migrated to
# Workload Identity Federation, this script is the deploy path.
#
# ─── First-time setup (per machine / per devcontainer) ───────────────────
#   1. gcloud auth login                     # interactive browser login
#   2. gcloud auth configure-docker us-central1-docker.pkg.dev
#   3. gcloud config set project agentics-487016
#
# Your user account must have these roles on the project:
#   - roles/run.admin
#   - roles/artifactregistry.writer
#   - roles/iam.serviceAccountUser
#
# ─── Auth (ADR-036) ──────────────────────────────────────────────────────
# This deploy now expects IAP to be in front of the service. Roles are
# resolved by querying Workspace group membership via the Cloud Identity
# API (using the Cloud Run runtime SA). Three env vars drive this:
#
#   IAP_AUDIENCE=/projects/<num>/global/backendServices/<id>
#       — printed by scripts/iap-setup.sh on success. Required for
#         JWT signature + audience verification.
#   WS_DOMAIN=agentics.org
#       — Cloud Identity searches groups/{role}@{WS_DOMAIN}. Optional
#         only if you're using KEY_ADMIN_EMAILS env-var fallback.
#   IAP_AUDIENCE must NOT be set together with ALLOW_NO_IAP=1 — the
#       app refuses to boot if it sees both (sec#2 misconfiguration guard).
#
# The Cloud Run runtime SA must be allowed to query group membership.
# Easiest path: in Workspace Admin > Groups, add the runtime SA's email
# (`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`) as a
# Manager (or Member with view scope) on each of the three groups.

# ─── Persistence note ────────────────────────────────────────────────────
# /app/data is CURRENTLY ON THE EPHEMERAL FILESYSTEM. Files in data/ are
# wiped on every cold start / new revision. See ADR-018 addendum and
# ADR-035 for the full story. Implications:
#   - data/backfill-state.json: uploads_today resets each restart
#   - data/rules.json: survives only because clients re-POST from localStorage
#   - data/server.log: captured by Cloud Logging via stdout; file is lost
# The FUSE mount path is prepared in scripts/gcs-fuse-setup.sh but is NOT
# enabled here pending IAM permissions. When unblocked, add:
#   --execution-environment=gen2
#   --add-volume=name=data,type=cloud-storage,bucket=video-sync-data-agentics-487016
#   --add-volume-mount=volume=data,mount-path=/app/data
#
# ─── Deploy ──────────────────────────────────────────────────────────────
#   ./deploy.sh
#
# The Cloud Run service URL is printed at the end.
#
# ─── When auth expires ───────────────────────────────────────────────────
# gcloud tokens expire after roughly 7 days of inactivity. If the script
# errors on `docker push` or `gcloud run deploy`, just re-run:
#   gcloud auth login
# and try again.
#
# ─── Rollback ────────────────────────────────────────────────────────────
# Cloud Run keeps every revision. To roll back:
#   gcloud run services update-traffic video-sync \
#     --region=us-central1 --to-revisions=<PREV_REVISION>=100
# Or use the Cloud Run console > Revisions tab.
#

set -euo pipefail

cd /workspaces/video-sync

SHA=$(git rev-parse --short HEAD)
IMAGE="us-central1-docker.pkg.dev/agentics-487016/video-sync/app"

docker build \
  --tag "$IMAGE:$SHA" \
  --tag "$IMAGE:latest" \
  --build-arg BUILD_SHA="$SHA" \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  .

docker push "$IMAGE:$SHA"
docker push "$IMAGE:latest"

gcloud run deploy video-sync \
  --image="$IMAGE:$SHA" \
  --region=us-central1 \
  --concurrency=80 \
  --timeout=3600 \
  --memory=4Gi \
  --cpu=2 \
  --min-instances=0 \
  --max-instances=3 \
  --no-allow-unauthenticated \
  --no-cpu-throttling \
  --set-env-vars="NODE_ENV=production,MEMORY_LIMIT_MB=4096,WS_DOMAIN=agentics.org,IAP_AUDIENCE=${IAP_AUDIENCE:?Set IAP_AUDIENCE before running deploy.sh — get it from scripts/iap-setup.sh output}" \
  --set-secrets=OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest
