# ADR-066: MCP Server Exposing Show Notes

| Field | Value |
|-------|-------|
| **Status** | Accepted (initial slice implemented; see §Out of Scope for deferred items) |
| **Date** | 2026-08-02 |
| **Deciders** | Engineering, Community Operations |
| **Supersedes** | — |
| **Related** | ADR-036 (Google Workspace Authentication + IAP), ADR-039 (Drive as artifact store), ADR-042 (shared credential vault), ADR-046 (prompt-driven Show Notes), ADR-053 (transcript provenance), ADR-055/056 (title alignment), ADR-064 (description strategy) |

---

## Context

The catalog now carries curated Show Notes docs for every record with a usable transcript — chapter-oriented markdown, versioned by prompt version, editable in Drive. It's the highest-signal representation of what a session covered: `[HH:MM:SS]` bullets under `### Key Moments / Key Learnings / Key Takeaways / Chat-Sparked Discussions`.

Right now, the only way to CONSUME Show Notes is:

- Click through the web UI to a record and open its Drive doc.
- Read the raw markdown via `/api/summary/read?docId=<id>` behind IAP.
- Manually copy snippets into Claude / an editor / a Discord thread.

Community members and internal LLM-assisted flows keep asking questions the Show Notes already answer — "did anyone discuss OpenTelemetry last month?", "what did the Toronto chapter conclude about self-hosting?", "give me the chapter breakdown of Friday's Hackerspace" — but the friction of finding the right record + opening the right doc + pasting into an LLM prompt is enough that they mostly don't bother. The signal is on Drive; the consumption pathway is manual.

**MCP (Model Context Protocol)** is Anthropic's open standard for letting LLM applications (Claude Desktop, Claude Code, IDE extensions, custom apps) talk to external data sources and tools through a JSON-RPC-over-transport contract. An MCP *server* advertises three kinds of capabilities:

- **Resources** — read-only content the client can list + fetch (like files or database rows). Perfect for Show Notes docs.
- **Tools** — callable functions with arguments (like `search_records(query, from, to)`). Perfect for filtered lookups.
- **Prompts** — reusable prompt templates the client can present to the user. Less relevant here.

An MCP client (e.g. Claude Desktop with the server configured) discovers what's on offer, and Claude decides at inference time when to call a tool or fetch a resource. The user doesn't have to know MCP exists; they just ask a question and Claude has a new tool at its disposal.

Exposing Show Notes via MCP turns "search + click + copy + paste" into "ask Claude" — the same content, accessible where the person doing the LLM-assisted thinking already lives.

---

## Decision

### 1. New MCP server: `video-sync-mcp`

Shipped as HTTP endpoints on the existing Next.js Cloud Run service, mounted at `/api/mcp/*`. Uses the **Streamable HTTP** MCP transport (the current standard as of MCP spec 2025-11). Supported by Claude Desktop, Claude Code, and Cursor/Windsurf natively; older stdio-only clients get a tiny local proxy binary (see §5) that speaks stdio and forwards to our HTTP endpoint.

Reusing the same Cloud Run service gets us three things:
- Reuses IAP + Google Workspace group auth (ADR-036) — an MCP call is just an authenticated HTTP request; no new auth surface to secure.
- Direct access to `catalog.json` + Drive credentials + the same TS libs the UI uses.
- One deploy pipeline, one code base, one Cloud Run revision.

### 2. Resources exposed

Each catalog record with `summary_doc_id` becomes an MCP Resource:

```
URI:  vsync://records/<record_id>/show-notes
Name: <title> — Show Notes
MIME: text/markdown
Description: <recording date> · <duration> · <participants>
```

`resources/list` returns the record's role-filtered set (Publisher / Admin see everything; Contributor sees their own; Viewer read-only). `resources/read` fetches the Show Notes via the existing `/api/summary/read` path — same Drive export, same banner strip. Content is served **as markdown**, not post-processed for YouTube (that's what ADR-064's `showNotesToDescription` is for).

Additionally, the record's *description* is exposed as a companion resource:

```
URI:  vsync://records/<record_id>/description
MIME: text/plain
```

So an MCP client can ask for either the deep chapter breakdown or the paragraph blurb without picking through markdown itself.

### 3. Tools exposed

Six tools, all filtered by the caller's role:

