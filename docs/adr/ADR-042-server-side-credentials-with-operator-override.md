# ADR-042: Server-Side Credentials With Operator Override

**Status**: Proposed
**Date**: 2026-05-01
**Deciders**: Architecture Team + Key Admins
**Supersedes (in part)**: ADR-035 Level 3 (was deferred indefinitely)
**Related**: ADR-011 (MVP credential proxy pattern), ADR-036 (Workspace authentication), ADR-022 (Compliance / attribution), ADR-039 (Drive artifact storage)

---

## Context

Today every external-platform credential lives in browser `localStorage` per ADR-011: Zoom, YouTube, Fireflies, Kaltura, OpenRouter, OpusClip. Each operator types every credential into `ConnectionsPanel` on first use. ADR-035 Level 3 originally proposed moving these to server-side Secret Manager but was deferred on 2026-04-27 with the rationale that "per-user attribution at the upstream platform layer (YouTube records Alice's actual upload, not 'the org's') is worth more than the operational convenience of one shared credential set."

Two problems with the current state pushed this back onto the agenda:

1. **Onboarding cost.** Every new operator has to acquire and configure six sets of credentials before they can do anything useful. Some of those credentials (Kaltura admin secret, OpenRouter API key) are organisation-level by design — there's no per-operator version that makes sense.

2. **Stale localStorage drift.** When credentials rotate (Kaltura admin secret rotation, OpenRouter key revocation), every operator's browser holds a stale copy until they manually update. Operators silently fail until they re-enter the new secret. The app has no way to push the rotation.

The deferred argument from ADR-035 L3 still has merit *for the credentials where attribution matters* — primarily YouTube. The fix is not "all-or-nothing" but a **hybrid model**: shared defaults from Secret Manager where it makes sense, operator override always available, attribution-sensitive credentials deliberately kept per-operator.

---

## Decision

### Hybrid credential resolution

For each external platform, the app resolves credentials in this order:

1. **Operator's local override** (browser `localStorage`) if present
2. **Shared secret** from Google Secret Manager if a key admin has stored one
3. **Unconfigured** — operator sees "the key admin has chosen not to make this available; provide your own"

The Connections panel shows the active source for every platform, so the operator always knows whether a request will go out as the org's shared identity or as their own.

### Per-platform stance

| Platform | Default source | Operator can override? | Rationale |
|----------|----------------|------------------------|-----------|
| **YouTube** | Per-operator OAuth (no shared default) | n/a — always per-operator | Attribution matters at YouTube's layer (Content ID, copyright disputes, brand-account manager log). See "YouTube brand account" below. |
| **Zoom** | Shared (org-level Server-to-Server OAuth credentials) | Yes — operator may use their own personal Zoom recordings | Most operators import the org's Zoom; the override path covers personal-account imports. |
| **Fireflies** | Shared (org workspace API key) | Yes — operator may use their personal Fireflies account | Same shape as Zoom. |
| **Kaltura** | Shared (org Partner ID + Admin Secret) | No — Admin Secret is privileged | Kaltura admin secret is too high-blast-radius to let an operator type into the UI. If an operator needs alternate Kaltura access, key admin provisions a separate shared secret per environment. |
| **OpenRouter** | Shared (org API key) | Yes — power users can BYO key for higher rate limits | Per-call billing means operator override is occasionally useful. |
| **OpusClip** | Shared (org API key) | Yes | Same shape as Fireflies. |

### YouTube brand account — explicit deliberation

The app uploads to a YouTube **brand account**. Brand accounts have multiple managers; each upload is recorded under the brand channel, but YouTube's internal logs note **which Google identity authorised the upload**. This is the layer at which copyright disputes, Content ID claims, and channel-manager audit trails resolve.

Two viable designs:

**Option A — Shared brand-account OAuth refresh token**
The app holds one OAuth refresh token in Secret Manager. Every upload goes out under that single identity. Operationally simpler — onboarding a new operator doesn't require giving them YouTube authorization. But every upload appears in YouTube's logs as the same Google user, regardless of which operator actually clicked Publish.

**Option B — Per-operator OAuth (recommended)**
Each operator who needs to publish authorises the app to their Google account, which must be a **manager of the brand account**. The OAuth refresh token stays in their browser localStorage (or a future per-operator vault). Uploads appear in YouTube's logs under their identity.

We choose **Option B** because:

- **Accountability is the explicit reason brand accounts support multiple managers.** Collapsing every upload to one identity defeats the design.
- **Copyright disputes route to the human who authorised the action**, not "the org" generically. If a takedown notice arrives, the chain of responsibility is preserved.
- **YouTube's existing audit log is more thorough than ours could be.** Our app-level audit (ADR-041) captures who-clicked-what; YouTube's internal log captures who-Google-says-uploaded. They should agree.
- **Onboarding cost is small.** A manager of the brand account is granted by the brand-account owner inside Google Account settings; once granted, the OAuth flow takes ~30 seconds.

