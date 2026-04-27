#!/usr/bin/env bash
#
# Read-only probe of Cloud Identity API permission state for the
# video-sync Cloud Run setup. Tells you whether you can flip from
# Mode B (env-var allowlist) to Mode A (group-driven roles).
#
# Usage:
#   bash scripts/check-cloud-identity.sh

set -uo pipefail

PROJECT_ID="${PROJECT_ID:-agentics-487016}"
DOMAIN="${DOMAIN:-agentics.org}"
SAMPLE_GROUP="video-sync-key-admins@${DOMAIN}"

PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null)
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
USER_EMAIL=$(gcloud config get-value account 2>/dev/null)

GREEN='\e[32m'; RED='\e[31m'; YELLOW='\e[33m'; RESET='\e[0m'
ok() { echo -e "  ${GREEN}OK${RESET} $1"; }
no() { echo -e "  ${RED}NO${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!!${RESET} $1"; }

echo "==> Project: ${PROJECT_ID} (number ${PROJECT_NUMBER})"
echo "==> You:     ${USER_EMAIL}"
echo "==> Runtime SA: ${RUNTIME_SA}"
echo "==> Sample group probed: ${SAMPLE_GROUP}"
echo

# ── Check 1: API enabled ───────────────────────────────────────────

echo "1. Cloud Identity API enabled on the project"
API_LINE=$(gcloud services list --enabled --project="${PROJECT_ID}" \
  --filter='config.name=cloudidentity.googleapis.com' \
  --format='value(config.name)' 2>/dev/null)
if [[ -n "${API_LINE}" ]]; then
  ok "cloudidentity.googleapis.com is enabled"
  API_ENABLED=1
else
  no "cloudidentity.googleapis.com is NOT enabled"
  no "Mode A cannot work until this API is enabled"
  echo "    fix: ask whoever has roles/serviceusage.serviceUsageAdmin to run:"
  echo "         gcloud services enable cloudidentity.googleapis.com --project=${PROJECT_ID}"
  API_ENABLED=0
fi
echo

# ── Check 2: Your own access ───────────────────────────────────────

echo "2. YOUR account can read group membership"
USER_PROBE=$(gcloud identity groups memberships list \
  --group-email="${SAMPLE_GROUP}" \
  --format='value(preferredMemberKey.id)' 2>&1)
if echo "${USER_PROBE}" | grep -q "${USER_EMAIL}\|@${DOMAIN}"; then
  ok "you can list members of ${SAMPLE_GROUP}"
  echo "    (sample output below)"
  echo "${USER_PROBE}" | head -3 | sed 's/^/      /'
else
  no "you cannot list members of ${SAMPLE_GROUP}"
  echo "    error: $(echo "${USER_PROBE}" | head -1)"
fi
echo

# ── Check 3: Runtime SA project-level IAM roles ────────────────────

echo "3. Runtime SA project-level IAM roles"
SA_ROLES=$(gcloud projects get-iam-policy "${PROJECT_ID}" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${RUNTIME_SA}" \
  --format='value(bindings.role)' 2>/dev/null)
if [[ -z "${SA_ROLES}" ]]; then
  warn "no project-level IAM roles found for the runtime SA"
else
  echo "${SA_ROLES}" | sed 's/^/    /'
fi
SA_HAS_GROUP_ROLE=0
if echo "${SA_ROLES}" | grep -qE 'cloudidentity\.groups|cloudidentity\.groupMemberships'; then
  ok "runtime SA has a Cloud Identity Groups read role at project level"
  SA_HAS_GROUP_ROLE=1
else
  warn "runtime SA has no project-level Cloud Identity role (might still"
  warn "  work if it's a Manager on each group at Workspace level — see below)"
fi
echo

# ── Check 4: Workspace-side group manager status (best-effort hint) ─

echo "4. Runtime SA as Workspace group Manager (Mode A alternative)"
warn "this script can't directly query Workspace-side group memberships"
warn "to grant the runtime SA group-read access via Workspace Admin:"
echo "    Workspace Admin → Groups → [each group] → Settings → Group managers"
echo "    Add: ${RUNTIME_SA}"
echo

# ── Conclusion ─────────────────────────────────────────────────────

echo "==> Summary"
if [[ ${API_ENABLED} -eq 1 && ${SA_HAS_GROUP_ROLE} -eq 1 ]]; then
  echo "  Mode A might work. Try it:"
  echo "    export IAP_AUDIENCE='/projects/${PROJECT_NUMBER}/locations/us-central1/services/video-sync'"
  echo "    export WS_DOMAIN=${DOMAIN}"
  echo "    bash deploy.sh"
  echo "  Then check logs for 'Cloud Identity lookup failed' — absent = success."
elif [[ ${API_ENABLED} -eq 1 ]]; then
  echo "  API is enabled but the runtime SA has no project-level Cloud Identity role."
  echo "  Mode A might still work if the runtime SA is a Manager on each group at"
  echo "  the Workspace level. The only definitive test is to deploy with WS_DOMAIN"
  echo "  set and watch the logs:"
  echo "    export IAP_AUDIENCE='/projects/${PROJECT_NUMBER}/locations/us-central1/services/video-sync'"
  echo "    export WS_DOMAIN=${DOMAIN}"
  echo "    bash deploy.sh"
  echo "    gcloud run services logs read video-sync --region=us-central1 --limit=20 \\"
  echo "      | grep 'Cloud Identity'"
else
  echo "  Mode A is not ready. Stay in Mode B (env-var allowlist) until the API"
  echo "  is enabled and the runtime SA has group-read access."
fi
