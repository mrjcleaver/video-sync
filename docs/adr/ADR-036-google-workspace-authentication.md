# ADR-036: Google Workspace Authentication and Role-Based Access

**Status**: Proposed
**Date**: 2026-04-22
**Deciders**: Architecture Team
**Scope**: Implements ADR-035 Level 4 (multi-user identity), enables ADR-035 Level 3 (server-side credentials), supersedes part of ADR-011 (browser-only credential proxy)

---

## Context

ADR-035 documents that Video Bridge is currently single-browser, single-operator. ADR-011 chose a browser-localStorage credential pattern as an MVP shortcut, deferring real auth to "when multi-user is added."

That moment has arrived. The operator (Martin Cleaver, `martin.cleaver@agentics.org`) wants other people in the `agentics.org` Google Workspace to be able to log in and use the system, with **different permissions for different groups**:

1. **Viewers** — can see the catalog and watch state evolve, but cannot mutate anything or trigger uploads
2. **Operators** ("take-action") — can approve, skip, abandon, publish, run backfill, link sibling records, recover from YouTube — i.e. everything that mutates a `VideoRecord`
3. **KeyAdmins** — can configure platform connections (add/rotate/revoke credentials for Zoom / Fireflies / YouTube / Loom / Kaltura / OpenRouter / OpusClip)

This is exactly the Level 4 step from ADR-035. It naturally pulls in Level 3 (credentials must move out of browser localStorage and into a server-side, per-org or per-user store) because credentials in the browser cannot be safely shared between Viewers and Operators on different machines.

### Why Google Workspace, not custom auth

- All intended users are already in `agentics.org` Google Workspace
- Google OAuth is the same identity provider already used for the YouTube destination, so there's no new IdP to manage
- Workspace **groups** give us natural role assignment without building a user/role admin UI
- Identity-Aware Proxy (IAP) on Cloud Run terminates auth at the edge — minimal app-side code

### Anti-goals

- **Not building a registration flow.** Membership is gated by Workspace group; if you're not in `agentics.org` you can't log in.
- **Not building a self-serve admin UI for role changes.** Group membership is managed in Google Workspace by the org admin. The app reads it; it doesn't write it.
- **Not multi-tenant.** This ADR is for one Workspace (`agentics.org`). Multi-tenant deployments would be a separate ADR.

---

## Decision

### 1. Identity-Aware Proxy on Cloud Run

Place Cloud Run behind **Google Cloud Identity-Aware Proxy** (IAP) configured for OAuth-based access:

- Allowed audience: members of the `agentics.org` Workspace
- IAP terminates auth at the load balancer; the Next.js app receives a JWT in `X-Goog-IAP-JWT-Assertion` containing the user's email, sub (stable user ID), and Workspace-issued claims
- The Cloud Run service goes from `--allow-unauthenticated` to `--no-allow-unauthenticated` once IAP is in place

App-side cost: a small middleware that validates the JWT signature and exposes `req.user = { email, sub }`. No bespoke OAuth flow to maintain.

### 2. Three Workspace groups for role assignment

Create three groups in Google Workspace under `agentics.org`:

| Group | Email | Members |
|-------|-------|---------|
| **Viewers** | `video-sync-viewers@agentics.org` | Anyone allowed to look at the catalog |
| **Operators** | `video-sync-operators@agentics.org` | Curators who run the publish pipeline |
| **KeyAdmins** | `video-sync-key-admins@agentics.org` | Trusted admins who hold platform credentials |

