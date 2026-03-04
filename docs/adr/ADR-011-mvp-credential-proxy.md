# ADR-011: MVP Credential Proxy Pattern

**Status:** Accepted
**Date:** 2026-02-15
**Deciders:** Engineering team

## Context

The Video Bridge MVP needs to call the Zoom Server-to-Server OAuth API, which requires `account_id`, `client_id`, and `client_secret`. Browser-based JavaScript cannot call `zoom.us/oauth/token` directly due to CORS restrictions, so a server-side proxy is needed.

ADR-007 specifies encrypted server-side credential storage, and ADR-010 outlines production-grade credential management. Implementing either fully would delay the MVP significantly.

## Decision

Credentials are stored in `localStorage` on the client and sent in the POST body to a same-origin Next.js API route (`/api/zoom/recordings`). The API route exchanges them for an access token, fetches recordings, and returns results. No credentials are logged or persisted server-side.

## Tradeoffs

### Acceptable for MVP

- **Same-origin only:** The API route is served from the same origin as the app; credentials never leave the user's browser/server pair.
- **No credential leakage in logs:** The route does not log request bodies.
- **Simple implementation:** No database, no encryption key management, no session infrastructure.

### Known Risks

- **XSS vulnerability:** If the app has an XSS flaw, an attacker could read credentials from `localStorage`. This is the primary risk.
- **No token caching:** Each fetch request generates a new Zoom access token. Acceptable at MVP scale.
- **Credentials in transit within request:** Although same-origin and over HTTPS, credentials travel in the request body rather than being stored server-side.

## Migration Path

1. Add a server-side credential store (encrypted at rest, per ADR-007).
2. Update `ConnectionsPanel` to save credentials via a server API instead of `localStorage`.
3. Update `/api/zoom/recordings` to read credentials from the server store instead of the request body.
4. Remove credential fields from the client-side `localStorage` payload.

## References

- ADR-007: OAuth2 Token Management
- ADR-010: Authentication Configuration