| Tool | Args | Purpose |
|------|------|---------|
| `list_series` | none | Enumerate the series-registry entries (name + Discord channel + schedule fields). |
| `search_records` | `query: string`, `from?: date`, `to?: date`, `series?: string`, `limit?: number` | Full-text over title + description + participants + tags. Returns record ids + titles + dates + Show Notes availability. |
| `get_show_notes` | `record_id: string` | Return the Show Notes markdown for a specific record. Same content as the Resource path — provided as a Tool too for clients that don't consume Resources. |
| `get_transcript` | `record_id: string`, `trim?: boolean` | Return the raw or scheduled-window-trimmed transcript. Contributor-scoped. |
| `get_provenance` | `record_id: string` | Return the record's upstream_links + locations + broadcast pair graph — the same shape Provenance page renders. |
| `search_chapter_moments` | `query: string`, `from?: date`, `to?: date`, `limit?: number` | Cross-record search over Show Notes' bullet-level `[HH:MM:SS] Text` lines. Returns `{record_id, timestamp, text, chapter_title}` tuples so a client can produce time-linked deep-links. |

Every tool response includes a `deep_link` field where meaningful (`https://video-sync.agentics.org/catalog?just=<id>` for records; `https://youtube.com/watch?v=<id>&t=<sec>` for chapter cues) so a Claude reply can cite sources the user can click.

### 4. Authentication

Currently one path — **Bearer tokens via `mcp-remote`**. Two additional paths were planned but only one is live today:

- **✅ Bearer API tokens** (shipped). Admins mint per-actor tokens at **Config → 🔌 MCP tokens**. Tokens carry the frozen `actor_email` + `role` + `user_id` from mint time. Sent as `Authorization: Bearer vsync_…`. Storage: hash on `data/mcp-tokens.json`, plaintext shown once at mint. `getActor()` resolves the header before falling back to IAP JWT, so the same MCP endpoint accepts either.
- **⏳ Interactive OAuth via Claude Desktop's Custom Connector UI** (deferred). Claude Desktop's Custom Connector treats the MCP URL as an OAuth 2.1 protected resource — it probes `/.well-known/oauth-protected-resource`, initiates Authorization Code + PKCE against `/authorize` and `/token`, and expects the MCP-spec OAuth surface. We don't implement that yet; the UI 404s on `/authorize`. Follow-up work: `.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/authorize` (with an IAP-fronted consent page), `/token` (issues a `vsync_…` via authorization-code exchange), and optional dynamic client registration.
- **⏳ Pass-through IAP** (deferred). Getting Claude Desktop or `mcp-remote` to reuse a browser's Google session cookie is fragile and platform-specific; not pursued.

Every mode ultimately produces an `Actor` via `getActor()`; the `Actor.role` scopes what the MCP session sees. A Viewer's session can read Show Notes but can't invoke write tools (none are Viewer-safe anyway); a Contributor's session sees only their own contributions.

### 5. Local stdio proxy — use the community `mcp-remote`

Claude Desktop's `claude_desktop_config.json` schema, as of the current release, only understands **stdio** servers (`command` + `args`). Direct HTTP transport is done via the desktop app's Custom Connectors UI (Settings → Connectors → Add). Advanced users who want everything in `config.json` route through the community-maintained [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) proxy:

```json
{
  "mcpServers": {
    "video-sync": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://video-sync.agentics.org/api/mcp"]
    }
  }
}
```

`mcp-remote` speaks stdio JSON-RPC to Claude Desktop and forwards to our HTTPS endpoint, handling the OAuth flow when the endpoint responds with an OAuth challenge. IAP-protected endpoints work when the user is already authenticated in a system browser (the OAuth popup reuses the existing Google session).

We ship no proxy of our own — `mcp-remote` covers this in a maintained, community-standard way; a bespoke `@agentics/video-sync-mcp-proxy` package was originally planned but rejected as redundant. The sidebar's **🔌 Connect via MCP** disclosure surfaces both the Custom Connector URL and the `mcp-remote` config.json snippet.

### 6. Rate limits + observability

- Per-actor rate limit: 60 requests per minute (rolling), 1000 per hour. Applied in the same withRequestLogging middleware as the rest of the API. Exceed → 429 + a `Retry-After` header.
- Every MCP call logs with `channel: "mcp"`, the tool/resource name, the actor's email, and duration. Same audit pipeline as ADR-041.
- `resources/list` results are cached per-actor for 60 seconds (the resource IDs change slowly; the underlying content is fetched on read anyway).

### 7. Configuration UX

Admin adds a new panel to `/config`: **🔌 MCP tokens**. Lists issued API keys (last 4 chars + expiry + role + last-used-at); button to mint a new one; button to revoke. Backing store: `data/mcp-tokens.json` on the FUSE-mounted bucket, plus each key's secret in Secret Manager.

Everyone (Admin/Publisher/Contributor/Viewer): a new **Connect via MCP** section on the sidebar footer with copy-pasteable snippets for common clients:

```
# Claude Desktop config.json
{
  "mcpServers": {
    "video-sync": {
      "url": "https://video-sync.agentics.org/api/mcp",
      "transport": "streamable-http"
    }
  }
}
```

Plus a "test connection" button that hits `/api/mcp/health` and reports success + the actor's effective role.

---

## Consequences

