# ADR-076: Consumer Contract — External Sites Reading the Show Notes Catalog

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-08-19 |
| **Deciders** | Engineering, Community Operations, Chapter Website Team (agentics.org) |
| **Supersedes** | — |
| **Related** | ADR-036 (Google Workspace Auth + RBAC), ADR-042 (shared credential vault), ADR-065 (community contributor role — the producer side), ADR-066 (MCP show-notes server), ADR-074 (canonical artifact bag + MCP exposure), ADR-075 (series-driven destinations) |

---

## Context

ADR-065 built the **producer** side of the community pipeline: contributors submit recordings via `/contribute`, get identified through the `video-sync-contributors@agentics.org` Google Group, and appear in the org catalog with clean attribution + provenance.

This ADR pairs it with the **consumer** side: the **agentics.org** website — public-facing, chapter-organised — that DISPLAYS the catalog: show notes, descriptions, chapter jumps, provenance. It reads the catalog without any operator-level rights. Concretely, agentics.org wants to render:

- The last N Toronto-chapter sessions as cards
- Each card's full Show Notes, opening hook, and chapter cues (deep-linked to YouTube)
- The aggregated single-file reference doc (title + dates + show notes + description + transcript + chat + provenance) when the reader clicks in

Today nothing stops such a site from scraping a public YouTube channel, but it would lose:

