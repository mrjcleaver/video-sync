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
# This deploy expects IAP to be in front of the service. Two role-
# assignment modes are supported:
#
# Mode A — Cloud Identity (preferred, but needs Workspace permission)
#   Set WS_DOMAIN=agentics.org. Roles come from group membership lookups
#   via Cloud Identity searchTransitiveGroups. Requires the Cloud Run
#   runtime SA to be a Manager on each of the three groups (configured
#   in Workspace Admin > Groups).
#
# Mode B — env-var allowlist (transitional fallback while waiting on
#          Workspace permission)
#   Leave WS_DOMAIN UNSET. Set the email allowlists below. The auth
#   layer will skip the Cloud Identity call and consult these directly.
#   Email here is for ROLE assignment only — IAP itself still gates
#   access via group membership (set up by scripts/iap-setup.sh).
#
# Switch from Mode B to Mode A: add WS_DOMAIN, remove the *_EMAILS vars.
#
# IAP_AUDIENCE is required in both modes. Get it from iap-setup.sh.
# IAP_AUDIENCE must NOT be set together with ALLOW_NO_IAP=1 — the
# app refuses to boot if it sees both (sec#2 misconfiguration guard).

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

# Auth mode is selected by whether IAP_AUDIENCE is exported.
#   IAP mode   = IAP_AUDIENCE set    → --no-allow-unauthenticated, IAP-enforced
#   Open mode  = IAP_AUDIENCE unset  → --allow-unauthenticated, ALLOW_NO_IAP=1
# The dev-friendly deploy-without-iap.sh wrapper sets the *_EMAILS vars
# but leaves IAP_AUDIENCE unset, landing here in Open mode. When the
# operator gets the Workspace permission for Cloud Identity (or just
# wants to flip to env-var role mapping behind IAP), they export
# IAP_AUDIENCE and re-run deploy.sh.

BASE_ENV="NODE_ENV=production,MEMORY_LIMIT_MB=4096"
if [[ -n "${IAP_AUDIENCE:-}" ]]; then
  AUTH_FLAG="--no-allow-unauthenticated"
  AUTH_ENV="IAP_AUDIENCE=${IAP_AUDIENCE}"
  # Mode A by default: Cloud Identity Groups API drives role lookup using
  # WS_DOMAIN. Confirmed working on revision 00035-lqq (2026-04-27).
  AUTH_ENV+=",WS_DOMAIN=${WS_DOMAIN:-agentics.org}"
  # Email allowlists kept as a transparent fallback if the Cloud Identity
  # API ever returns a transient error — the auth code falls through only
  # on exception (not on empty results), so this can't accidentally
  # re-grant a user removed from groups.
  AUTH_ENV+=",KEY_ADMIN_EMAILS=${KEY_ADMIN_EMAILS:-martin.cleaver@agentics.org}"
  AUTH_ENV+=",OPERATOR_EMAILS=${OPERATOR_EMAILS:-martin.cleaver@agentics.org}"
  AUTH_ENV+=",VIEWER_EMAILS=${VIEWER_EMAILS:-martin.cleaver@agentics.org}"
  echo "==> IAP mode (audience set, --no-allow-unauthenticated, Mode A: groups via Cloud Identity)"
else
  AUTH_FLAG="--allow-unauthenticated"
  AUTH_ENV="ALLOW_NO_IAP=1"
  echo "==> Open mode (IAP_AUDIENCE unset, --allow-unauthenticated, dev actor)"
fi

gcloud run deploy video-sync \
  --image="$IMAGE:$SHA" \
  --region=us-central1 \
  --concurrency=80 \
  --timeout=3600 \
  --memory=4Gi \
  --cpu=2 \
  --min-instances=0 \
  --max-instances=3 \
  $AUTH_FLAG \
  --no-cpu-throttling \
  --set-env-vars="${BASE_ENV},${AUTH_ENV}" \
  --set-secrets=OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest
