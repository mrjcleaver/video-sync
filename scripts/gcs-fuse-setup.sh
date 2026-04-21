#!/usr/bin/env bash
#
# One-time setup for the Cloud Run GCS FUSE mount (ADR-018).
#
# Creates a regional GCS bucket and grants the Cloud Run RUNTIME service
# account read/write access so the Next.js app can persist data/ across
# revisions and cold starts.
#
# Run this once from an interactive terminal with gcloud authenticated:
#   gcloud auth login
#   bash scripts/gcs-fuse-setup.sh
#
# Idempotent: re-running it is safe.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-agentics-487016}"
REGION="${REGION:-us-central1}"       # must match Cloud Run service region
BUCKET="video-sync-data-${PROJECT_ID}"

# Resolve runtime service account. deploy.sh does not specify
# --service-account, so Cloud Run uses the default Compute Engine SA.
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "==> Project: ${PROJECT_ID} (number ${PROJECT_NUMBER})"
echo "==> Region:  ${REGION}"
echo "==> Bucket:  gs://${BUCKET}"
echo "==> Runtime service account: ${RUNTIME_SA}"
echo

echo "==> Enabling required APIs"
if [[ "${SKIP_ENABLE:-}" == "1" ]]; then
  echo "    (skipped — SKIP_ENABLE=1)"
else
  gcloud services enable \
    storage.googleapis.com \
    run.googleapis.com \
    --project="${PROJECT_ID}" || {
    echo
    echo "!! 'gcloud services enable' failed — typically because your user"
    echo "   lacks roles/serviceusage.serviceUsageAdmin on the project."
    echo
    echo "   If the APIs are already enabled (verify with:"
    echo "     gcloud services list --enabled --project=${PROJECT_ID} \\"
    echo "       --filter='config.name=(storage.googleapis.com OR run.googleapis.com)')"
    echo "   you can safely skip this step by re-running:"
    echo "     SKIP_ENABLE=1 bash scripts/gcs-fuse-setup.sh"
    exit 1
  }
fi

echo "==> Creating bucket (if missing)"
if gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "    (already exists)"
else
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --project="${PROJECT_ID}"
fi

echo "==> Granting runtime SA bucket access"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/storage.objectUser" \
  --project="${PROJECT_ID}"

echo
echo "=========================================================="
echo "Done. The next deploy (./deploy.sh) will mount this bucket"
echo "at /app/data in the container. Existing data/ files in the"
echo "image are shadowed by the mount — seed files via:"
echo
echo "  gcloud storage cp data/rules.json gs://${BUCKET}/"
echo
echo "=========================================================="