- Chapter cues sourced from actual segmented Show Notes (not YouTube's flat description)
- The producer-canonical description (the full-length variant per ADR-074's `description-full` artifact)
- Cross-source provenance (this Zoom is the same session as that YouTube upload is the same session as that Fireflies transcript)
- Series metadata (which chapter, which recurring session)
- Contributor attribution (who submitted the recording per ADR-065)

The MCP server built in ADR-066 and extended in ADR-074 already exposes all of this — the missing piece is a **stable, versioned contract** that a downstream site can build against without reading video-sync's source tree. This ADR defines that contract.

---

## Decision

### 1. The consumer contract is the MCP surface — nothing bespoke

Consumers use the same MCP endpoint operators do: `POST /api/mcp` on the public MCP service (currently at `https://video-sync-mcp-667037737667.us-central1.run.app`, custom domain planned). No shadow REST API, no site-specific JSON adapter. What this ADR commits to is:

- The tool set advertised in `tools/list` and the resource URIs advertised in `resources/list` are stable — additive changes are non-breaking; existing tool names, arguments, and return-shape fields will not be renamed or removed within a semver-minor release.
- Un-authenticated OAuth discovery (RFC 9728 protected-resource metadata + RFC 8414 authorization-server metadata) is the identity contract. Consumers register once via RFC 7591 dynamic client registration and thereafter carry a `Bearer vsync_*` header on every JSON-RPC call.
- The public MCP service does not require Google Workspace identity for read — a bearer token minted by any legitimate registration is accepted. Role (see §3) governs which records that token can see.

Un-authenticated surface verified against `https://video-sync-mcp-667037737667.us-central1.run.app` on 2026-08-19:

```
GET  /.well-known/oauth-protected-resource     → 200, RFC 9728 shape (scopes ["mcp"])
GET  /.well-known/oauth-authorization-server   → 200, RFC 8414 shape (S256 PKCE, dcr)
POST /api/mcp/oauth/register                   → 201, RFC 7591 shape, mints client_id
POST /api/mcp   (no bearer)                    → 401 + WWW-Authenticate: Bearer resource_metadata="…"
```

### 2. Consumer tool subset

A chapter website consumer typically uses six of the eleven MCP tools:

| Tool | What the consumer uses it for |
|------|-------------------------------|
| `list_series` | Enumerate series (e.g. "Volunteer Training", "Agentics Toronto") to build a site nav |
| `search_records` | Fetch records by title / date range / series — the "load recent Toronto sessions" query |
| `get_show_notes` | Render the full chapter-oriented Show Notes markdown on a session page |
| `get_description` | Show the YouTube-facing description (opening hook + cues + highlights, ≤ 4800 chars) as a card teaser |
| `get_description_full` | Render the un-capped LLM-shape description on the session detail page — same shape as `get_description`, longer |
| `get_reference` | Fetch the aggregated single-file reference doc for one-shot pages (all-in-one series digest, printable programme) |
| `list_artifacts` | Optional — enumerate everything Drive has (chat, YouTube snippet, transcript) if the consumer wants to selectively pull them |

Everything else in the tool list (`get_transcript`, `get_youtube_snippet`, `search_chapter_moments`, `get_chat`) remains available but is not required for the chapter-website use case. Consumers should degrade gracefully when a tool returns "not yet materialised" (see §5).

### 3. Access-control contract

The MCP identity model is bearer-token-per-user. A consumer chapter website ISN'T a user; it's a machine. Two options:

- **Machine token per site** (recommended for MVP). The chapter website is issued a dedicated `vsync_*` bearer by an operator (via `/config → MCP tokens`), with a role that matches "public catalog viewer" semantics. That token lives in the site's server-side secret store; the front-end never sees it. All calls made from the site's server carry it. Compromised token is revoked from `/config → MCP tokens`.
- **Group-mapped identity** (deferred). If agentics.org grows a per-user identity flow, per-viewer OAuth via `/api/mcp/oauth/authorize` is available and route through the same role model as any human operator.

For the MVP consumer, video-sync commits to the following visibility rules — same as the human-operator model from ADR-036:

- Records whose visibility state includes YouTube = `public` OR Kaltura = `public` are visible to any Viewer-role token.
- Records at status `Published` are visible to any Viewer-role token regardless of their destination visibility (they're on the org channel).
- Records at status `Discovered / InScope / Approved / Publishing / Failed / ToRetry / Skipped / Abandoned` are visible only to Publisher/Admin tokens.
- Contributor tokens see only records with matching `contributor_email`; chapter-website tokens are NOT Contributor tokens.

Chapter-website tokens SHOULD be minted at Viewer role.

**Implementation note (2026-08-23).** The Viewer gate is enforced in one place —
`loadVisibleRecords` in `web/src/lib/mcpServer.ts` — which every tool routes
through, so no per-tool path can widen it. Two deviations from the bullets above,
both narrowing:

- The `youtube-visibility = public` / `kaltura-visibility = public` bullet is NOT
  evaluated. Per-destination privacy isn't persisted on the record; it's fetched
  live from the YouTube API and cached client-side (`youtubePrivacyCache`), so
  it isn't available to a server-side MCP call. `status = Published` is the only
  server-authoritative signal, and it covers the public case in practice: a
  record reaches Published either through a successful upload or through the
  ADR-051 ingest path, which auto-advances an already-on-YouTube video straight
  to Published.
- This is stricter than the operator UI, where `GET /api/catalog` returns the
  full store to a Viewer. That's a deliberate split, not drift: an IAP-gated
  human Viewer is inside the org, whereas a Viewer-role bearer token is the
  consumer contract's public surface. ADR-036's "Viewers can see the catalog"
  continues to describe the UI path only.

### 4. Response-shape guarantees

For each tool below, the consumer contract commits to the following field set (additive: additional fields may appear; listed fields will not disappear within a semver-minor release):

**`list_series` result**
```
{ series: [
    { series_name: string,
      pattern: string,          // regex source; safe to display, don't run
      discord_channel?: string, // may be absent
      scheduled_start_local?: string, scheduled_end_local?: string, scheduled_timezone?: string,
      destinations?: DestinationSpec[]   // ADR-075
    }
] }
```

**`search_records` result** — the array is `hits`. The original ADR-066
implementation named it `results`; the server now emits BOTH, `results` being a
deprecated alias for callers written against the pre-ADR-076 shape. Consumers
SHOULD read `hits`; `results` will be dropped once no client reads it.
```
{ query: string, count: number,
  hits: [
    { id: string,               // record uuid
      title: string,
      recorded_at: string | null,
      source_platform: "Zoom" | "Loom" | "Fireflies" | "YouTube" | "Kaltura" | "OpusClip" | "GoogleDrive",
      source_id: string,
      has_show_notes: boolean,
      deep_link: string         // absolute URL back to the operator UI's catalog page
    }
] }
```

**`get_show_notes` result** — text/markdown. Full doc. Always the full doc — no pagination.

**`get_description` result** — text/plain. Prefers the last-pushed YouTube snippet's description, then description.md, then the record's inline description field. Consumers should treat this as "what YouTube viewers see".

**`get_description_full` result** — text/markdown. Present only when the operator has generated it via Rewrite from Show Notes. If absent, the tool returns an informational error suggesting the operator re-run generation. Consumers SHOULD fall back to `get_description`.

**`get_reference` result** — text/markdown. Composed at generation time from title + dates + Show Notes + description + transcript + chat + provenance. Lazily materialised on first request.

**`list_artifacts` result** — JSON. The `.meta.json` index (per-kind: drive_file_id, size, modified). See ADR-074 §1 for the artifact-kind vocabulary.

### 5. Not-materialised handling

Several artifacts are lazy: they're written the first time an operator triggers the relevant action. Consumers WILL encounter records where a specific artifact isn't there yet. The contract for each such case:

- **`get_description_full` before Rewrite-from-Show-Notes**: returns `{"isError": true, "content": [{"text": "description-full.md not yet generated…"}]}`. Fallback: use `get_description`.
- **`get_reference` before first read**: server generates it lazily and returns the content on the same call. First call is slow (~1–3s); subsequent calls hit the cached artifact.
- **`get_chat` on a source without chat** (YouTube import, Zoom-share, Loom-share, Drive): returns an explanatory placeholder ("_No chat artifact for this record…_"). Consumers should hide the chat section rather than surface the placeholder.
- **`get_show_notes` on a record without a `summary_doc_id`**: throws `ERR_INVALID_PARAMS`. Consumers filter these upstream by `has_show_notes` from `search_records`.

### 6. Rate + caching guidance

MCP has no hard-coded rate limit today. Consumers should be considerate:

- Cache `list_series` and `search_records` results client-side for 5–15 minutes; series metadata rarely changes.
- Cache per-record artifact bodies (`get_show_notes`, `get_description`, `get_description_full`, `get_reference`) for at least an hour. Video-sync's catalog is push-driven; a record's Show Notes rarely re-generate within a session.
- Consumers WITH webhook receivers may subscribe to `notifications/list_changed` (MCP standard) when we ship it — currently not emitted. Until then, poll `list_series` on the site's cache-warm schedule and re-fetch records whose `search_records.recorded_at` moved.

### 7. Contract test harness

A consumer must be able to verify the contract against any deployment. We ship a smoke-test script at `scripts/mcp-consumer-contract-test.sh` that walks:

1. Un-auth discovery endpoints return the RFC-shaped JSON.
2. Un-auth `/api/mcp` returns 401 + valid `WWW-Authenticate: Bearer resource_metadata="…"`.
3. Dynamic client registration succeeds and returns an RFC 7591 shape.
4. With a caller-provided `$TOKEN`, every tool in §2's subset returns a well-formed result (`resources/list` advertises the six kinds, each `get_*` tool call succeeds against the first available record).

The script is idempotent and non-destructive — no MCP writes, only reads.

### 8. Privacy + attribution decisions (resolved 2026-08-19)

Three questions raised in the first draft, now committed:

**8.a. `contributor_email` is stripped from Viewer-scoped MCP returns.** Records fetched by a Viewer-role token — which chapter-website tokens SHALL be — do not carry `contributor_email` in any tool return. Publisher and Admin roles retain the field for curator triage. Contributor role continues to see their own record's email (unchanged; it's their own address). Redaction happens in `loadVisibleRecords` before hand-off to any tool implementation, so no per-tool leak is possible.

**8.b. Audit log attributes machine tokens by the token's `name`, not by the operator who minted it.** MCP tokens carry a `name` field the operator supplies at mint time (e.g. "agentics.org public site — production"). The MCP request logger records the token name as the audit actor when the caller is authenticated via a bearer token. The token's frozen `actor_email` (from the operator who minted it) is retained internally for revoke / rotation flows but does NOT appear in per-request audit lines. Keeps the log meaningful: "agentics.org public site made 40 000 calls today" is legible; "martin.cleaver@ made 40 000 calls" would be misleading.

**8.c. `X-Consumer` header is accepted and logged.** Consumers may send `X-Consumer: <free-text label>` on any MCP request (e.g. `X-Consumer: agentics.org/chapter/toronto`). The value is logged alongside the request line. No authorisation weight — purely observability so we can attribute usage patterns to specific site paths / build ids / cache-warming jobs. Absent header → logged as empty.

---

## Consequences

### Positive

- A chapter website team can build against a documented, stable contract without reading video-sync's TypeScript.
- Additive tool changes on the producer side don't break existing consumers, only new tools they can opt into.
- The identity model already exists (bearer tokens) — no new auth surface.
- The consumer contract makes the value proposition of the producer side concrete: "chapter sites get real chapter cues, provenance, and full-length descriptions in exchange for contributors submitting through /contribute."

### Negative

- Per-user role-scoped visibility (§3) means a public chapter site with a Viewer token sees only Published + Public records. Unpublished / Approved / Failed records are invisible even if the chapter organiser knows they exist. That's the right default for a public site but may frustrate an admin-facing internal dashboard; those callers need an Admin token.
- The "not yet materialised" guarantees are advisory — a consumer that ignores them will see errors on non-populated artifacts. The graceful-degradation burden is on the consumer.
- No versioning header is committed — the contract is "current MCP". Breaking changes require an ADR bump; consumers who freeze on a version may need to re-verify against the smoke test after a video-sync deploy.

### Neutral

- The public MCP service already serves this exact contract; no code changes required on the producer side to accept a chapter-website consumer today.
- Rate limits are advisory — video-sync's Cloud Run auto-scaling absorbs modest traffic; a runaway consumer would surface as a Cloud Run cost signal before hitting a hard limit.
- The `deep_link` field on `search_records` results points at the operator UI (main IAP service). Public-site viewers who click that will be redirected to a login they don't have. Consumers should render the YouTube URL from `get_provenance` for viewer-facing links instead.

---

## Deferred / Follow-ups

1. **Custom domain for MCP** (`https://mcp.video-sync.agentics.org`). Reduces the `-667037737667.us-central1.run.app` in the resource metadata and lets us swap Cloud Run projects without breaking consumers.
2. **`notifications/list_changed` events** so consumers can invalidate caches instead of polling.
3. **Rate-limit signals** — currently absent. When we ship them, they'll be RFC 6585 `429 Too Many Requests` with `Retry-After`.
4. **Consumer SDKs** — a thin `@agentics/video-sync-consumer` npm package with typed wrappers around the six-tool subset. Not on the video-sync roadmap; the chapter-website team can adopt it if they want.
5. **Contract-version header** — when we do a breaking change, land a `MCP-Contract-Version` header in every response. Not needed today because we haven't broken anything.
6. **Public read of Show Notes markdown without a token** for records at Published + `youtube-visibility=public`. Trades identity for the marginal cost of anonymous scraping; not clear the trade is worth it. Deferred until a chapter site actually asks.

---

## Open questions

_No unresolved contract questions. The three items in the first draft (contributor_email redaction, machine-token audit identity, consumer attribution header) are now committed as §Decision.8._
