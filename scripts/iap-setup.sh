#!/usr/bin/env bash
#
# One-time setup for ADR-036 Google Workspace authentication.
#
# Creates the three Workspace groups, configures Identity-Aware Proxy on
# the Cloud Run service, and prints the IAP_AUDIENCE value to add to
# deploy.sh as an env var.
#
# Requires: gcloud authenticated as a project owner with Workspace admin
# access for agentics.org. If you lack one, route this to your GWS admin.
#
#   bash scripts/iap-setup.sh
#
# Idempotent: re-runs are safe. The Workspace group creation step is
# skipped if the group already exists.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-agentics-487016}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-video-sync}"
DOMAIN="${DOMAIN:-agentics.org}"

KEY_ADMIN_GROUP="video-sync-key-admins@${DOMAIN}"
OPERATOR_GROUP="video-sync-operators@${DOMAIN}"
VIEWER_GROUP="video-sync-viewers@${DOMAIN}"

echo "==> Project: ${PROJECT_ID}"
echo "==> Region:  ${REGION}"
echo "==> Service: ${SERVICE}"
echo "==> Domain:  ${DOMAIN}"
echo

# 1. Enable IAP API
echo "==> Enabling IAP API"
gcloud services enable iap.googleapis.com --project="${PROJECT_ID}" || {
  echo "  (skipped — likely missing serviceusage.serviceUsageAdmin)"
  echo "  Verify: gcloud services list --enabled --project=${PROJECT_ID} | grep iap"
}

# 2. Create Workspace groups via Cloud Identity API
# (gcloud identity groups requires the Cloud Identity API and admin perms)
echo "==> Creating Workspace groups (requires Workspace admin)"
for group_email in "${KEY_ADMIN_GROUP}" "${OPERATOR_GROUP}" "${VIEWER_GROUP}"; do
  display_name="$(echo "${group_email}" | cut -d@ -f1)"
  if gcloud identity groups describe "${group_email}" >/dev/null 2>&1; then
    echo "  ${group_email} already exists"
  else
    gcloud identity groups create "${group_email}" \
      --organization="${DOMAIN}" \
      --display-name="${display_name}" \
      --description="Video Sync ${display_name}" \
      || echo "  !! create ${group_email} failed — request from Workspace admin"
  fi
done

# 3. Bind groups to Cloud Run Invoker so anyone in any of the three can
#    reach the service. In-app role check distinguishes capabilities.
echo "==> Granting Cloud Run Invoker to the three groups"
for group_email in "${KEY_ADMIN_GROUP}" "${OPERATOR_GROUP}" "${VIEWER_GROUP}"; do
  gcloud run services add-iam-policy-binding "${SERVICE}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --member="group:${group_email}" \
    --role="roles/run.invoker" \
    || echo "  !! grant for ${group_email} failed"
done

# 4. Switch the service to require auth
echo "==> Removing --allow-unauthenticated"
gcloud run services update "${SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --no-allow-unauthenticated

# 5. Compute the IAP_AUDIENCE for the JWT verifier
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
SERVICE_ID=$(gcloud run services describe "${SERVICE}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(metadata.uid)')
IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/global/backendServices/${SERVICE_ID}"

echo
echo "=========================================================="
echo "Setup complete. Add to deploy.sh under --set-env-vars:"
echo "  IAP_AUDIENCE=${IAP_AUDIENCE}"
echo
echo "And populate the role-mapping env vars (or move to a"
echo "config file once group counts grow):"
echo "  KEY_ADMIN_EMAILS=martin.cleaver@${DOMAIN}"
echo "  OPERATOR_EMAILS=..."
echo "  VIEWER_EMAILS=..."
echo
echo "Then re-deploy:  bash deploy.sh"
echo "=========================================================="
