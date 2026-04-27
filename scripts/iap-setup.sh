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

# 1. Enable IAP + Cloud Identity APIs
# Cloud Identity is required for `gcloud identity groups create` below
# (QE finding rev#10).
echo "==> Enabling IAP + Cloud Identity APIs"
gcloud services enable \
  iap.googleapis.com \
  cloudidentity.googleapis.com \
  --project="${PROJECT_ID}" || {
  echo "  (skipped — likely missing serviceusage.serviceUsageAdmin)"
  echo "  Verify: gcloud services list --enabled --project=${PROJECT_ID} | grep -E 'iap|cloudidentity'"
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

# 3a. Bind groups to Cloud Run Invoker so anyone in any of the three
#     can have the IAP-fronted request reach the underlying service.
echo "==> Granting Cloud Run Invoker to the three groups"
for group_email in "${KEY_ADMIN_GROUP}" "${OPERATOR_GROUP}" "${VIEWER_GROUP}"; do
  gcloud run services add-iam-policy-binding "${SERVICE}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --member="group:${group_email}" \
    --role="roles/run.invoker" \
    || echo "  !! Cloud Run Invoker grant for ${group_email} failed"
done

# 3b. Bind groups to the IAP web resource so IAP itself lets them
#     through the sign-in wall. WITHOUT this step, IAP denies with
#     "You don't have access" even though Cloud Run's IAM policy
#     would accept the request — IAP has its own access policy that
#     gates BEFORE Cloud Run is even reached. Two policies, both
#     needed.
#
# Modifying IAP IAM requires roles/iap.admin which is broad. If the
# operator running this script doesn't have it, the bindings can be
# applied by anyone who does (one-time admin task). We probe the
# current policy first and skip the grant if all three groups are
# already bound — so re-runs by non-iap-admin operators don't show
# scary PERMISSION_DENIED errors when there's nothing to do.
echo "==> Granting IAP-Secured Web App User to the three groups"
EXISTING_IAP_POLICY=$(gcloud iap web get-iam-policy \
  --resource-type=cloud-run \
  --service="${SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format=json 2>/dev/null || echo "{}")
for group_email in "${KEY_ADMIN_GROUP}" "${OPERATOR_GROUP}" "${VIEWER_GROUP}"; do
  if echo "${EXISTING_IAP_POLICY}" | grep -q "group:${group_email}"; then
    echo "  ${group_email} already bound to roles/iap.httpsResourceAccessor"
    continue
  fi
  gcloud iap web add-iam-policy-binding \
    --resource-type=cloud-run \
    --service="${SERVICE}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --member="group:${group_email}" \
    --role="roles/iap.httpsResourceAccessor" 2>/dev/null \
    || {
      echo "  !! IAP grant for ${group_email} failed (need roles/iap.admin)"
      echo "     ask whoever has IAP admin to run the gcloud iap web add-iam-policy-binding"
      echo "     command for this member, OR see Option 1 in the script comments."
    }
done

# 4. Enable IAP on the Cloud Run service. This is the step that
#    actually puts a Google sign-in wall in front of browser requests
#    AND injects the X-Goog-IAP-JWT-Assertion header that auth.ts
#    validates. Without it, --no-allow-unauthenticated just means
#    "must present a Google identity token" — useful for service-to-
#    service calls but not for browser users.
echo "==> Enabling IAP on the Cloud Run service"
gcloud beta run services update "${SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --iap \
  || {
    echo
    echo "  !! IAP enable failed. Common causes:"
    echo "     - Missing roles/iap.admin (or owner/editor) on your account"
    echo "     - OAuth consent screen / IAP brand not yet configured for the project"
    echo "       (set up in Cloud Console → APIs & Services → OAuth consent screen)"
    echo "     - 'beta' component missing: gcloud components install beta"
    echo
    echo "  The earlier steps still applied. You can re-run this script after"
    echo "  resolving the blocker; it's idempotent."
    exit 1
  }

# 5. Remove the public-access IAM binding (allUsers → run.invoker).
#    The `--no-allow-unauthenticated` flag on `gcloud run services update`
#    is unsupported in some gcloud versions; using IAM directly is
#    portable and idempotent.
echo "==> Removing public access (allUsers run.invoker binding)"
gcloud run services remove-iam-policy-binding "${SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --quiet \
  || echo "  (allUsers binding already absent — fine)"

# 6. Compute the IAP_AUDIENCE for the JWT verifier. The Cloud Run IAP
#    audience format is /projects/<num>/global/backendServices/<id>
#    where the id is generated by IAP when it wraps the service. Read
#    it back from the service's IAP config.
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
IAP_BACKEND_ID=$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format='value(spec.template.metadata.annotations."run.googleapis.com/iap-id")' 2>/dev/null || true)
if [[ -z "${IAP_BACKEND_ID}" ]]; then
  # Fallback: older gcloud put the id elsewhere; service uid often matches
  # for the direct-Cloud-Run IAP setup
  IAP_BACKEND_ID=$(gcloud run services describe "${SERVICE}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(metadata.uid)')
  echo "  (note: IAP backend id read from metadata.uid as fallback)"
fi
IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/global/backendServices/${IAP_BACKEND_ID}"

echo
echo "=========================================================="
echo "IAP setup complete."
echo
echo "Next step — deploy in IAP mode:"
echo
echo "  export IAP_AUDIENCE='${IAP_AUDIENCE}'"
echo "  bash deploy.sh"
echo
echo "Role assignment in IAP mode:"
echo "  - WS_DOMAIN unset (default): use KEY_ADMIN_EMAILS / OPERATOR_EMAILS"
echo "    / VIEWER_EMAILS env vars (already defaulted in deploy.sh)."
echo "  - WS_DOMAIN=${DOMAIN}: query Cloud Identity for group membership."
echo "    Requires the runtime SA to be a Manager on each group."
echo "    Add via Workspace Admin → Groups → [each group] → Settings →"
echo "    Group managers: ${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
echo "=========================================================="
