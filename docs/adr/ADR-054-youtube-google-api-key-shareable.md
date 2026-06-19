# ADR-054: YouTube Google API Key is org-wide shareable; OAuth stays per-operator

**Status**: Accepted (implemented 2026-06-18)
**Date**: 2026-06-18
**Deciders**: Architecture Team
**Related**: ADR-042 (Server-side credentials with operator override), ADR-049/050 (live-stream provenance — the consumer of the YouTube Data API for backfill), ADR-052 (Catch-Up Summary Badge Backfill — also a Data API consumer)

---

## Context

ADR-042 codified that *every shared-able credential lives in Secret Manager, managed by Admins, with a per-operator local-override escape hatch*. The exception called out at the time: **YouTube credentials are per-operator on purpose**, because OAuth uploads need to carry the operator's brand-account identity for accountability.

That made sense for the OAuth credential set (`clientId` / `clientSecret` / `channelId` / `refreshToken` / `ytCookies`) — those literally identify the operator's brand account.

It did *not* make sense for the **Google API Key** (`googleApiKey`). The API Key is a public-data quota mechanism for the YouTube Data API; it has no per-user identity and no brand-account attribution. Treating it the same as OAuth credentials meant every operator had to provision their own key — and the operator who reported [issue #3](https://github.com/mrjcleaver/video-sync/issues/3) couldn't even create one because of an org-level Google Cloud policy restriction.

The breakage: ADR-049/050's C1-A YouTube row backfill and ADR-052's summary badge backfill both rely on `/api/youtube/video-info`, which needs the Google API Key. Without a shared default, the affected operator saw `Backfill error … Metadata fetch failed: video-info 500: {"error":"No Google API key configured..."}` on every row.

Two earlier shipping rounds tried to side-step this: a `GOOGLE_API_KEY` env-var on Cloud Run (admin-only, requires a redeploy), and a per-operator `googleApiKey` field in localStorage Connections (the operator can't create the key). Neither matched the typical operator flow.

## Decision

Treat YouTube as a *hybrid* credential platform: OAuth fields stay per-operator (preserving ADR-042's intent), but `googleApiKey` is **eligible for the shared-default flow** managed by Admins via Secret Manager — same machinery as Zoom / Fireflies / Kaltura / OpenRouter / OpusClip.

Concrete shape: the `googleApiKey` field becomes a one-field shared credential for the `youtube` platform key, distinct from the per-operator OAuth credentials still scoped to localStorage.

### Mechanism — `sharedEligibleFields`

Generalised through a new `sharedEligibleFields?: string[]` on `PlatformInfo` (`ConnectionsPanel.tsx`). When set, the shared-default editor for that platform exposes only the listed fields; other fields remain available exclusively via the per-operator override flow.

For YouTube:

```ts
sharedEligibleFields: ["googleApiKey"]
```

When admin opens "Set as shared default" on the YouTube card, they see only the Google API Key field. The OAuth fields are reserved for the per-operator override flow as before. The `handleSave` shared branch whitelists the POST body to `sharedEligibleFields` only, so an admin who somehow typed an OAuth value into a hidden field can't accidentally upload OAuth credentials to the org-wide secret.

For Zoom / Fireflies / Kaltura / OpenRouter / OpusClip: `sharedEligibleFields` is undefined → all fields participate in the shared flow as today (no behaviour change).

### Server-side resolution

`/api/youtube/video-info` now consults the shared store between the per-operator query-param override and the env-var legacy fallback:

```ts
const sharedYouTube = await getSharedCredential("youtube");
const apiKey =
  req.nextUrl.searchParams.get("apiKey")              // per-operator override (existing)
  || (sharedYouTube as { googleApiKey?: string })?.googleApiKey   // ← NEW: org-wide shared default
  || process.env.GOOGLE_API_KEY                       // legacy env-var (existing)
  || process.env.GEMINI_API_KEY;                      // legacy env-var (existing)
```

Error message updated to point operators at the right setting:

> "No Google API key configured. Ask an Admin to set the shared default in Connections → YouTube → Set as shared default, or add a personal override in Connections → YouTube → Override locally → Google API Key."

The shared-cred path also implicitly handles the C3 forward-only auto-ingest path (because that wraps the same helper), and any future YouTube Data API consumer.

## Implementation

- `web/src/lib/sharedCredentials.ts:27` — added `"youtube"` to `SHARED_PLATFORMS`
- `web/src/components/ConnectionsPanel.tsx:17` — added `"YouTube"` to `SHARED_PLATFORM_NAMES`; added `sharedEligibleFields?: string[]` to `PlatformInfo`; set `["googleApiKey"]` on the YouTube entry; field-iteration filters by `sharedEligibleFields` in shared mode; `handleSave` validates + whitelists the POST body to eligible fields
- `web/src/app/api/youtube/video-info/route.ts` — inserted `getSharedCredential("youtube")` into the resolution chain; updated the no-key error message
- Tests: existing 55 tests still pass. The shared-defaults machinery is end-to-end already covered by the integration of other platforms; this ADR doesn't add new test surface beyond the shape change.

## Consequences

**Positive**
- Admins can set `googleApiKey` once for the whole org via the existing shared-defaults UI — no redeploy, no env-var management, no per-operator setup friction.
- ADR-049/050 C1-A backfill, ADR-052 summary badge backfill, ADR-053 transcript provenance lookup (when fetching transcripts via YouTube auto-captions in future) all just work once the Admin configures the shared default.
- Generalises a useful pattern (`sharedEligibleFields`) that future platforms can use if they have similarly-mixed credential types — e.g. if Loom or some other platform ever has both per-user identity creds and a public data key.

**Negative / careful**
- One more concept (`sharedEligibleFields`) for an operator opening the codebase. Documented in the type def + in this ADR.
- The shared-default flow now renders the YouTube card with the "Set as shared default" affordance, which might confuse operators who associate YouTube with "always per-operator." Mitigated by the explanatory line in the editor: "Only the field below is org-wide shareable for YouTube. Other credentials remain per-operator."

## Alternatives considered

| Option | Why rejected |
|---|---|
| Operator-side workaround — every operator provisions their own API key | Issue #3 was filed because the operator couldn't create one due to an org Cloud Console restriction. Per-operator doesn't scale and isn't reachable for everyone. |
| Hardcode `GOOGLE_API_KEY` as a Cloud Run env var | Works but requires a deploy to rotate, leaves no audit trail of who set it, and breaks the consistent shared-defaults UX. ADR-042 already established the pattern this should follow. |
| Make YouTube fully shared (OAuth + API key) | Violates the brand-account-attribution intent that motivated YouTube's per-operator status in ADR-042. Uploads should carry the operator's identity; that requires their OAuth creds. |
| Introduce a separate "youtube-api-key" platform card | Adds UI surface for no semantic gain. Operators think of "YouTube" as one credential bundle; splitting the card visually would confuse more than clarify. The hybrid card with explanatory text is cleaner. |

## References

- ADR-042 — Server-side credentials with operator override (the pattern this extends)
- ADR-049/050 — YouTube backfill that depends on the Data API
- ADR-052 — Summary badge backfill (also uses the Data API)
- Issue #3 — concrete trigger ("There is no way to set GOOGLE_API_KEY as key admin")
- Existing shared-cred machinery: `web/src/lib/sharedCredentials.ts`, `web/src/app/api/credentials/shared/[platform]/route.ts`
