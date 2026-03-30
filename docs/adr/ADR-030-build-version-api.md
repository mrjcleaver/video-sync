# ADR-030: Build Version API Endpoint

**Status**: Accepted
**Date**: 2026-03-30

## Context

The UI renders a build badge (`v0.2.0 · a3ebe2a · Xh ago`) from `NEXT_PUBLIC_*` env vars baked in at build time. There is no machine-readable way to confirm which version is running on a given deployment — health checks, monitoring tools, and deployment scripts have no API to query.

## Decision

Expose `GET /api/version` returning a JSON object with the build metadata baked at image build time.

### Response shape

```json
{
  "version": "0.2.0",
  "sha": "a3ebe2a",
  "buildDate": "2026-03-22T07:04:54Z"
}
```

All fields are baked at Next.js build time from `NEXT_PUBLIC_*` env vars (same source as the UI badge). The endpoint is unauthenticated and cacheable.

## Consequences

- Monitoring, deployment scripts, and smoke tests can assert the expected SHA is live after a deploy.
- No new build infrastructure required — reuses the `BUILD_SHA` / `BUILD_DATE` Docker build args introduced in ADR-018/Dockerfile.
