# ADR-065: Community-Contributor Role

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-08-02 |
| **Deciders** | Engineering, Community Operations |
| **Supersedes** | — |
| **Related** | ADR-002 (Actor + UserRole domain), ADR-014 (publish-attribute processing rules), ADR-035 (server-shared catalog), ADR-036 (Google Workspace Authentication and Role-Based Access), ADR-042 (shared credential vault), ADR-049 (broadcast-pair provenance), ADR-055/056 (title alignment) |

---

## Context

Today the operator surface is designed for a small trusted circle: three roles per ADR-036 — Viewer, Publisher (Operators group), Admin (KeyAdmins group). Anyone in one of those groups can see the entire catalog and, above Viewer, mutate it.

Two frictions have surfaced as the platform's audience widens:

- **Community members from Agentics chapters** routinely have recordings the org would like in the catalog — a chapter-run panel, a member's Zoom of a local meetup, a Loom walkthrough — but they aren't curators. Handing every contributor a Publisher token would give them approve/publish/rules/config powers they don't want and we shouldn't grant. Today we route these submissions through a curator who imports on the contributor's behalf; that's a bottleneck and it also erases the contributor as the author of the record.
- **Provenance visibility for contributors** matters. When a contributor asks "did my chapter's session make it into the catalog / is it linked to the YouTube upload yet?", the answer lives in the Provenance graph. Contributors have a legitimate read need there; they don't have any need for the Publish preview / Rules / Config / Maintain / bulk credential surfaces.

The system already reads Google Group membership on every request (ADR-036) and derives a role. Adding a fourth tier is a natural extension of that model.

---

## Decision

### 1. New role `Contributor`, backed by a new Workspace group

- Group: `video-sync-contributors@agentics.org`
- Enum extension: `UserRole::Contributor` — sits strictly between `Viewer` and `Publisher` on the capability lattice:

  ```
  Viewer  <  Contributor  <  Publisher  <  Admin
  ```

- Existing "highest group wins" rule (ADR-036 §2) is preserved. A user in both `Contributors` and `Operators` continues to authenticate as Publisher — Contributor is only ever the effective role when it IS the highest group the user is in.

The four Workspace groups are all additive; the derivation logic on `getActor()` just gets a new branch: `Contributors → UserRole::Contributor`. `KeyAdmins` still wins over `Operators` still wins over `Contributors` still wins over `Viewers`.

### 2. Capability matrix

| Capability | Viewer | Contributor | Publisher | Admin |
|---|---|---|---|---|
| Read own catalog rows (Overview page, filtered — see §4) | ✅ | ✅ | ✅ | ✅ |
| Read full catalog (Overview + Catalog page) | ✅ | — | ✅ | ✅ |
| Read Provenance page | ✅ | ✅ | ✅ | ✅ |
| Import via **Zoom URL / Loom URL / YouTube URL / Manual Google-Drive file** | — | ✅ | ✅ | ✅ |
| Import via Fireflies / Kaltura (per-org shared credentials) | — | — | ✅ | ✅ |
| Approve / InScope / Publish transitions | — | — | ✅ | ✅ |
| Push title / description to YouTube | — | — | ✅ | ✅ |
| Edit Rules / Processing Rules / Post-Processing Rules | — | — | — | ✅ |
| Edit Series Registry / Show Notes prompt / Description strategy | — | — | — | ✅ |
| Maintain page (Show Notes backfill, title alignment, dedupe, etc.) | — | — | ✅ | ✅ |
| Connections (credential vault) | — | — | — | ✅ |

Notes on the delta from ADR-036:
- Contributor gains `Import` — a capability Viewer doesn't have — and gains no visibility beyond the records they created. Publisher's superset of Contributor stays intact.
- Fireflies and Kaltura imports are gated to Publisher+ because they consume the org's shared credentials (ADR-042). Contributor's imports use only public-URL sources (Zoom recording URL, Loom URL, YouTube URL) plus a Drive folder they've shared into the Contributor Drive.

### 3. UI surface for Contributor

- **Landing route: `/contribute`.** New page, replaces `/overview` as the post-login default when the effective role is Contributor. Renders:
  - `<h1>Contribute a recording</h1>` + a compact import panel (Zoom URL, Loom URL, YouTube URL, "Manual Drive file" — see §5). The Fireflies and Kaltura importers are hidden.
  - Below the import form: a "Your contributions" table — the operator's own records (see §4), showing status ("Discovered → InScope → Approved → Published"), with row-click navigation to the record's Provenance-page-scoped view.
