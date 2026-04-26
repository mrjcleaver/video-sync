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
# ─── Auth note (ADR-036) ─────────────────────────────────────────────────
# ALLOW_NO_IAP=1 keeps the service in single-user dev-like mode: the
# /api/auth/me endpoint and useCurrentActor hook return a synthetic admin
# instead of validating an IAP JWT. Pre-IAP, this is the only safe value.
# After running scripts/iap-setup.sh, REMOVE ALLOW_NO_IAP=1 and ADD:
#   IAP_AUDIENCE=/projects/<num>/global/backendServices/<id>
#   KEY_ADMIN_EMAILS=...
#   OPERATOR_EMAILS=...
#   VIEWER_EMAILS=...

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
  --allow-unauthenticated \
  --no-cpu-throttling \
  --set-env-vars=NODE_ENV=production,MEMORY_LIMIT_MB=4096,ALLOW_NO_IAP=1 \
  --set-secrets=OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest
