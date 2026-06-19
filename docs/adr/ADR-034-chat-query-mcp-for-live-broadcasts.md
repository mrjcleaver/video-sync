# ADR-034: MCP Server for Querying Live-Broadcast Chat Messages

**Status**: Proposed (exploration)
**Date**: 2026-04-21
**Deciders**: Architecture Team
**Scope**: External integrations, ADR-033 open question #5

> This ADR is **exploratory**. It asks whether it makes sense to expose a Model Context Protocol (MCP) server that lets external tools (Claude Code, other agents, future IDE integrations) query chat messages attached to videos in the catalog — particularly live-broadcast chat. No implementation is proposed here.

---

## Context

ADR-033 observed that live-broadcast YouTube videos carry **chat messages** as first-class event content. For the "Agentics Live Vibe" format this is especially load-bearing — the chat is where questions are asked, code snippets are shared, and follow-ups are agreed. The transcript captures the host, but the chat captures the audience.

Today the catalog has no concept of chat. Transcripts come from Fireflies via the source adapter and live on `VideoRecord.transcript_text`. Chat lives entirely on YouTube and is not ingested.

Separately, the project already uses Claude Code extensively for development and curation tasks. Claude Code's MCP integration (`claude mcp add ...`) lets it call arbitrary tools against external data. The same integration pattern is likely to appear in other agent-based tools as the year progresses.

The question posed by the operator: **does it make sense to expose chat messages through an MCP server** so that a coding/curating agent can ask natural-language questions like "what code snippets did viewers share during the Mar 12 session?" or "what follow-up action items came up in the chat across the last three streams?"

---

## What an MCP server would expose

At minimum, three tool calls:

| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `list_broadcasts` | optional date range, channel filter | array of `{video_record_id, youtube_id, title, actual_start_time, chat_message_count}` | Discover which records have chat available |
| `get_chat_messages` | `youtube_id` or `video_record_id`, optional offset/limit, optional text filter | array of `{author, text, timestamp, offset_from_start_seconds, is_superchat, is_member}` | Full chat transcript, seekable |
| `search_chat` | `youtube_id` optional, query string | array of matching messages with surrounding context (±3 messages) | Semantic / substring search, useful for "was X mentioned?" |

Optional further tools:

- `get_chat_summary(youtube_id)` — LLM-summarised version of the chat, cached
- `get_chat_links(youtube_id)` — just URLs / code blocks extracted from messages
- `get_author_activity(author)` — which broadcasts a given viewer participated in

---

## Decision (direction, not implementation)

**Probably yes**, with three preconditions:

1. **Chat must first be captured and stored in the catalog.** MCP is a query surface, not an ingestion path. Before any server is built, the YouTube adapter (ADR-005, ADR-027) needs to fetch chat via the `liveChatMessages.list` API during broadcasts and retain it via `liveChat` transcripts for completed streams. Storage design is the hard part, not the MCP wrapper.
2. **The domain model must get a `ChatMessage` value object** attached to the YouTube `Destination` PlatformLocation (per the ingest-method discriminator in ADR-033). Chat is inherently tied to the broadcast location, not to the aggregate.
3. **The MCP server is additive, not replacing the existing HTTP API.** The web UI keeps its REST/SSE routes. The MCP server reuses the same data-access layer but exposes it through the MCP transport for agent consumption.

With those in place, the marginal cost of adding an MCP server is low — a few hundred lines of TypeScript wrapping existing query functions — and the leverage is high: every agent-based tool the project adopts in the next year gets a consistent way to reach into the chat corpus.

### Why MCP specifically

Alternatives for "let agents query our data":

| Option | Rejected reason |
|--------|-----------------|
| Plain REST API | Works for programmatic access but requires each agent to be taught the endpoint shapes. No shared discovery. |
| GraphQL endpoint | More expressive than REST but still requires bespoke client wiring per agent. |
| Embed in the same-origin web API | Couples the agent consumer to the web app's auth + hosting; rules it out for non-browser clients. |
| **MCP server** | Purpose-built for the "agent talks to external data" use case. Claude Code, Cursor, Cline, and anthropic-sdk-based tools all speak it natively. Tool discovery is part of the protocol. |

### Transport

`stdio` and `http/sse` are the two MCP transports currently well-supported:

- **stdio**: launched by the agent as a subprocess. Zero network exposure; auth is "whoever runs the agent." Good for local dev and single-operator workflows.
- **http/sse**: long-running server. Requires auth (bearer tokens, OAuth). Necessary if the server runs on Cloud Run and agents anywhere connect to it.

For this project, both modes probably make sense:
- **stdio** for local development: `node mcp-server.mjs` piped from Claude Code config.
- **http/sse** as a mode of the main Cloud Run service, gated behind the same credential pattern as the web UI (localStorage-issued bearer? signed bearer bound to the YouTube refresh token?).