**The cost of Option B**: an operator who isn't a brand-account manager can't publish — by design. They can still curate, run rules, and prepare videos for someone else to publish. Key admins manage the brand-account manager list at the YouTube channel level.

### Roles in the credential lifecycle

| Action | Who can do it |
|--------|--------------|
| **Read shared secret** at runtime | Cloud Run runtime SA (per-platform Secret Manager IAM grants) |
| **Write shared secret** | Key admins, via a server-side admin endpoint gated on `actor.role === "Admin"` |
| **Read operator override** | The operator's own browser only (localStorage) |
| **Write operator override** | The operator (any role) via Connections UI |
| **See "this is currently using a shared default vs. an override"** | Every operator on the Connections panel |

Key admins write shared secrets through the **same UI** operators use. The distinction is the toggle:

- **"Save as shared default"** → Cloud Run admin endpoint persists to Secret Manager. Effective for everyone next time their session resolves credentials.
- **"Override locally"** → operator's browser localStorage. Same UI, scoped only to that browser.

When a key admin edits Connections, the UI defaults to **Override locally** (the safe default) and forces an explicit click to flip to **Save as shared default**. This avoids the failure mode where a key admin meaning to test with their personal account accidentally overwrites the org's Kaltura credentials.

### UX detail — Connections panel modes

```
┌─────────────────────────────────────────────────────┐
│ Zoom                                                │
│ Status: ✓ Configured                                │
│ Source: Shared default (set by martin.cleaver       │
│         on 2026-04-15)                              │
│                                                     │
│ [ Use this default ]   [ Override locally… ]        │
└─────────────────────────────────────────────────────┘
```

When overriding:

```
┌─────────────────────────────────────────────────────┐
│ Zoom — Local override active                        │
│ Status: ✓ Configured (override)                     │
│ Source: Your browser only                           │
│                                                     │
│ [account_id, client_id, client_secret form fields]  │
│                                                     │
│ [ Save override ]   [ Drop override → use shared ]  │
└─────────────────────────────────────────────────────┘
```

When key admin is editing:

```
┌─────────────────────────────────────────────────────┐
│ Zoom — Edit shared default                          │
│ ⚠ This affects every operator. To test changes      │
│ with your own account first, choose Override        │
│ locally instead.                                    │
│                                                     │
│ [account_id, client_id, client_secret form fields]  │
│                                                     │
│ ( ) Save as shared default (everyone)               │
│ (•) Override locally (your browser only) ← default  │
│                                                     │
│                                  [ Cancel ] [ Save ]│
└─────────────────────────────────────────────────────┘
```

### Where shared secrets live

Each shared secret is one entry in Google Secret Manager, named:

```
video-sync-shared/<platform>
  zoom              → JSON: { accountId, clientId, clientSecret }
  fireflies         → JSON: { apiKey }
  kaltura           → JSON: { partnerId, adminSecret }
  openrouter        → JSON: { apiKey }
  opusclip          → JSON: { apiKey }
```

Runtime SA gets `roles/secretmanager.secretAccessor` on each. The app reads on demand, with a 5-minute in-memory cache (consistent with the group-membership cache from ADR-036).

YouTube is deliberately absent — its credentials are operator-side only, per the deliberation above.

