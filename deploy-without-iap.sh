#!/usr/bin/env bash
#
# Deploy to Cloud Run WITHOUT IAP enforcement — emergency / dev escape
# hatch (video-sync service, agentics-487016 project).
#
# Production has been on IAP since 2026-04-27 (ADR-036 Accepted). The
# normal deploy is `bash deploy.sh`. Use this wrapper only when:
#   - IAP setup needs to be temporarily rolled back
#   - You're testing something locally and don't want to authenticate
#   - The IAP layer itself is broken and you need to deploy past it
#
# What this gives you:
#   --allow-unauthenticated     → service URL is publicly reachable
#   ALLOW_NO_IAP=1              → /api/auth/me returns the synthetic
#                                  Admin actor; mutating UI works
#   no IAP gating               → anyone with the URL has Admin
#
# What this LOSES:
#   per-user audit trail (everyone is the synthetic admin)
#   group-membership access control
#
# Mechanism: explicitly clears IAP_AUDIENCE so deploy.sh's mode
# detector picks Open mode (it defaults to IAP mode when IAP_AUDIENCE
# is unset).

set -euo pipefail

export IAP_AUDIENCE=
export KEY_ADMIN_EMAILS=martin.cleaver@agentics.org
export OPERATOR_EMAILS=agent@agentics.org,mondweep.chakravorty@agentics.org
export VIEWER_EMAILS=board@agentics.org

bash "$(dirname "$0")/deploy.sh"