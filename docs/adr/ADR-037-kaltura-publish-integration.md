# ADR-037: Kaltura Publish Integration

**Status**: Proposed
**Date**: 2026-04-22
**Deciders**: Architecture Team
**Scope**: ADR-002 (schema — multi-destination already supported), ADR-010 (Kaltura connection card already exists), ADR-012 (YouTube publish — pattern for this), ADR-024 (post-processing webhooks/email)

---

## Context

Kaltura has been a planned destination since ADR-010 — the **Connections** panel already has a Kaltura card collecting `partnerId` and `apiKey` (admin secret). But there is no publish path: the Publish button on every VideoCard hard-codes YouTube via `/api/youtube/upload`.

The operator has now asked for Kaltura publishing. This ADR scopes the work and commits to a phased implementation.

### Why Kaltura matters here

- Some videos belong on the institutional video portal (Kaltura), not on the public YouTube channel
- Videos can be published to **both** YouTube and Kaltura — `VideoRecord` already supports multiple `Destination` locations (ADR-002)
- Kaltura access control is fundamentally different from YouTube's (not a public/unlisted/private trichotomy; instead an entry-level + category-level ACL system) — the abstraction needs to handle both without one leaking into the other

### Differences from YouTube

| Aspect | YouTube | Kaltura |
|--------|---------|---------|
| Auth | OAuth 2.0 (per-user refresh token) | Session-based (KS minted from partner ID + admin secret per request) |
| Upload | Resumable, chunked, SSE-streamable | Single-shot HTTPS upload to a token-bound URL; multipart for very large files |
| Identity | Single video ID | Numeric entry ID + URL-safe entry ID |
| Privacy | `public` / `unlisted` / `private` | Entry-level access control + category memberships |
| Quota | 10,000 units/day default; uploads cost 1,600 each | Partner-level transcoding minutes; no daily quota by default |
| API style | REST + OAuth | Multimethod RPC, accepts JSON/XML/form |

---

## Decision

### 1. Destination selector on Publish (Phase 1: single-destination per click)

When the operator clicks **Publish…** on an Approved video card, the existing publish-preview panel opens. The Confirm row now shows two buttons instead of one — `YouTube` and `Kaltura` — and the operator picks **one** per Publish click.

```
[ YouTube ]  [ Kaltura ]  [ Cancel ]
```

Phase 1 ships single-destination publishing: the chosen destination runs through the full pipeline (preview → upload → mark_published), and the record transitions to `Published`. Going to a second destination requires a separate workflow (today: manual `Add Location` + `Recover from <platform>`).

**Why not multi-destination in Phase 1?** The `mark_published` WASM command requires status to be `Publishing` and only fires once per record. Adding a second destination after the record is already `Published` requires using `add_location` with role `Destination` instead of `mark_published` — a clean refactor but distinct enough to warrant its own phase. Phase 2 will:

- Decouple uploading from state transitions: `uploadToYouTube()` / `uploadToKaltura()` return upload results without mutating state.
- A `publish()` dispatcher calls each chosen destination in sequence: first success → `mark_published`; subsequent successes → `add_location`. All-failures → `mark_failed`.
- UI changes back to checkboxes (publish to *both*), with a per-destination success/failure indicator.

For Phase 1 the simpler single-destination model preserves all existing publish behaviour and avoids touching the YouTube path.

### 2. Kaltura upload pipeline

New API route `POST /api/kaltura/upload`:

```
1. Mint Kaltura Session (KS):
   POST https://www.kaltura.com/api_v3/?service=session&action=start
   form: partnerId, secret (admin), userId="video-sync", type=2 (admin), expiry=86400

2. Stream-download the source media (Zoom/Loom/etc.) into a temp file

3. Create upload token:
   POST .../?service=uploadToken&action=add
   form: ks=<KS>

4. Upload the file:
   POST .../?service=uploadToken&action=upload
   multipart: ks=<KS>, uploadTokenId=<id>, fileData=<binary>

5. Create a media entry:
   POST .../?service=media&action=add
   form: ks=<KS>, mediaEntry={
     name: <title>,
     description: <description>,
     mediaType: 1 (VIDEO),
     tags: <tags joined>,
     categoriesIds: <profile.kaltura_category_ids> (optional)
   }

6. Attach upload to the entry:
   POST .../?service=media&action=addContent
   form: ks=<KS>, entryId=<id>, resource={ token: <uploadTokenId> }

7. Return { entryId, playerUrl, status }
```

Player URL pattern (configurable per partner):
```
https://cdnapisec.kaltura.com/p/{partnerId}/sp/{partnerId}00/embedIframeJs/uiconf_id/{uiConfId}/partner_id/{partnerId}?iframeembed=true&entry_id={entryId}
```

The route accepts the same shape as `/api/youtube/upload` plus Kaltura-specific fields:

```ts
interface KalturaUploadRequest {
  partnerId: string;
  adminSecret: string;
  title: string;
  description: string;
  tags: string[];
  downloadUrl: string;
  // Source-specific creds (same as YouTube path)
  zoomAccountId?: string;
  zoomClientId?: string;
  zoomClientSecret?: string;
  firefliesApiKey?: string;
  // Kaltura-specific
  categoryIds?: number[];
}
```

Single-request response (no SSE in v1):
```ts
interface KalturaUploadResponse {
  entryId: string;
  playerUrl: string;
  uploadStatus: "ready" | "processing" | "error";
  error?: string;
}
```