### New API surface

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/credentials/shared` | `GET` | Any authenticated user | Returns a metadata-only summary: per-platform `{ configured: boolean, set_by?: email, set_at?: ISO }`. **Never returns the secret values themselves.** Connections UI uses this to show the "Source: shared default" status. |
| `/api/credentials/shared/:platform` | `PUT` | Admin role only | Writes the shared secret. Body: the platform-specific JSON shape. Audited via ADR-041. |
| `/api/credentials/shared/:platform` | `DELETE` | Admin role only | Removes the shared secret. After deletion the app falls through to operator override (or "unconfigured"). |
| `/api/credentials/resolve/:platform` | `GET` | Any authenticated user | Internal helper used at runtime by handlers that need a credential. Returns the active credential from cache. **Never serves credentials to the client.** |

The existing platform endpoints (`/api/zoom/recordings`, `/api/youtube/upload`, etc.) continue accepting credentials in the request body so the override path keeps working without rewriting every handler. When the body omits credentials, handlers consult the shared resolver.

---

## Consequences

### Positive

- **Onboarding drops to ~one minute** for the common case. Operators inherit Zoom, Fireflies, Kaltura, OpenRouter, OpusClip from the org's shared defaults; only YouTube needs personal OAuth.
- **Credential rotation becomes a key-admin operation, not an operator-by-operator support task.** Update the shared secret once; cache clears in 5 minutes.
- **Attribution at YouTube preserved.** Per-operator OAuth keeps the brand-account manager log accurate.
- **Override path remains** for the operator who needs to use a personal Zoom account, BYO an OpenRouter key, etc.
- **Failure mode for key admins is forgiving.** The "Override locally" default makes "test with my account before pushing org-wide" the easy path.

### Negative

- **Increased blast radius if Cloud Run is compromised.** A Cloud Run RCE could exfiltrate every shared secret. Today an attacker would need to compromise individual operators' browsers. Mitigations: workload identity, Secret Manager audit logging, secret rotation cadence.
- **Two-mode UI is more code than one-mode.** Distinguishing "shared default" / "override active" / "key admin editing shared" is meaningfully more complex than ADR-011's flat localStorage form.
- **YouTube onboarding still needs the operator to be a brand-account manager.** That's a Workspace/YouTube admin step that can't be automated by the app — the key admin does it once per new operator outside the app.
- **Per-instance cache means rotation propagation is bounded by the longest-living instance**, up to 5 minutes. Add a "flush credentials cache" admin endpoint to push faster.

### Risks

- **A key admin accidentally clicking "Save as shared default" while testing.** Mitigated by the default-to-override UI pattern + an explicit confirm. Worst case the next operator sees the wrong credential briefly until the admin reverts.
- **Shared OpenRouter key getting rate-limited under burst.** Mitigation: the per-operator override path lets power users BYO key without affecting others.
- **Drift between Secret Manager and local override after rotation.** If the shared secret rotates, operators who still have an override don't pick up the new secret. The Connections UI surfaces "your override is older than the shared default" so the operator can decide.
- **Audit-log richness.** Today the app's audit (ADR-041) shows "alice@... published video X". With shared YouTube credentials it would not show *whose* YouTube account did the upload. Per-operator OAuth (Option B) keeps the two layers consistent.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **All credentials per-operator (status quo, ADR-011)** | Onboarding cost; rotation drift; org-level credentials (Kaltura admin secret, OpenRouter key) shouldn't be typed into operator browsers anyway. |
| **All credentials shared, including YouTube (Option A above)** | Loses per-operator attribution at YouTube — explicit reason brand accounts allow multiple managers. |
| **Per-operator OAuth for everything** | Doesn't help for credentials that have no per-operator concept (Kaltura admin secret is org-only). |
| **Use HashiCorp Vault / external secret manager** | Google Secret Manager is already integrated with our Cloud Run runtime SA; adding Vault is operational overhead with no per-secret benefit at this scale. |
| **Encrypt credentials in `data/catalog.json`** | Conflates app state with secrets; rotation requires mutating a state file; recovery scenarios get harder. Secret Manager is purpose-built. |
| **Workload Identity Federation per operator** | Overkill — IAP already authenticates the operator and we don't need them to mint Google API tokens directly. |

---

## Implementation phases

Suggested incremental rollout to minimise risk:

### Phase 1 — Shared resolver, no UI changes

- New `/api/credentials/shared` (read), `/api/credentials/shared/:platform` (write/delete)
- Server-side resolver (read shared first, fall through to body-passed credentials)
- Existing handlers refactored to call the resolver when body credentials are absent
- No UI yet — operators still see exactly the same Connections panel
- Key admin populates shared secrets via curl + admin endpoint

Rolling this out alone gives us the credential-rotation benefit immediately without a UI risk.

### Phase 2 — Connections panel mode-aware

- UI shows "Source: shared default | override | unconfigured" badge per platform
- Override-vs-shared toggle on edit, with the key-admin guard
- "Drop override → use shared" button surfaces when both exist

### Phase 3 — Audit + cache management

- Shared-secret writes flow through ADR-041 audit log (`audit: "mutation"`, `actor_email: <key-admin>`)
- Admin "Flush credential cache" endpoint for fast rotation propagation

### Phase 4 — Migration helpers

- For each operator's existing localStorage credentials, on next page load: detect overlap with shared secrets, offer "Adopt shared default" (drop override) vs "Keep my override"

---

## Open questions

1. **OpusClip**: confirm it has a meaningful per-operator override case. If not, treat like Kaltura (shared-only).
2. **OpenRouter rate-limit per-operator burst**: do we want a per-operator OpenRouter key as the default for any role, with shared as fallback? Inverts the priority order.
3. **Brand-account manager list maintenance** is a Workspace/YouTube admin task. Should we surface "you are/aren't a brand-account manager" in the Connections panel as a diagnostic? Requires reading channel ACL via YouTube API.
4. **Rotation cadence**: 90 days for the shared secrets is a sensible default but should be policy-driven, not engineering-driven. Defer to IT (per the recent group-structure note).
5. **Does the key-admin "Save as shared default" need a second-person approval** for high-blast-radius secrets (Kaltura admin)? Probably not at our scale; flag if our user count grows.

---

## References

- ADR-011: MVP Credential Proxy Pattern — the localStorage status quo this ADR partially replaces
- ADR-022: Compliance audit (provenance footers) — domain-level attribution
- ADR-035: Persistence topology — Level 3 was the original "credentials on the server" plan, deferred 2026-04-27
- ADR-036: Workspace authentication — actor identity that gates the new admin endpoints
- ADR-039: Drive-based artifact storage — uses runtime SA without per-operator OAuth; informs the "what credentials should be shared" pattern
- ADR-041: App-level audit log — captures shared-secret writes