- **Overview / Catalog navigation is hidden** in the sidebar for Contributor. Provenance is shown. Config / Maintain / Publish / Backfill / Shorts are hidden.
- **Deep-links to non-permitted routes return 403** on the server side (not just a hidden nav link) — ADR-036's `getActor()` gate on every route is extended so `/catalog`, `/config`, `/maintain`, `/backfill`, `/shorts` all reject Contributor with a friendly "not authorised for this page" body pointing at `/contribute`.

### 4. Catalog visibility filter

`/api/catalog` learns a role-scoped view. When the caller resolves to Contributor:

- Records are filtered to `contributor_email === req.actor.email`. A new field on `VideoRecord` (see §6) carries the ingest-time contributor's email.
- Provenance queries stay ungated by contributor — a Contributor viewing their own record's provenance can see upstream / paired records fully, because the whole point of Provenance is showing the graph beyond the record they contributed. But the "which OTHER catalog rows exist" list stays filtered.

Publisher and Admin see the full catalog (existing behaviour).

### 5. Import affordances Contributor gets

| Source | Notes |
|---|---|
| **Zoom URL** | Existing importer (`ZoomImport.tsx`). Requires a public shareable link or an unlisted URL the contributor can access. |
| **Loom URL** | Existing importer (`LoomImport.tsx`). Loom's public API was discontinued in 2025 — imports are URL-only, metadata is best-effort. |
| **YouTube URL** | Existing importer (`YouTubeSourceImport.tsx`). Fetches title / channel / duration via the Data API (org's shared key). |
| **Manual Google-Drive file** *(new)* | New importer. Contributor supplies a Drive file link OR selects from a shared Drive folder the org has provisioned for chapter contributions (`video-sync-contributions@`). Implementation: fetch file metadata via Drive API, create a catalog row with `source_platform: "GoogleDriveFile"`, `source_id: "<drive-file-id>"`, `download_url: "gdrive://<file-id>"`. Publisher-side flow ingests via existing `driveArtifactStore` machinery. Implementation deferred; ADR reserves the shape. |

Each Contributor-authored record lands at `status = Discovered` — the normal ingest entry point — so a Publisher picks it up in the review queue exactly like any other new record.

### 6. Attribution: first-class fields on `VideoRecord`

New optional fields on the Rust `VideoRecord` (ADR-002):

```rust
pub struct VideoRecord {
    // …existing fields…
    pub contributor_email: Option<String>,   // free-text; matches Google Workspace email
    pub contributor_chapter: Option<String>, // free-text; e.g. "Agentics Toronto"
}
```

- Populated by the ingest path when the requesting actor's role is Contributor (or when a Publisher imports "on behalf of" — an optional dropdown surfaces on Publisher-triggered imports).
- Serialised into `to_json()` / accepted by `from_json()`.
- Included in `IndexVideoCmd` so the initial ingest event carries the attribution.
- Displayed on the VideoCard as a small chip (`👤 Toronto — jane@example.org`) alongside the source-platform badge, so curators know at a glance where a record originated.

The `metadata_extra` shortcut discussed elsewhere was rejected for this ADR — attribution is core provenance and belongs on the strongly-typed schema (ADR-002 §Value objects), not in the free-form bag.

Migration: existing records get `null` on both fields. No backfill required — historical records were curator-imported, so contributor attribution wasn't captured to begin with.

### 7. Server-side authorisation checks

Every mutating route already reads `getActor(req)` (ADR-036 §3). Route-level extension:

- `/api/catalog` POST (record push) — Contributor may only write records whose `contributor_email === actor.email`. Guards against a Contributor tampering with someone else's record by ID.
- `/api/catalog` GET — role-aware filtering as in §4.
- Publisher-only routes (`/api/rules`, `/api/summary/prompt`, `/api/description/config`, `/api/series-registry` PUT, `/api/backfill/*`, publish-to-YouTube endpoints, `/api/artifacts/*` PUT/DELETE) return 403 to Contributor.
- Read-only endpoints Contributor legitimately needs (`/api/artifacts/{id}/{kind}` GET for their own record's provenance-linked artifacts) stay open under the same filter as `/api/catalog`.

The IAP JWT is authoritative for identity; the group membership look-up (cached 5min per session) is authoritative for role. Contributor cannot elevate by forging headers — IAP terminates them at the load balancer.

### 8. Audit + event log

Every Contributor action lands in the app-level audit log (ADR-041) with `actor.email` intact, so an operator investigating "who submitted this?" has a paper trail. The event log entry format extends the existing `VideoIndexed:` line with a suffix when the ingesting actor is a Contributor: `VideoIndexed: "…" — by jane@example.org (Agentics Toronto)`.

---

## Consequences

**Positive**
- Community submissions bypass the curator bottleneck. A chapter organiser gets their session into the catalog directly; a curator's role becomes purely review-and-publish.
- Attribution is captured at ingest, not reconstructed from Slack pings or memory. `contributor_email` + `contributor_chapter` are legible to every future consumer (Show Notes footer, YouTube description credit block, Discord push, etc. — deferred but trivially available now that the fields exist).
- The role gate is a natural extension of ADR-036 — no new auth flow, no bespoke session handling. One line in the group→role mapping plus a fourth branch in the capability-check ladder.

**Negative / trade-offs**
- **New Rust field forces a WASM rebuild + a schema-version bump.** Any deploy carrying this change requires a coordinated client refresh so old browsers don't send old-shape `to_json` back to the server. Standard migration; called out because we've been careful not to churn WASM lately.
- **Filtered `/api/catalog` for Contributor is a new query path** — the endpoint currently returns the full store, and clients apply filters. Two options were considered; server-side filtering wins because a Contributor can't trust the client to enforce visibility. The extra branch is small (one predicate on the returned records map), but it does mean the response size varies by caller. Cache headers get scoped per actor.
- **Manual-Drive-file import is deferred.** The ADR spells out the shape but implementation lands as a follow-up. Contributors using only Zoom/Loom/YouTube URLs are unblocked immediately.
- **A Contributor who leaves a chapter still has records in the catalog attributed to them.** No automatic re-attribution or scrubbing. If a chapter admin wants to reassign, they file a Publisher-level edit; no UI for the Contributor to disown records.
- **Deep-linking to blocked routes now needs 403 handling.** Existing routes silently rendered under Viewer/Publisher/Admin; adding a fourth tier means every page's server component needs a role check. Bundled with this ADR; failure mode is "page returns 403" rather than "app looks broken".

**Downstream effects to watch**
- **ADR-014 processing rules** may want a `contributor_email` / `contributor_chapter` template variable in title / description transforms. Deferred but flagged; a Publisher can add `{{contributor_chapter}}` once we ship the variable substitution.
- **ADR-049 broadcast-pair migration** and **ADR-055/056 title alignment** both walk the catalog — they should skip records whose ingest is still `Discovered` from a Contributor until a Publisher has reviewed. Behaviour is already correct (Discovered filter isn't touched), but worth verifying on next Maintenance-page pass.
- **ADR-042 credential vault** is untouched. Contributor doesn't access shared credentials; the Fireflies / Kaltura / YouTube-upload creds stay Publisher-and-above only.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| Grant Contributor the Publisher role and rely on discipline / documentation to keep them from touching Config | Weak. The point of RBAC is that discipline isn't the primary safeguard. |
| Route contributions through a form that emails a curator, who then imports manually | The status quo. Doesn't scale; erases contributor attribution. |
| Model Contributor as an orthogonal capability (any role + Contributor group grants Import) | Rejected — the requirement is that Contributors have a distinctly narrower surface, not a wider one. Orthogonal grants would let a Viewer become an importer without picking up any other filtering, which is confusing to reason about. |
| Filter the catalog client-side rather than at `/api/catalog` | Client-side filtering is easily bypassed by anyone reading network traffic. Server-side is the only defensible boundary. |
| Attribution via `metadata_extra` instead of first-class fields | Rejected — attribution is core provenance and should be strongly-typed. `metadata_extra` is for platform-specific bags. |
| Auto-assign Contributor's records to the chapter's Publisher for review | Deferred. Requires a chapter → Publisher mapping we don't have yet. |

---

## Out of Scope

- **Manual Drive file import implementation.** Shape specified above; implementation is a follow-up ADR or slice.
- **Contributor-to-Publisher self-service escalation.** Managed in Google Workspace by the org admin; the app is a reader of group membership, not a writer (ADR-036 §Decision).
- **Cross-chapter visibility.** A Contributor sees only their own records. Chapter-level rollups ("Toronto's contributions this month") are a future dashboard, not blocking this ADR.
- **Contributor commenting / notes on their own records.** Publishers are still the source of truth for approve / reject; Contributor comment threads deferred.
- **Anonymous contributions.** IAP requires a Workspace email; every record has a real attribution.
- **Bulk contribution imports.** One-URL-at-a-time is the intended flow. If a chapter needs to mass-ingest, escalate to Publisher.
