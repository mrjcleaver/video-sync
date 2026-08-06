# ADR-074: Canonical Artifact Bag per Record, Fully MCP-Exposed

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-08-06 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-039 (Drive artifact store), ADR-042 (shared credential vault), ADR-046 (show notes), ADR-053 (transcript provenance), ADR-064 (description strategy), ADR-066 (MCP show-notes server), ADR-067 (show notes → description LLM), ADR-068 (bulk description sync + backups), ADR-073 (Zoom-share → YouTube pipeline) |

---

## Context

Every catalog record already has a Drive folder (ADR-039 `driveArtifactStore`) with a `.meta.json` index. Today it holds four artifact kinds:

- `transcript.md` — from Kaltura captions / Loom Apollo / Fireflies / contributor paste
- `summary.md` — the LLM-generated Show Notes (ADR-046)
- `description.md` — YouTube description (usually written from Show Notes via ADR-067)
- `chat.md` — declared as a slot in `ARTIFACT_KINDS`, but not populated by any code path today

The record's WASM state also carries some artifact-shaped data:

- `transcript_text` — same content as `transcript.md`, redundant client-side cache
- `description` — inline copy, may drift from `description.md` between saves
- `summary_doc_id` — pointer to a Google Doc, distinct from `summary.md`

MCP (ADR-066) exposes some of this:

- Resources: `vsync://records/<id>/{show-notes,description}`
- Tools: `list_series`, `search_records`, `get_show_notes`, `get_transcript`, `get_provenance`, `search_chapter_moments`

Three gaps make it hard for an external consumer (e.g. an on-demand chapter-website generator, a Discord bot, a curator's local script) to get a *complete* picture of a record:

1. **Chat artifacts aren't populated.** `chat.md` is a slot with no writer. Zoom's meeting-chat transcript (available via `/api/zoom/chat` for org-authenticated Zoom rows), Loom comments, and Discord thread messages associated with a broadcast all vanish into private surfaces or into the event log, not into the record's folder.
2. **"What we pushed to YouTube" isn't captured as an artifact.** The `description` field in the WASM record is the *local* copy; the actual YouTube snippet as it exists on YouTube may differ (someone edited it in Studio, or an ADR-068 sync landed and a subsequent local edit didn't). ADR-068's `data/description-backups.json` captures pre-write snapshots but only for records ADR-068 touched, and it's a single global file — not accessible per-record via MCP.
3. **No aggregated view.** A downstream consumer that wants "the whole record as one thing to render" has to fetch six separate resources and stitch them. There's no `reference.md` that bundles title + times + transcript + Show Notes + description + chat + provenance links into a single coherent document.

The Agentics chapter website use case makes the gaps concrete. An MCP client asks: "give me the last three Toronto meetups as a reference doc I can render on the chapter site." Today it can pull show notes, description, and provenance separately for each — but not chat (missing), not the exact YouTube description as-published (mismatched surfaces), and not an aggregated single doc. The client ends up building its own aggregation from partial data.

---

## Decision

### 1. Formalise the artifact bag

The record's Drive folder is the canonical location for every derivable artifact. Extend `ARTIFACT_KINDS` in `driveArtifactStore.ts` to seven:

| Kind | Filename | Content | Writer |
|---|---|---|---|
| `transcript` | `transcript.md` | Full transcript, VTT-derived or contributor-pasted | ✅ existing |
| `summary` | `summary.md` | Show Notes markdown (ADR-046) | ✅ existing |
| `description` | `description.md` | YouTube description as-authored locally | ✅ existing (needs populate audit — see §Consequences) |
| `chat` | `chat.md` | Meeting chat / comment thread | ⚠ new writer needed (see §2) |
| `youtube-snippet` | `youtube-snippet.json` | Exact snippet body of the last successful `videos.update` — title, description, tags, categoryId — captured server-side by the same code that made the API call | ⚠ new |
| `reference` | `reference.md` | Human-readable single-file aggregation: title, dates, transcript, show notes, description, chat, provenance links, YouTube URL | ⚠ new (generator, see §3) |
| `meta` | `.meta.json` | Index of the above with hashes + timestamps | ✅ existing |

`youtube-snippet.json` is the source of truth for "what got pushed to YouTube last." It is **not** the same as the local `description` field or `description.md` — it may lag by one edit cycle, and that's the point: it lets a consumer diff local vs pushed without another API round-trip.

