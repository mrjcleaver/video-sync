# ADR-045: Wider IAP Gate + App-Level Redirect for Unauthorized Users

**Status**: Accepted (implemented 2026-05-22)
**Date**: 2026-05-22
**Deciders**: Architecture Team
**Extends**: ADR-036 (Google Workspace authentication), ADR-041 (app-level audit log)

---

## Context

`video-sync.agentics.org` is fronted by Identity-Aware Proxy bound to three Workspace groups (`video-sync-key-admins`, `video-sync-operators`, `video-sync-viewers`). Any visitor who is not in one of those groups currently sees Google's default **"You don't have access"** page — an opaque dead end that gives no hint about what the project is, where to learn about it, or how to request access.

We want unauthorized visitors to land on the **project wiki** (`https://github.com/mrjcleaver/video-sync/wiki`) instead, where they can read about the project and find the right contact to request access.

Three places this redirect could live, with very different blast radii:

| Option | Where | Pros | Cons |
|---|---|---|---|
| A. App-level page | `app/page.tsx` server component or middleware | No infra change. Tied to app deploy. | Doesn't help users IAP blocks at the edge — they never reach the app. |
| B. Wider IAP gate + app-level redirect | IAP allows the whole Workspace domain; app resolves role and 302s on no-role | Single code change (already needed for any "unauthorized" UX). Audit log still records every request. | The HTML shell is reachable by any @agentics.org user; we rely on API-route authorization (not just the IAP gate) to prevent data leakage. |
| C. HTTPS Load Balancer with custom 403 page | Cloud LB in front of Cloud Run, IAP attached to backend service, custom error response policy | Unauthorized users never see the app's HTML. | New infrastructure (LB + cert + DNS + NEG); IAP audience format changes; more cost. |

## Decision

**Adopt Option B.** Widen the IAP allow-list to `domain:agentics.org` while keeping the three role groups for actual authorization. The app already verifies the IAP JWT and resolves the role via Cloud Identity (ADR-036); we extend that path so a successful JWT + no role → 302 to the wiki.

## Implementation

1. **Infra (`scripts/iap-setup.sh`)** — adds idempotent `add-iam-policy-binding` calls binding `domain:agentics.org` to:
   - `roles/run.invoker` on the Cloud Run service
   - `roles/iap.httpsResourceAccessor` on the IAP web resource
2. **App (`web/src/lib/useCurrentActor.tsx`)** — the existing `/api/auth/me` fetch already returns 401 when `getActor` throws ("not a member of any video-sync group"). On `r.status === 401`, the provider now calls `window.location.replace(UNAUTHORIZED_REDIRECT_URL)` *before* setting the error state, so the SPA never finishes booting in an unusable form.
3. **Configurable target** — the redirect URL reads from `NEXT_PUBLIC_UNAUTHORIZED_REDIRECT_URL`, defaulting to the GitHub wiki. This means we can re-point to an org-specific landing page later without a code change.
4. **Audit** — every request still emits an audit entry (ADR-041). The redirected user's email, route, and 401 status are all captured, so admins can see who hit the gate.

## Trust boundary still enforced at the app layer

Widening IAP means the HTML shell, the Next.js JS bundle, and a handful of public-by-design routes (`/api/health`, `/api/version`) are reachable by any `@agentics.org` user. Authorization for everything else is enforced *inside* the route handler via `getActor(req)` — which throws for users without a role. The JWT verification on every API call is the actual security boundary, not the IAP allow-list.

The exposure is:
- **HTML shell** — branding only; no data
- **`/api/auth/me`** — returns the requester's own actor; on 401, only the actor's email (already in their own browser session) appears in the error
- **`/api/health`**, **`/api/version`** — already designed as public probes
- **Everything else** — `getActor` throws on missing role → 401 with no body

We accept this exposure. Pre-existing API-route audits (QE fleet, ADR-041) confirm the route handlers gate on `getActor`, not on the assumption that "if you got past IAP, you're authorized."

## Consequences

**Positive**
- Unauthorized visitors land on something useful (the wiki) and can self-onboard via the README/CONTRIBUTING flow.
- Audit log captures attempted access by every Workspace user, not just the ones already in role groups.
- No new infrastructure to deploy or pay for.

**Negative**
- The `agentics.org` Workspace domain becomes the de-facto trust perimeter for "anyone can see the app exists." If we ever need stricter than that (e.g., outside-counsel review where even the existence of the project is sensitive), revisit with Option C.
- A wider IAP allow-list means every `@agentics.org` user counts as an IAP-billed identity in Cloud Logging volume — small, but non-zero.

## Open Questions

- Should the wiki landing page itself link back to a "request access" form? Out of scope here — owned by the project wiki maintainers.
- Should the redirect be a server-side 302 from the root page rather than a client-side `location.replace`? Today's client redirect adds ~200ms of HTML parse + JS execute before the redirect fires. If that becomes a UX issue, promote `app/page.tsx` to a server component that calls `getActor()` + `redirect()` server-side and pushes the 302 in the initial response. The behavior contract is the same either way.
