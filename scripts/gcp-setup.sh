#!/usr/bin/env bash
# ADR-018: One-time GCP setup for GitHub Actions → Cloud Run deployment.
# Run this once from a terminal with gcloud authenticated as a project owner.
#
# Usage:
#   export PROJECT_ID=your-gcp-project-id
#   export GITHUB_REPO=mrjcleaver/video-sync
#   bash scripts/gcp-setup.sh

set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${GITHUB_REPO:?Set GITHUB_REPO (owner/repo)}"

REGION="europe-west1"
SA_NAME="video-sync-deploy"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
WIF_POOL="github-pool"
WIF_PROVIDER="github-provider"
BUCKET="video-sync-data-${PROJECT_ID}"
AR_REPO="video-sync"

echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project="${PROJECT_ID}"

echo "==> Creating Artifact Registry repository"
gcloud artifacts repositories create "${AR_REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --quiet 2>/dev/null || echo "  (already exists)"

echo "==> Creating GCS bucket for persistent data/"
gcloud storage buckets create "gs://${BUCKET}" \
  --location="${REGION}" \
  --uniform-bucket-level-access \
  --project="${PROJECT_ID}" \
  2>/dev/null || echo "  (already exists)"

echo "==> Creating service account"
gcloud iam service-accounts create "${SA_NAME}" \
  --display-name="video-sync GitHub deploy" \
  --project="${PROJECT_ID}" \
  2>/dev/null || echo "  (already exists)"

echo "==> Granting roles to service account"
for ROLE in \
  roles/run.admin \
  roles/artifactregistry.writer \
  roles/secretmanager.secretAccessor \
  roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --quiet
done

# GCS bucket access (scoped — not project-wide)
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin"

echo "==> Creating Workload Identity Pool"
gcloud iam workload-identity-pools create "${WIF_POOL}" \
  --location=global \
  --project="${PROJECT_ID}" \
  --quiet 2>/dev/null || echo "  (already exists)"

WIF_POOL_ID=$(gcloud iam workload-identity-pools describe "${WIF_POOL}" \
  --location=global \
  --project="${PROJECT_ID}" \
  --format="value(name)")

echo "==> Creating Workload Identity Provider for GitHub"
gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
  --location=global \
  --workload-identity-pool="${WIF_POOL}" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.actor=assertion.actor" \
  --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
  --project="${PROJECT_ID}" \
  --quiet 2>/dev/null || echo "  (already exists)"

echo "==> Binding service account to Workload Identity Pool"
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${WIF_POOL_ID}/attribute.repository/${GITHUB_REPO}" \
  --project="${PROJECT_ID}"

WIF_PROVIDER_NAME=$(gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER}" \
  --location=global \
  --workload-identity-pool="${WIF_POOL}" \
  --project="${PROJECT_ID}" \
  --format="value(name)")

echo ""
echo "=========================================================="
echo "Setup complete. Add these to your GitHub repository:"
echo ""
echo "  Settings → Secrets and variables → Actions"
echo ""
echo "  SECRETS (Settings → Secrets):"
echo "    GCP_WORKLOAD_IDENTITY_PROVIDER = ${WIF_PROVIDER_NAME}"
echo "    GCP_SERVICE_ACCOUNT            = ${SA_EMAIL}"
echo ""
echo "  VARIABLES (Settings → Variables):"
echo "    GCP_PROJECT_ID = ${PROJECT_ID}"
echo ""
echo "  Then store your OpenRouter API key in Secret Manager:"
echo "    echo -n 'sk-or-...' | gcloud secrets create OPENROUTER_API_KEY --data-file=- --project=${PROJECT_ID}"
echo "=========================================================="