A user can be in multiple groups (membership is additive — KeyAdmin should also be in Operators and Viewers if they're expected to use those features).

The app derives the effective role on every request by querying the **Cloud Identity Groups API** for the authenticated user's group membership. Result is cached server-side per session (TTL 5 minutes) to avoid an API call on every request.

A user not in any of the three groups gets a "Not authorised" page with their email shown so the org admin knows whom to add to which group.

### 3. Domain model: actor attribution

The Rust `Actor` value object already carries `user_id` and `role`. Today both are hard-coded:

```ts
const ADMIN_ACTOR = JSON.stringify({
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "Admin",
});
```

This becomes:

```ts
// On every command call, derived from the authenticated session
const actor = {
  user_id: <stable Google sub claim, mapped to a UUID>,
  role: highestGroupOf(req.user.email),  // "Viewer" | "Publisher" | "Admin"
};
```

The existing `UserRole` enum (`Admin` / `Publisher` / `Viewer` per ADR-002) maps cleanly to the three Workspace groups:

- `Viewers` group → `UserRole::Viewer`
- `Operators` group → `UserRole::Publisher`
- `KeyAdmins` group → `UserRole::Admin`

The Rust domain already has authorization checks (`is_admin_or_publisher`, `can_curate`) — they activate as soon as we stop using the hard-coded admin actor.

### 4. Server-side credential vault (Level 3)

When KeyAdmins configure a platform connection, the credentials must live somewhere usable by **any** authenticated Operator's session, not just the KeyAdmin's browser. Two options considered:

| Option | Verdict |
|--------|---------|
| **Per-user Secret Manager entries** | Rejected — credentials are organisational, not personal. A YouTube channel belongs to the org, not to the KeyAdmin who pasted the secret. |
| **Per-org (single-vault) Secret Manager entries** | **Accepted.** One set of credentials per platform, scoped to this Cloud Run service. Any authorised Operator can drive the publish pipeline using the org's credentials. |

Storage: Google Cloud **Secret Manager**, one secret per platform per credential field:

```
video-sync-zoom-account-id
video-sync-zoom-client-id
video-sync-zoom-client-secret
video-sync-youtube-client-id
video-sync-youtube-client-secret
video-sync-youtube-refresh-token
video-sync-fireflies-api-key
video-sync-loom-api-key
video-sync-kaltura-partner-id
video-sync-kaltura-admin-secret
video-sync-openrouter-api-key
video-sync-openrouter-model            (optional)
video-sync-opusclip-api-key
```

`OPENROUTER_API_KEY` is already in Secret Manager — that pattern extends to the rest. The Cloud Run runtime SA gains `roles/secretmanager.secretAccessor` on each.

**Connections panel changes** (KeyAdmins only):

- Reads current values via `GET /api/connections` — KeyAdmins see redacted previews (`sk-or-…`); Operators get a boolean "configured / not configured"; Viewers see nothing.
- Writes via `POST /api/connections` — only KeyAdmins, validated against IAP JWT + group membership.
- Audit: every connection mutation produces a structured log with the actor email, platform, field changed (not the value), and timestamp.

ADR-011 is partly superseded by this: localStorage credentials remain a fallback for development (when running outside IAP, e.g. local dev) but production uses the vault. A migration utility exports current localStorage credentials to Secret Manager once for the existing KeyAdmin.

### 5. Per-user state (deferred)

Some current state is implicitly per-user — rejection lists ("Not a match"), the privacy/uploads cache, the per-card log toggle. After this ADR, those are still per-browser (they live in localStorage), which means:

- Two Operators see each other's videos and rules (server-side after Level 2)
- They each maintain their own rejection list and caches independently

This is acceptable for v1 of multi-user. A future ADR can promote rejections to a server-side per-user store keyed by Workspace `sub`. Until then, the localStorage pattern continues for these specific items.

### 6. CI / deploy implications

- `deploy.sh` adds `--no-allow-unauthenticated` and IAP configuration flags
- The CI workflow (`.github/workflows/deploy.yml`) still doesn't deploy because of the credentials_json blocker (ADR-018), but its IAP config can be staged for the WIF migration
- `scripts/iap-setup.sh` (new, one-time) creates the OAuth consent screen entry, configures IAP, creates the three Workspace groups, and binds the Cloud Run Invoker permission to all three groups (everyone in any group can reach the service; in-app role check distinguishes capabilities)

---

## Consequences

### Positive

- Multiple people can use Video Bridge concurrently from any browser
- Credentials no longer travel through request bodies — the XSS attack surface from ADR-011 closes
- Real audit trail: every state transition has an authenticated email attached
- Group changes (Workspace admin) take effect within 5 minutes (cache TTL); no app deploy needed
- IAP gives us authentication for free (no app-side OAuth flow to maintain)

### Negative

- New blocking dependency: the Workspace org admin must create three groups and grant the Cloud Run Invoker IAM role
- IAP adds a dependency on Google Cloud's identity layer — local development needs a way to bypass IAP (env-var allowlist for `localhost` is the usual pattern)
- Secret Manager calls add ~50ms latency to first request after a cold start (mitigated by the Cloud Run "always-warm" SA cache)
- Per-user state migration (rejection lists, caches) is intentionally deferred — Operators' rejection lists won't be shared between them initially, which may surprise users coming from a single-user mental model

### Risks

- **JWT validation bypass**: if the app ever serves a request without IAP in front (misconfigured load balancer, direct Cloud Run URL exposed), the auth middleware must still reject it. Mitigation: in production, require the IAP JWT and refuse requests without one. Local dev sets `ALLOW_NO_IAP=1`.
- **Group sync staleness**: a KeyAdmin removed from the group still has 5 minutes of access. Mitigation: short TTL on the cache; admin can force-flush via an internal endpoint when revoking access urgently.
- **Credential leakage via logs**: the redaction in ADR-017 already covers this, but new code paths (the connection vault) need explicit audit. Mitigation: write a test that round-trips every credential through the logger and asserts `[REDACTED]` in the output.
- **Bootstrap chicken-and-egg**: the first KeyAdmin must add themselves to the KeyAdmins group via Workspace before the app trusts them. Mitigation: `scripts/iap-setup.sh` adds the running operator to the KeyAdmins group as part of setup.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **Custom email/password auth** | Reinvents identity, requires password storage, MFA, recovery flows, etc. — and all users are already in Workspace. |
| **Auth0 / Clerk / Stytch** | External dependency, monthly cost, extra IdP relationship — when Workspace already provides the answer for this user base. |
| **App-level OAuth (no IAP)** | Workable, but the app then handles JWTs, sessions, refresh, CSRF. IAP at the load balancer is strictly less code to maintain. |
| **Per-user credential vaults** | Conflicts with "credentials are organisational" — also creates the worst-of-both-worlds where Operator A has authorised YouTube but Operator B hasn't, leading to confusing publish failures. |
| **No groups, just allowlist by email** | Works for two users; doesn't scale and doesn't express "who can do what" cleanly. Groups in Workspace already do this. |

---

## Open questions

1. **Local development experience**: how does an Operator run the app locally and authenticate? Probably `ALLOW_NO_IAP=1` + a static dev user with all roles, plus a checked-in note that production is IAP-gated.
2. **OAuth callback for YouTube under IAP**: when a KeyAdmin authorises YouTube, the callback URL must reach the app *through* IAP. Verify the Google OAuth redirect URI matches the IAP-fronted hostname.
3. **Cost**: IAP is free for up to a small number of users; verify against the current Workspace size. Secret Manager has free-tier coverage well beyond what we'd use.
4. **Audit log retention**: how long do we keep the per-user audit trail for credential changes? Cloud Logging default is 30 days; for compliance we may want longer.
5. **Headless/automation access**: backfill orchestrator currently runs in the browser. If a future cron-driven orchestrator wants to publish autonomously, it needs a service-account identity inside the IAP, separate from human users. Out of scope for this ADR.

---

## Implementation phases

| Phase | Scope | Blocking |
|-------|-------|----------|
| **1** | Workspace groups created, IAP configured on Cloud Run, JWT middleware in app, hard-coded ADMIN_ACTOR replaced with derived actor. App still uses localStorage credentials — no behaviour change for the existing single user. | Workspace admin grant, IAP setup. |
| **2** | `/api/connections` GET/POST routes backed by Secret Manager, Connections panel rewritten to call them, ADR-011 localStorage path retained as dev fallback. | Phase 1; Secret Manager IAM grants. |
| **3** | Server-side audit log for connection changes, redaction tests, force-flush endpoint for group cache. | Phase 2. |
| **4** (later, separate ADR) | Per-user rejection lists / privacy caches in server store, replacing the per-browser localStorage entries. | Phase 1; ADR-035 Level 2 (catalog on server). |

---

## Related ADRs

- **ADR-002**: Unified Video Metadata Schema — defines `UserRole::Admin/Publisher/Viewer` which this ADR maps to Workspace groups
- **ADR-007**: OAuth 2.0 Token Management — token refresh remains as specified; the storage location moves from browser localStorage to Secret Manager
- **ADR-010**: Authentication Configuration for External Services — covers operator-side credential lifecycle. This ADR introduces the *human* auth layer that gates that flow.
- **ADR-011**: MVP Credential Proxy Pattern — partially superseded; localStorage retained as dev fallback only
- **ADR-017**: Observability — actor attribution on every event, redaction tests for credential paths
- **ADR-018**: Google Cloud Hosting — IAP and Secret Manager already used; this ADR extends the pattern
- **ADR-035**: Persistence Topology — this ADR implements Level 4 (identity) and most of Level 3 (server credentials)

---

## Addendum: QE Fleet Review (2026-04-22)

Three parallel review agents — security, code-review, test-coverage — audited the Phase 1 implementation immediately after it landed. This addendum records what they found, what was fixed in the same commit, and what remains.

### Fixed in the QE-response commit

| Finding | Source | Fix |
|---------|--------|-----|
| **Boot-time misconfiguration silently disables auth** when both `ALLOW_NO_IAP=1` and `IAP_AUDIENCE` are set | sec#2, rev#5 | `lib/auth.ts` throws at module load if both env vars are set. The error message instructs the operator to choose one. |
| **`actorJsonOrFallback` returns Admin even on 401** — silent privilege escalation on a real auth failure | sec#3, rev#5 | New `withActor(state, extra)` helper returns `null` on the error path; callers must treat it as deny. The legacy `actorJsonOrFallback` is kept (deprecated) for the one already-migrated callsite to avoid a partial behaviour change in the same commit. New code uses `withActor`. |
| **`/api/auth/me` missing `Cache-Control: no-store`** — auth response could be cached by browser, CDN, or Next route cache | rev#4 | Added `Cache-Control: no-store, no-cache, must-revalidate, private`, `Pragma: no-cache`, `export const dynamic = "force-dynamic"`. |
| **Email / sub / JWT not in log redaction** | sec#5 | `lib/logger.ts` extends `REDACT_KEYS` with `email`, `sub`, `x-goog-iap-jwt-assertion`, `iapJwt`, `jwt`, and adds a JWT-shape value pattern (`/^eyJ.+\..+\./`). |
| **`lookupRole()` returns Viewer for unknown users** — anyone in `agentics.org` who passes IAP becomes a Viewer regardless of group membership | sec#8, rev#9 | `lookupRole()` now returns `null` for users in no group; `getActor()` throws "Access denied" so the request 401s. |
| **`iap-setup.sh` does not enable `cloudidentity.googleapis.com`** — first-run fails at `gcloud identity groups create` | rev#10 | Added to the API-enable list. |
| **`DEV_ACTOR.email = "dev@localhost"`** would pollute prod-shaped log queries | rev#14 | Changed to `dev-actor@invalid` (RFC-6761 reserved TLD). |

### Follow-up commit (2026-04-22) — addressed remaining gaps

The ADMIN_ACTOR migration, error-surfacing UI, type dedup, RFC-4122 namespace fix, flush-cache endpoint, and a Vitest test suite all landed shortly after. Status:

| Finding | Source | Status |
|---------|--------|--------|
| 30 ADMIN_ACTOR call sites unmigrated | rev#1/#2/#3 | **Fixed.** All 31 call sites (incl. the page.tsx bulk-approve and BackfillPanel's 3 inline literals) now use the `actorCommand(state, extra)` helper. ADMIN_ACTOR consts removed from VideoCard, ShortsPanel, useRuleRunner. `CurrentActorProvider` lifted to `app/providers.tsx` so Dashboard itself can call the hook. |
| `useCurrentActor` doesn't surface error to UI | rev#6 | **Fixed.** Red banner on the Dashboard when `actorState.error` is set, telling the user to contact their Workspace admin. |
| Type duplication | rev#8 | **Fixed.** `lib/types/actor.ts` is the single source; both auth.ts and useCurrentActor.tsx import from it. `ClientActor = Omit<Actor, "sub">` makes the relationship explicit. |
| UUIDv5 namespace not RFC-4122 | sec#6 | **Fixed.** Uses a fixed namespace UUID + RFC-4122 v5 algorithm (SHA-1 of namespace bytes ‖ name bytes, version+variant nibbles set). Reproducible by `uuidv5(sub, NAMESPACE_UUID)` in any conformant library. |
| `flushGroupCache()` no endpoint | sec#7/rev#11 | **Fixed.** `POST /api/auth/flush-cache` requires authenticated Admin role; 401 unauth, 403 non-admin, 200 on success. |
| Test coverage = 0 | tester | **Started.** Vitest + jsdom + @testing-library/react installed. Initial spec at `web/tests/auth.test.ts` covers ALLOW_NO_IAP dev-mode, the two-flag misconfiguration guard, no-JWT-header rejection, and UUID determinism. 4 tests passing. The remaining ~16 cases from the QE matrix (JWT audience, expiry, group cache TTL, role precedence, hook lifecycle, VideoCard.approve roundtrip) are tracked as next-up. |

### Outstanding (still real, tracked)

| Finding | Source | Plan |
|---------|--------|------|
| **Production deploy still has `--allow-unauthenticated` AND `ALLOW_NO_IAP=1`** | sec#1 | Acceptable while catalog is browser-local; **must** run `iap-setup.sh` before ADR-035 Phase 2 (catalog-on-server) ships. |
| **Role mapping env-var-only** | sec#4 | **Resolved.** `lookupRole()` now queries Cloud Identity API (`groups/-/memberships:searchTransitiveGroups`) using a metadata-server access token from the runtime SA. `WS_DOMAIN` env var drives group-name derivation (`video-sync-{role}s@{WS_DOMAIN}`). Env-var allowlists remain as a fallback path used only if the API call fails — so a transient Cloud Identity outage doesn't 401 every authenticated user. The runtime SA needs permission to read group membership: simplest path is adding the SA's email (`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`) as a Manager on each of the three groups in Workspace Admin. |
| Remaining 16 of 20 QE-recommended test cases | tester | Next-up commits as the surface stabilises. |

### Outcome

Phase 1 of ADR-036 is **functionally complete** with one structural caveat: the production service still runs without IAP enforcement, by design, until ADR-035 Phase 2 makes it security-critical. Everything required to flip the switch (auth lib, JWT verification, role-based actor derivation, error UI, audit-friendly flush endpoint, test scaffolding) is now in place. The cutover is a deploy-config change once `iap-setup.sh` runs successfully.
