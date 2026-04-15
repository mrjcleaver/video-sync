#!/usr/bin/bash
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

gcloud run deploy video-sync \
  --image="$IMAGE:$SHA" \
  --region=us-central1 \
  --concurrency=80 \
  --timeout=3600 \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --allow-unauthenticated \
  --no-cpu-throttling \
  --set-env-vars=NODE_ENV=production,MEMORY_LIMIT_MB=1024 \
  --set-secrets=OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest
