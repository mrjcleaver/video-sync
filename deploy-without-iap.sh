#!/usr/bin/env bash
#
# Deploy to Cloud Run WITHOUT IAP enforcement (video-sync service,
# agentics-487016 project). Transitional path while the operator waits
# for Workspace permission to make the runtime SA a group manager
# (required to enable Cloud Identity-driven role lookup, ADR-036 §2).
#
# What this gives you:
#   --allow-unauthenticated     → service URL is publicly reachable
#   ALLOW_NO_IAP=1              → /api/auth/me returns the synthetic
#                                  Admin actor; mutating UI works
#   no IAP gating               → anyone with the URL has Admin (this
#                                  is acceptable while the catalog is
#                                  browser-local; per ADR-035, ADR-036
#                                  addendum)
#
# What this DOESN'T give you:
#   any audit trail of who did what (ADMIN_ACTOR is everyone)
#   any access control on /api/connections (Phase 2)
#
# Once the Workspace request lands, switch to:
#   export IAP_AUDIENCE=...   # from scripts/iap-setup.sh output
#   bash deploy.sh            # IAP-enforced; uses *_EMAILS for role
#
# The *_EMAILS exports below are harmless in this open-mode deploy
# (deploy.sh ignores them when IAP_AUDIENCE is unset) but become the
# role-assignment fallback the moment IAP_AUDIENCE is exported.

set -euo pipefail

export KEY_ADMIN_EMAILS=martin.cleaver@agentics.org
export OPERATOR_EMAILS=agent@agentics.org,mondweep.chakravorty@agentics.org
export VIEWER_EMAILS=board@agentics.org

bash "$(dirname "$0")/deploy.sh"