Auth for the http/sse mode is the non-trivial part — see Risks.

---

## What this enables

Example queries once live:

- *"Did anyone in the chat during the Mar 12 Live Vibe session share a GitHub link? Summarise the discussion."* → Claude calls `search_chat(query="github.com")`, then `get_chat_messages(offset=...)` for context, then summarises.
- *"Across all Live Vibe episodes this quarter, what were the three most-asked questions?"* → Claude calls `list_broadcasts(date_range=Q1)`, then `get_chat_summary` for each, then correlates.
- *"Write a follow-up email to viewers who asked about OAuth in the chat."* → `search_chat(query="oauth")` → group by author → draft.

None of these are possible via the current UI. The EventLog + VideoCard pair don't know chat exists.

---

## Consequences

### Positive

- Chat becomes queryable content alongside the transcript — closing a visibility gap that currently leaves audience engagement invisible to everyone who wasn't live.
- MCP as the query interface scales to any future agent the project adopts without per-agent integration work.
- Existing chat summaries could feed post-processing rules (ADR-024): "if chat contains a 'more info' request, send email X."

### Negative

- Chat ingestion is a non-trivial new pipeline. Live chat is a streaming API during broadcasts and a rewind-only archive for completed streams. Both paths need implementing.
- Storage grows. A busy 2-hour stream can produce 5000+ messages. Across 18 months that's a non-trivial blob. Probably lives in the GCS FUSE mount (ADR-018) or a SQLite table (ADR-016 Tier 2), not in localStorage.
- MCP auth model has no precedent in this project. The web UI's localStorage-credentials pattern (ADR-011) is browser-specific and does not translate to external agent consumers.

### Risks

- **Unauthenticated MCP in http/sse mode** would expose chat and transcript contents publicly. Mitigation: require a signed bearer token (short-lived, derived from the operator's YouTube OAuth) for every MCP request. `stdio` mode sidesteps this entirely.
- **YouTube chat API quota**: `liveChatMessages.list` costs 5 units per call. A 2-hour stream polled every 5s costs ~14,400 units just to capture. Mitigation: prefer the completed-broadcast archive endpoint (cheaper, bounded) over live polling when possible; batch-capture only on-demand rather than every stream.
- **PII in chat messages**: viewer display names, member status, super-chat dollar amounts. Before exposing through MCP, confirm with the operator whether this data should be redacted from summaries or query results. Probably yes for public channels; definitely yes if a private agent fans it out further.

---

## Alternatives considered

| Option | Rejected reason |
|--------|-----------------|
| **Do nothing; rely on YouTube Studio chat-replay** | Workable for one-off human review, not for cross-broadcast analysis or agent-driven workflows. |
| **Ingest chat but keep it inside the web UI only** (no MCP) | Delivers the storage benefit but leaves the "agent can query it" gap. Could be a staging step if MCP is deferred. |
| **Build a generic REST API for everything** (not just chat) | Larger scope; no proven demand beyond chat. YAGNI for v1. |
| **Use an off-the-shelf chat-analysis product** (e.g. Common Room, Salesmsg) | External dependency, another account to manage, chat export would still need to run first. |

---

## Open questions

1. **Storage location for chat**: GCS FUSE file per broadcast? SQLite table? What's the query pattern — per-broadcast lookup or cross-broadcast search? The answer drives whether we need an index.
2. **Ingestion trigger**: scheduled poll (for completed broadcasts) vs. real-time capture (via `liveChatMessages.list` during the stream)? Real-time is expensive (see Risks) but is the only way to not miss deleted/edited messages.
3. **MCP scope**: chat-only, or should the MCP also expose transcript search, video metadata, and provenance graph? Expanding scope adds value but blurs the ADR boundary.
4. **Author identity**: YouTube chat authors have a channel ID but not an email. Correlating a chat author across broadcasts is possible; correlating them to a Fireflies / Zoom participant list (ADR-033) is not, short of manual mapping.
5. **Redaction policy**: does the MCP return raw messages or a PII-redacted view? Probably config-driven per-tool.

---

## Related ADRs

- **ADR-005**: Source Integration Strategy — chat ingestion would extend the existing source-adapter pattern.
- **ADR-017**: Observability — any MCP activity should produce structured log entries for audit.
- **ADR-018**: Google Cloud Hosting — http/sse MCP mode likely runs inside the same Cloud Run service.
- **ADR-024**: Post-processing Webhook and Email — chat-triggered notifications would hook into this.
- **ADR-027**: YouTube Source Ingestion — chat capture is a natural extension of the existing YouTube adapter.
- **ADR-033**: Multi-origin dedupe and live-stream semantics — established that chat attaches to the YouTube `Destination` location; this ADR operationalises that decision.
