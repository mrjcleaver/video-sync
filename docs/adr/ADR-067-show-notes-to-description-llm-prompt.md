# ADR-067: LLM-Rewrite Show Notes → YouTube Description

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-03 |
| **Deciders** | Engineering, Content Operations, Marketing |
| **Supersedes** | ADR-064 §2 (deterministic `showNotesToDescription` as the sole path) — retained as a safety net, not as the primary. |
| **Related** | ADR-046 (prompt-driven Show Notes), ADR-064 (description strategy), ADR-066 (MCP surface — same OpenRouter credential path) |

---

## Context

ADR-064 shipped a deterministic markdown→plain-text converter (`showNotesToDescription`) that turned each record's Show Notes doc into the paragraph description sent to YouTube. It got the chapter-cue mechanics right — `HH:MM:SS Chapter` lines that YouTube's chapter picker recognises. Two problems have surfaced in practice:

- **The 5000-character cap.** Multi-hour livestreams routinely produce Show Notes that exceed 5000 chars once flattened. The safety-net truncation lops off the tail — trimmed content is often the "why does this matter" bit that lives at the end of a chapter's bullet list, exactly the wrong thing to cut.
- **Too detailed, wrong voice.** A description is a marketing artefact. A verbatim flatten of Show Notes reads like meeting minutes — every bullet under every section, chronological, no hook, no editorial hierarchy. Viewers scrolling YouTube skim the first two lines to decide whether to click. The Show Notes format doesn't put a hook there; the deterministic converter can't invent one.

The Show Notes prompt (ADR-046) is already tuned for archival completeness. Trying to make ONE artefact serve both archival ("what happened, in order, timestamped") AND marketing ("why should I click this thumbnail") stretches it. What we actually want is a SECOND pass that reads the archival doc and produces the marketing artefact — with all the editorial choices marketing needs (hook, chapter picks, cut trivia) — while keeping the YouTube-specific mechanics (chapter-cue format, char cap, plain text, no markdown).

An LLM is the obvious fit. It can distinguish "5-minute setup where we fixed the mic" (skip) from "20-minute demo where the agent solved the ticket end-to-end" (chapter it, quote it in a bullet). The deterministic converter can only pattern-match; it can't editorialize.

---

## Decision

### 1. Add a Show-Notes-mode prompt to the description config

`data/description-config.json` gains `show_notes_prompt: string` alongside the existing `prompt_text` (transcript-mode prompt). Admin edits it in **Config → 📝 Description strategy** (a new textarea above the existing transcript-mode textarea, with a Reset button).

Default prompt shipped in code — a compact rubric with:
- **Opening hook** (1–2 sentences, ~200–300 chars) — the concrete reason to watch, no throat-clearing.
- **Chapter list** in strict `HH:MM:SS Chapter Title` form — first line MUST be `00:00:00 <opener>` (YouTube requirement), 5–12 chapters, strictly ascending, trivial chapters (housekeeping / breaks) omitted, audience-facing titles preferred over "Chapter N" labels.
- **Optional bulleted highlights** — 3–5 distinct moments a viewer will want to reach; only if under the char cap.
- **Optional closing** — carry over CTAs the Show Notes already have.

