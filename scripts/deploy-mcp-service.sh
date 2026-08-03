#!/bin/bash
# ADR-066 §4 follow-up — deploy the SECOND Cloud Run service that hosts
# the public no-IAP MCP endpoints (RPC + register + token). Shares the
# same container image + same FUSE-mounted GCS bucket as the main
# IAP-fronted service, so both instances see the same catalog / token /
# OAuth-code stores.
#
# The main service (video-sync) keeps IAP + serves the OAuth /authorize
# consent page (needs the operator's browser session). The public
# service (video-sync-mcp) is --allow-unauthenticated: its auth is
# enforced by our own Bearer-token / OAuth code exchange logic in
# getActor().
#
# Usage:
#   ./scripts/deploy-mcp-service.sh <image-tag>
# Example:
#   ./scripts/deploy-mcp-service.sh bf1f5d8-1005

set -euo pipefail

IMAGE_TAG="${1:?image tag required (e.g. bf1f5d8-1005)}"
REGION="us-central1"
PROJECT="agentics-487016"
BUCKET="video-sync-data-agentics-487016"
MAIN_SERVICE="video-sync"
MCP_SERVICE="video-sync-mcp"

MAIN_ORIGIN="https://video-sync.agentics.org"
IMAGE="us-central1-docker.pkg.dev/${PROJECT}/video-sync/app:${IMAGE_TAG}"

echo "── Deploying ${MCP_SERVICE} (public, no IAP) with image ${IMAGE}"

# Copy pertinent env vars from the main service. We deliberately drop
# IAP_AUDIENCE — the public service serves MCP endpoints where IAP
# JWTs are not expected, and setting IAP_AUDIENCE causes JWT-verify
# to reject requests that would otherwise route through the Bearer /
# OAuth-code path.
gcloud run deploy "${MCP_SERVICE}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --project="${PROJECT}" \
  --allow-unauthenticated \
  --service-account="667037737667-compute@developer.gserviceaccount.com" \
  --add-volume=name=data,type=cloud-storage,bucket="${BUCKET}" \
  --add-volume-mount=volume=data,mount-path=/app/data \
  --set-env-vars="NODE_ENV=production" \
  --set-env-vars="ALLOW_NO_IAP=0" \
  --set-env-vars="MEMORY_LIMIT_MB=1024" \
  --set-env-vars="WS_DOMAIN=agentics.org" \
  --set-env-vars="NEXT_PUBLIC_MCP_MAIN_ORIGIN=${MAIN_ORIGIN}" \
  --quiet

MCP_URL=$(gcloud run services describe "${MCP_SERVICE}" --region="${REGION}" --format="value(status.url)")

echo ""
echo "── Deployed. MCP public service URL:"
echo "   ${MCP_URL}"
echo ""
echo "── Next step: update the MAIN service with the public MCP origin"
echo "   so its well-known docs advertise this URL:"
echo ""
echo "   gcloud run services update ${MAIN_SERVICE} \\"
echo "     --region=${REGION} \\"
echo "     --update-env-vars=NEXT_PUBLIC_MCP_PUBLIC_ORIGIN=${MCP_URL}"
echo ""
echo "── And re-deploy the MCP service ONCE with the same var so its"
echo "   own well-known docs match:"
echo ""
echo "   gcloud run services update ${MCP_SERVICE} \\"
echo "     --region=${REGION} \\"
echo "     --update-env-vars=NEXT_PUBLIC_MCP_PUBLIC_ORIGIN=${MCP_URL}"