### 2. Populate the chat artifact

Three writers, one per source:

- **Zoom (authenticated org path)**: `ZoomImport` and its associated ingest already have access to `GET /users/me/meetings/{uuid}/recordings/chat` via the Zoom OAuth token in the ADR-042 vault. Wire the existing `/api/zoom/chat` endpoint's output through `setArtifact(ctx, "chat", ...)`. Zoom-share (public) rows: no chat available; write an empty `chat.md` with a one-line reason so a consumer isn't left wondering.
- **Loom**: Loom comments are exposed via `loom.com/api/v1/videos/{id}/comments` when the video is public. Best-effort scrape at import time (same posture as the existing Loom Apollo scrape); write as `chat.md`. Failed scrape → empty artifact with reason line.
- **Discord**: when a broadcast has a Discord thread (ADR-041 push webhooks record the thread ID in `metadata_extra.discord_thread_id`), the ingest fetches thread messages via `GET /channels/{id}/messages` (bot has `Read Message History` in the announcements channel). Renders as a chronological `chat.md`.

Chat population is fire-and-forget from the import path (like transcript hydration is today). The record is usable before chat lands; MCP consumers get an empty artifact until it does.

### 3. Generate the reference artifact

`reference.md` is derived, not authored. A single server-side generator (`web/src/lib/referenceRenderer.ts`) composes it from the WASM record + the artifact bag, using this template:

```
# {title}

- **Recorded:** {recorded_at}
- **Duration:** {duration}
- **Chapter / Series:** {series or contributor_chapter}
- **Contributor:** {contributor_email or host}
- **Original source:** [{source_platform}]({download_url or web_view_link})
- **YouTube:** [{youtube_url}]({youtube_url}) *(if Published)*

## Show Notes

{summary.md content}

## Description (as pushed)

{youtube-snippet.json.description, or description.md if not yet published}

## Transcript

{transcript.md content, or "not yet available (see ADR-072 fallback ladder)"}

## Chat

{chat.md content, or "not available for this source"}

## Provenance

- Origin: {origin_location}
- Intermediates: {intermediate_locations}
- Destination: {destination_location}
```

Regenerated on every material change to any input artifact. Not stored inline in the WASM record — it's cheap to regenerate and expensive to keep coherent with drifting inputs.

Trigger points: any `update_metadata` write that touches title/description, any `setArtifact` write, any successful YouTube push (ADR-068). Debounced 3s to avoid a write storm.

### 4. Extend the MCP surface

Add resource URIs (ADR-066 §3):

- `vsync://records/<id>/transcript`
- `vsync://records/<id>/chat`
- `vsync://records/<id>/description` (already exists)
- `vsync://records/<id>/youtube-snippet`
- `vsync://records/<id>/reference`
- `vsync://records/<id>/artifacts` — index (list of URIs, mimeTypes, sizes, updated timestamps)

Add tools:

- `get_chat(record_id)` → returns `chat.md` content + provenance (which source populated it)
- `get_description(record_id)` → returns local `description.md`
- `get_youtube_snippet(record_id)` → returns the last-pushed snippet JSON
- `get_reference(record_id)` → returns `reference.md`
- `list_artifacts(record_id)` → returns the `.meta.json` index

Tool inputs mirror the existing `get_show_notes` / `get_transcript` shape (single `record_id` param, role-scoped read).

### 5. Access control

Every artifact inherits the record's read-visibility per ADR-002/036:

- Records the actor's role can see in the UI → the actor can `resources/read` and `get_*` them via MCP.
- Records the actor can't see (e.g. `source_platform === "Zoom"` records for a Viewer without meeting attribution) → 403 on MCP just as in the UI.

The existing MCP `getActor` gate applies to every new tool without modification. The bearer-token identity (ADR-066) resolves to a role; the role decides which records are visible.

### 6. Backfill of existing records

Existing records get chat / youtube-snippet / reference artifacts materialised lazily — the first MCP `get_*` call that misses returns a `not_yet_generated` marker (not a 404) and enqueues a background generator. Subsequent calls succeed. This avoids a giant one-time backfill sweep across ~700 existing catalog rows on deploy.

An explicit /maintain "Regenerate artifact bags" card lets the operator force-refresh on demand — useful after prompt / template changes.

---

## Consequences

### Positive