**Positive**
- Show Notes become first-class LLM context. A Claude Desktop user can ask "what did we conclude about GraphQL federation in the last quarter" and Claude will call `search_chapter_moments` + `get_show_notes` without the user leaving the chat.
- Reuses existing auth: IAP + Workspace groups already know who's allowed to see what. No parallel identity to manage.
- One deploy target. The MCP endpoints live in the same Next.js app + same Cloud Run revision; no separate service to keep in sync.
- The role model (ADR-036 + ADR-065) becomes visible outside the web UI. A Contributor asking Claude for chapter breakdowns can only pull their own — the LLM inherits the scoping.

**Negative / trade-offs**
- **MCP is a moving standard.** Streamable HTTP is current as of the 2025-11 spec but the wire format has churned twice in a year. We commit to tracking the spec; expect the transport layer to need updates every ~6 months.
- **Cloud Run cold starts affect first calls.** MCP clients typically expect low-latency `resources/list` on connect; a cold Cloud Run start can push that to 5–8 seconds. Mitigation: keep min-instances = 1 on Cloud Run once the MCP endpoints see regular traffic (already true for the UI). Cost delta is negligible.
- **OAuth-via-IAP for MCP clients is nascent.** Claude Desktop's IAP support works but isn't the primary integration path most Anthropic docs cover. Expect operator support requests around "how do I connect?"; the **Connect via MCP** panel in Config is deliberately verbose to compensate.
- **API-key auth is a new secrets surface.** Every issued key is a bearer credential. Rotation, revocation, and leak response all need runbooks (deferred; called out in §Out of Scope).
- **Rate limits will hit Claude's tool-use burst pattern.** Claude routinely fires 3–8 tool calls in parallel while reasoning. 60/min is generous for a single user but tight for a shared token; tune as usage patterns emerge.
- **Show Notes stability matters more now.** MCP clients cache resource contents by URI; if a regen produces very different content under the same `record_id`, Claude sessions can carry stale beliefs. Mitigation: include the `summary_prompt_version` in every resource description so Claude can spot version drift itself.

**Downstream effects to watch**
- **ADR-042 credential vault** grows a new entry per MCP token. The mint flow uses the same Secret Manager path pattern.
- **ADR-041 audit log** picks up `component: "mcp"` entries; auditor queries need to include this channel when investigating access.
- **ADR-046 Show Notes** are now a distributed artifact — regenerations affect what an already-connected MCP client sees on next fetch. Consider adding a `resources/list_changed` notification (part of the MCP spec) when a bulk regen completes, so clients can invalidate.
- **ADR-064 description strategy** stays UI-only — MCP exposes both raw Show Notes AND descriptions as separate resources, so the description path is one option not the only one.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| Stand up a separate Node.js MCP server binary + own repo | Doubles the deploy surface, forks the auth pathway, and needs its own credential sync. Reusing the Next.js app avoids all three. |
| Expose Show Notes via a REST API and let clients build their own MCP wrapper | Everyone would reimplement the same shim. MCP is standardised precisely so we don't. |
| Wait for Anthropic to publish a "video catalog" MCP standard | There isn't one. Ship the domain semantics we have; standards emerge from usage. |
| Local-only stdio server (no Cloud Run endpoint) | Would require every operator to install + configure a local process. Community contributors especially wouldn't. HTTP hits Zero-config for the common case. |
| Full-fat RAG pipeline (embeddings, vector store, semantic search) | Deferred. `search_records` (substring + date filter) covers 80% of the ask; embeddings can layer on later without changing the MCP interface. Adding a vector store as first cut buys complexity we don't need to prove the shape works. |
| Serve Show Notes through the existing GraphQL / Discord bot / Slack bridge | Each is a separate integration project. MCP is a standard that unifies them — Claude / Cursor / IDE extension all speak the same protocol. |

---

## Out of Scope

- **Write tools.** No `create_record`, no `update_description`. All MCP tools are read-only. Write flows stay in the web UI where an operator can preview and confirm before mutating.
- **Vector / semantic search.** `search_chapter_moments` is substring-based; embedding search is a follow-up ADR when the substring path proves insufficient.
- **Multi-tenant scoping.** Single Workspace, single deploy. Federation across orgs is a future concern.
- **MCP `prompts/` surface.** Reusable prompt templates (e.g. "Summarise the last week of Toronto chapter") could ship later; the resources + tools cover the primary use case.
- **Rotation UX for MCP tokens.** Mint + revoke are in scope; a "regenerate this token in place" flow is deferred.
- **Streaming responses from long tools.** `search_records` returns synchronously with a cap. If we later add heavier tools (transcript re-summarise, cross-record synthesis), MCP progress notifications become worth implementing.
- **Non-Anthropic MCP clients.** The spec is open, so nothing prevents them, but our test matrix starts with Claude Desktop + Claude Code + Cursor.