Constraints in the prompt:
- ≤ 4800 chars (leaves 200-char headroom under YouTube's 5000 cap for future tags/URLs).
- No markdown formatting (YouTube renders `**bold**` and `##` as literal characters).
- No invention — every claim verifiable from Show Notes text.
- Voice matches Show Notes (first-plural if `we`, else third-person).

### 2. New endpoint: `POST /api/description/from-show-notes`

Distinct from the transcript-mode `/api/process/summarize` (which returns JSON `{summary, topics, highlights}`). This one takes `{show_notes: string}` and returns `{text, model}` — raw plain-text description. Calls OpenRouter with:
- Default model: `google/gemini-2.5-flash` (fast + cheap; the input is already curated Show Notes, so we don't need the top-tier reasoning of Pro).
- Automatic fallback to `anthropic/claude-haiku-4-5` on 400/402/404/429 OR empty completion — same pattern ADR-052 uses for the Show Notes generator itself.
- Belt-and-braces client-side truncation at 4800 chars (last-complete-line + ellipsis) — never fires when the prompt worked, but catches a model that overshoots.

### 3. Client wiring in `VideoCard.tsx`

The **📋 Copy from Show Notes** button (mode = `copy_show_notes` AND `summary_doc_id` present):

1. Fetch Show Notes markdown via `/api/summary/read`.
2. POST it to `/api/description/from-show-notes`.
3. On success (`text ≥ 20 chars`) — `update_metadata({description: text})`, emit `DescriptionCopied: … via llm`.
4. **On any failure** — call the deterministic `showNotesToDescription(md)` converter (ADR-064) as a safety net. If THAT also produces < 20 chars, surface an error. Emit `DescriptionCopiedFallback: … LLM path failed; using deterministic converter` so operators can spot systemic LLM outages.

The deterministic converter stays in the codebase as this safety net. It's the "guaranteed something usable ships" floor when the LLM is unavailable / rate-limited / returning empty output.

### 4. Prompt lives on the server

Server-side `readDescriptionConfig()` (existing) already reads the file at request time; the new field slots in. No client-side caching of the prompt — every LLM call reads the current version, so an admin edit takes effect immediately without a redeploy.

---

## Consequences

**Positive**
- Descriptions land under YouTube's cap by construction, not by truncation. When we lose content, we lose it deliberately (the LLM chose to skip a trivial chapter) rather than blindly (the last N chars fell off a cliff).
- Marketing hook lives at the top of every description — viewers scrolling YouTube see something compelling in the two visible pre-fold lines.
- Chapter cues survive the LLM pass because the prompt teaches the model exactly what format YouTube requires (2-digit hour, first at `00:00:00`, strictly ascending, no brackets/bullets).
- Admins tune the marketing voice without a redeploy — house style, sponsor placement, CTA lines, language, emoji policy all in a single textarea.
- Reuses the OpenRouter credential + Show Notes read machinery already in place. No new secrets, no new integrations.

**Negative / trade-offs**
- **Non-determinism.** Two clicks on the same Show Notes doc can produce two different descriptions. Acceptable because a description is a curated artefact — an operator reviews and can re-generate if unhappy. Not acceptable for content the operator ships unreviewed; deferred (see §Out of Scope). We keep temperature low (0.4) to reduce variance.
- **Hallucination risk.** The prompt explicitly says "do not invent facts" but LLMs occasionally do anyway. Mitigation: the description is human-reviewable before push-to-YouTube; the audit log names the model (`gemini-2.5-flash` vs `claude-haiku-4-5` fallback) so post-hoc analysis is possible.
- **Cost.** Each Copy-from-Show-Notes click now spends ~$0.001–0.005 depending on model + Show Notes size. On the order of $0.10 per hundred descriptions. Trivial at current scale; worth noting because ADR-064's converter was zero-cost.
- **Latency.** ~2–8 seconds per description vs deterministic instant. Acceptable given the per-record review flow — an operator generates a description, reads it, edits/regenerates or pushes to YouTube. The wait sits inside a curatorial moment, not a bulk pipeline.
- **Prompt drift.** As the marketing team learns what performs on YouTube, the default prompt will evolve. Every org's tuned version diverges from the default. There's no history / rollback UI (yet). Deferred.

**Downstream effects to watch**
- **ADR-064**'s `showNotesToDescription` deterministic converter becomes a safety net rather than the primary path. Kept as-is; it's tested and cheap.
- **ADR-046 Show Notes prompt** should NOT be tuned for marketing — its job is archival completeness. The two prompts serve different audiences; keeping them cleanly separated avoids the "meeting-notes-that-are-also-marketing" trap that motivated this ADR.
- **OpenRouter cost dashboard.** Description generations now hit OpenRouter twice per record over the lifecycle (Show Notes generation via ADR-046 + description rewrite here). Model choice on this pass defaults to Flash for that reason — a Pro-tier model would triple cost without materially improving output.
- **Push-to-YouTube flow (ADR-064-adjacent)** is unchanged — it still ships whatever `video.description` holds. The change is only in HOW that field gets populated.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| Keep the deterministic converter and tune the ADR-046 Show Notes prompt to output description-friendly text directly | Overloads one prompt with archival + marketing goals. Both suffer. The two-pass separation is cleaner. |
| Truncate more intelligently in the deterministic converter (e.g. keep first N chars of each chapter, drop tail bullets) | Doesn't fix the "no hook, no editorial hierarchy" problem. Still meeting minutes shape. |
| Have the LLM produce BOTH Show Notes AND description in one pass | Doubles the size of the ADR-046 prompt, mixes concerns, and forces a fresh Show Notes regen whenever marketing wants a description tweak. Two separate prompts on two separate files is the right seam. |
| Use a Claude-tier model (Sonnet) for higher quality on the description pass | Overkill for the ~1000-token input. Flash + Haiku fallback are both plenty capable at this task; the marginal quality gain wouldn't justify 5× the cost per description. Reconsider if outputs disappoint. |
| Ship pre-configured prompt templates per series (per-series marketing voice) | Deferred. One prompt per org for now — good enough to prove the shape. Per-series overrides can layer on later. |

---

## Out of Scope

- **Per-series prompt overrides.** Series-registry entries could carry a `description_prompt_override` field. Not shipped yet.
- **Prompt version history + rollback.** Same shape as ADR-046 has for Show Notes prompt versioning. Deferred until the first "the prompt got worse after that edit, revert please" moment.
- **Batch mode** (mass-regen descriptions from Show Notes on a bulk basis) — the ADR-064 §Out of Scope note about "bulk description refresh" still applies. Per-record from the card is the intended flow for now.
- **A/B testing the prompt against YouTube analytics.** Correlating description prompt changes with view-through rate is a marketing-analytics project, not an app-layer concern.
- **Streaming the LLM output** to the operator as it generates. Full-response wait is fine at this latency; streaming adds UI complexity that isn't warranted.