### 3. Domain model — using existing aggregate

No Rust changes needed. `mark_published` already accepts `destination_platform`:

```ts
videoStore.mutate(videoId, r =>
  r.mark_published(JSON.stringify({
    destination_id: kalturaEntryId,
    destination_url: playerUrl,
    destination_platform: "Kaltura",
  })),
);
```

`mark_published` adds a Destination location idempotently (per ADR-016 Recover discussion), so calling it twice — once for YouTube, once for Kaltura — produces two Destination locations on the same record without conflict. The aggregate's `destination_id` and `destination_url` fields capture the **first** destination to mark the video Published; subsequent destinations live in `locations[]`.

### 4. Kaltura status check + Recover

Mirror the YouTube pattern from ADR-012/ADR-016:

- `GET /api/kaltura/status?entryId=...` → `{ status, accessControl, viewCount }`. Maps Kaltura's `status` field to friendly names (`READY` / `PROCESSING` / `ERROR`).
- "Check Status" button on Kaltura Destination locations.
- Recover from Kaltura: paste an entry ID → verify exists → mark Published. Auto-lookup against the partner's media list (similar to `channel-uploads`) is **future work** — Kaltura's media.list returns thousands of entries with no per-channel scoping, so the matcher needs careful design.

### 5. What does NOT happen in v1

- **No SSE progress streaming** for Kaltura upload. The route awaits the upload and returns once complete. For large files this can take minutes; the client shows an indeterminate spinner. Adding SSE is straightforward (mirror the YouTube path) but adds code; deferred until needed.
- **No category management UI**. If `kaltura_category_ids` is desired, it's set per BackfillProfile or per video as a free-text field. A category browser is future work.
- **No Kaltura privacy badge in Overview**. The Overview's privacy badge is YouTube-specific; Kaltura access control is multi-dimensional and doesn't map to public/unlisted/private. Display-as-text only for now.
- **No Kaltura auto-lookup** for Recover. Manual entry ID paste only.

---

## Phased implementation

| Phase | Scope | Notes |
|-------|-------|-------|
| **1 (this ADR ships with)** | `/api/kaltura/upload` (no SSE), destination selector on Publish, `/api/kaltura/status`, manual-paste Recover for Kaltura | Enables both-destinations workflow |
| **2** | SSE progress on upload, post-processing rule support for Kaltura URL templating, audit-log alignment | When upload latency becomes a UX issue |
| **3** | Category management, Kaltura auto-lookup for Recover, `kaltura-uploads-cache` (analogous to `youtube-uploads-cache`) | When the Kaltura backlog is large enough to need it |

---

## Consequences

### Positive

- Single-click multi-destination publish without a workflow change
- The `VideoRecord.locations[]` model already handles multiple destinations — minimal surprise to the schema
- Kaltura access remains fully scoped to the operator's partner credentials; no shared multi-tenant concerns

### Negative

- Two distinct upload paths to maintain (YouTube SSE + Kaltura blocking)
- Privacy abstraction in Overview no longer fits all destinations — the YouTube-coloured badge is misleading if a record is also on Kaltura. UI needs to clarify "this is YouTube privacy" rather than "destination privacy."
- Kaltura's "media.list" API does not scope by uploader, making future auto-lookup harder than YouTube's `channels.list`/`playlistItems.list` flow.

### Risks

- **Partner-secret exposure**: the admin secret is sent in every API call. The current ADR-011 pattern passes it in the request body to a same-origin route — same risk profile as YouTube credentials. Migration to ADR-036's Secret Manager vault closes this for both.
- **Upload size**: single-request multipart for files >2 GB hits Cloud Run's 32 MB request limit. Mitigation: switch to Kaltura's chunked upload (`uploadToken.uploadAction=2`) when adding SSE in Phase 2; flag large videos in the UI.
- **Failed-on-Kaltura, succeeded-on-YouTube**: the record still transitions to `Published` (because YouTube succeeded). The Kaltura failure must be visible — either as a Failed Destination location with an error string, or as an Event Log entry the operator can act on with **Recover from Kaltura**.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **Always publish to both destinations** | Some videos belong on YouTube only (public) and others on Kaltura only (institutional). Hard to encode in profiles cleanly. Operator should choose. |
| **Treat YouTube and Kaltura as the same destination type** | Their access-control models are too different to abstract over without losing useful detail. |
| **Skip Kaltura, use only YouTube** | Operator has institutional content that doesn't belong on the public channel. |
| **Use Kaltura's official Node.js SDK** | Heavy dependency, adds ~500 KB to the deploy, and the API surface we need is small enough to call directly. |

---

## Related ADRs

- **ADR-002**: Unified Video Metadata Schema — `locations[]` already supports multiple destinations
- **ADR-010**: Authentication Configuration — Kaltura connection card already exists in ConnectionsPanel
- **ADR-011**: MVP Credential Proxy — Kaltura admin secret currently flows through request bodies; ADR-036 vault eventually replaces this
- **ADR-012**: YouTube Publish Integration — pattern this ADR follows
- **ADR-016**: Retrospective Backfill Uploader — Recover flow generalises to any destination
- **ADR-024**: Post-processing Webhook and Email — fires on either destination's success/failure
- **ADR-036**: Google Workspace Authentication — Phase 2 of that ADR moves Kaltura admin secret to Secret Manager
