#!/usr/bin/env bash
#
# Diagnose the IAP setup state for the video-sync Cloud Run service.
# Read-only — safe to run anytime to see what's blocking access-by-group.
#
# Usage:
#   bash scripts/iap-status.sh

set -uo pipefail

PROJECT_ID="${PROJECT_ID:-agentics-487016}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-video-sync}"
DOMAIN="${DOMAIN:-agentics.org}"

PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null)
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

GREEN='\e[32m'; RED='\e[31m'; YELLOW='\e[33m'; RESET='\e[0m'
ok() { echo -e "  ${GREEN}OK${RESET} $1"; }
no() { echo -e "  ${RED}NO${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!!${RESET} $1"; }

echo "==> Project ${PROJECT_ID} · service ${SERVICE} · region ${REGION}"
echo

echo "1. Required APIs"
for api in iap.googleapis.com cloudidentity.googleapis.com run.googleapis.com; do
  if gcloud services list --enabled --project="${PROJECT_ID}" --filter="config.name:${api}" --format='value(config.name)' 2>/dev/null | grep -q "${api}"; then
    ok "${api} enabled"
  else
    no "${api} not enabled"
  fi
done
echo

echo "2. Cloud Run service"
SVC_JSON=$(gcloud run services describe "${SERVICE}" --region="${REGION}" --project="${PROJECT_ID}" --format=json 2>/dev/null)
if [[ -z "${SVC_JSON}" ]]; then
  no "service ${SERVICE} not found in ${REGION}"
  exit 1
fi
ok "service exists"
INVOKER_PUBLIC=$(gcloud run services get-iam-policy "${SERVICE}" --region="${REGION}" --project="${PROJECT_ID}" --format=json 2>/dev/null | grep -E '"allUsers"|"allAuthenticatedUsers"' || true)
if [[ -n "${INVOKER_PUBLIC}" ]]; then
  warn "service is public (allUsers/allAuthenticatedUsers has invoker) - IAP cannot gate access"
else
  ok "service requires authentication"
fi
echo

echo "3. IAP on the service"
IAP_ID=$(echo "${SVC_JSON}" | grep -o '"run.googleapis.com/iap-id":"[^"]*"' | cut -d'"' -f4)
if [[ -n "${IAP_ID}" ]]; then
  ok "IAP enabled (backend id: ${IAP_ID})"
  echo "    IAP_AUDIENCE=/projects/${PROJECT_NUMBER}/global/backendServices/${IAP_ID}"
else
  no "IAP not enabled on the service"
  echo "    fix: bash scripts/iap-setup.sh"
fi
echo

echo "4. Workspace groups bound as run.invoker"
POLICY=$(gcloud run services get-iam-policy "${SERVICE}" --region="${REGION}" --project="${PROJECT_ID}" --format=json 2>/dev/null)
for role in key-admins operators viewers; do
  group="video-sync-${role}@${DOMAIN}"
  if echo "${POLICY}" | grep -q "group:${group}"; then
    ok "${group} bound"
  else
    no "${group} not bound"
  fi
done
echo

echo "5. Cloud Identity readability for the runtime SA"
echo "  Runtime SA: ${RUNTIME_SA}"
warn "this script cannot directly check the runtime SA's group-read permission"
warn "to verify, deploy in IAP mode and check Cloud Run logs for 'Cloud Identity lookup failed'"
echo "  if it fails, the env-var allowlist (KEY_ADMIN_EMAILS etc.) is used instead"
echo

echo "==> Summary"
if [[ -n "${IAP_ID}" && -z "${INVOKER_PUBLIC}" ]]; then
  echo "  IAP gating IS in effect. Group membership controls access."
  echo "  Deploy with:"
  echo "    export IAP_AUDIENCE=/projects/${PROJECT_NUMBER}/global/backendServices/${IAP_ID}"
  echo "    bash deploy.sh"
else
  echo "  IAP gating is NOT in effect. Run scripts/iap-setup.sh to complete."
fi