- Every downstream consumer (chapter website generator, Discord bot, custom scripts, another AI agent via MCP) can obtain a complete, canonical view of a record in one call (`get_reference`) or granularly via the individual tools.
- `youtube-snippet.json` closes the "what's live vs what we have locally" gap that ADR-068 partially addressed — now it's a per-record artifact, not a global JSON dump.
- Chat artifacts turn a currently-lost signal (meeting-chat Q&A, Discord threads) into a first-class discoverable resource. Search-across-catalog gains real content.
- `reference.md` is the "give me everything in one file" surface that operators have asked for on demand (currently they screenshot the video card + open the Show Notes doc + copy the description separately).
- The generator + MCP surface put the org one step from third-party consumers (chapter web site auto-generation, in-Discord "!show <recent>" style summaries) without any additional server work.

### Negative

- Loom comments and Discord threads are scrape-brittle same as Loom's Apollo transcript scrape — expect one or two breakages per year when platforms change payload shapes.
- Chat population runs on every import; adds latency and API calls to a hot path. Backpressure via the existing bounded async pool pattern (ADR-071 §Consequences) applies.
- `reference.md` regeneration on every input change means a burst of writes when a curator is actively editing (title → description → show notes → back to title). Debouncing helps but doesn't eliminate — expect some `.meta.json` write churn.
- The `description` field in the WASM record now competes with `description.md` in the artifact bag AND `youtube-snippet.json.description`. Three surfaces, one datum. We accept it: WASM = editable local state, `.md` = last-authored, `youtube-snippet` = last-pushed. Legible, but a source of confusion until documented.
- Backfill-on-read means the *first* consumer per record sees `not_yet_generated`. Downstream tools need to handle the marker (retry with backoff or treat as empty) or the operator runs the backfill button first.

### Neutral

- MCP token identity + role gating is unchanged. New tools ride the existing enforcement.
- Every new artifact goes to Drive, not to FUSE. Drive is already the artifact store per ADR-039; consistency wins.
- `youtube-snippet.json` capture requires wiring one hook into the existing `/api/youtube/update-title` and `/api/youtube/upload` endpoints (they already run backup capture per ADR-068). Trivial addition.

---

## Deferred / Follow-ups

1. **Audit of existing `description.md` populate paths** — the description artifact slot exists but I don't know how consistently it's actually written today. Should be a 30-minute grep + fix before this ADR ships.
2. **Discord thread scraper writer** — needs a bot with `Read Message History` on the announcements channel; the credential + endpoint are half-done from ADR-041. Small follow-up.
3. **Loom comments scraper** — best-effort; can defer if the return on investment is low.
4. **Reference template configuration** — the §3 template is hardcoded. Making it operator-editable (like the ADR-064 description strategy config) is nice-to-have.
5. **Third-party MCP client examples** — publish a small `examples/chapter-website-mcp-client/` under `examples/` showing how a chapter organiser can fetch `get_reference` for their series and render markdown into a site. Demonstrates the intended consumer shape.
6. **`published_snippet` vs `youtube-snippet` naming** — the term "snippet" is YouTube-API-jargon; consumers may prefer "as-published". Bikeshed post-implementation.
7. **Signed URLs / expiring tokens for large artifacts** — `chat.md` for a 90-minute Discord thread could be large. If the MCP-over-HTTP boundary starts hitting response-size limits, switch to returning presigned Drive download URLs instead of inlined content. Not needed at current scale.

---

## Open questions

- **Do we want `reference.md` as a Google Doc or a raw markdown file?** Google Doc: human-navigable + shareable. Raw markdown: MCP-friendly + version-controllable. Leaning **raw markdown** (both a `.md` file *and* rendered to a Doc when a `render_to_doc` flag is set). The Doc is the human export; the `.md` is the machine surface.
- **How often does `youtube-snippet.json` refresh from *YouTube* (not from our push)?** If someone edits the description in YouTube Studio, our local copy silently diverges. Options: (a) refresh at ADR-068 bulk-sync time (already fetches YT); (b) refresh on every catalog page load (expensive); (c) never — the artifact is "as we last pushed" by definition. Leaning **(a)**.
- **Should `list_artifacts` include hashes so a consumer can cache?** Trivial to add — `.meta.json` already stores hashes. Confirming yes as a nice-to-have.
- **Chat artifact from Zoom-share (public) — is a Playwright scrape in scope?** Same trigger conditions as ADR-072 §Deferred. Leaning: **no** — chat is not blocking for publish, unlike transcript.
