# ADR-014: Publishing Attribute Processing Rules

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-03-04 |
| **Deciders** | Architecture Team |
| **Project** | VID-BRIDGE-01 |

## Context

When a video is published to a destination platform, the metadata sent upstream (title,
description, tags, privacy status) often needs to differ from the raw imported values.
Common needs:

1. **Title standardisation** — "Live Vibe Coding" recorded on 3 Feb 2026 should become
   "Live Vibe Coding - 3 Feb 2026" (or whatever convention the operator uses) rather than
   whatever Zoom named the meeting.
2. **Description derivation** — If the recording has an upstream description field, that
   content should flow through. If the operator has summarised the session in notes, that
   summary should become the YouTube description.
3. **Transcript-derived summary** — If `transcript_text` is available, the description
   field can be populated automatically: first from an extractive summary, later from an
   LLM-generated one.
4. **Tag normalisation** — Consistent tagging conventions across a batch (e.g., always
   append `"live-coding"` to a series of sessions).

ADR-012 currently passes `video.title` and `video.description` verbatim to the YouTube
upload API. ADR-013 introduced ingestion rules that classify and filter recordings. This
ADR introduces a complementary layer: **processing rules** that transform publish
attributes *after* classification and *before* upload.

### Distinction from Ingestion Rules (ADR-013)

| | Ingestion Rules | Processing Rules |
|---|---|---|
| **When** | At import / classification time | At publish time |
| **Input** | VideoRecord status | VideoRecord metadata + transcript |
| **Output** | Status transition (InScope, Approved, Skipped) | Transformed publish attributes (title, description, tags) |
| **Side effect** | Mutates aggregate status | Produces a publish payload; does not mutate the record |

Processing rules are non-destructive: they compute an *overlay* of attributes for the
upload call. The original VideoRecord fields are never overwritten.

---

## Decision

### 1. ProcessingRule Schema

```
ProcessingRule {
  id:        string (UUID)
  name:      string
  enabled:   boolean
  priority:  number          // Lower = evaluated first; first match wins per field
  created_at: DateTime

  // Match criteria — same structure as IngestionRule criteria (re-use ADR-013)
  criteria: RuleCriteria

  // Attribute transforms — each is optional; absent fields are left as-is
  transforms: {
    title?:        AttributeTransform
    description?:  AttributeTransform
    tags?:         TagTransform
    privacy_status?: "private" | "unlisted" | "public"
  }
}

AttributeTransform {
  mode: "template" | "transcript_extract" | "transcript_llm" | "literal"
  value?: string           // Template string or literal value
  max_chars?: number       // Truncation limit (YouTube title: 100, description: 5000)
}

TagTransform {
  mode: "append" | "replace"
  tags: string[]
}
```

### 2. Template Syntax

Templates use `{{variable}}` interpolation. The context available in every template is
derived from the VideoRecord:

| Variable | Example output |
|----------|---------------|
| `{{title}}` | `Live Vibe Coding` |
| `{{date}}` | `3 Feb 2026` |
| `{{date:YYYY-MM-DD}}` | `2026-02-03` |
| `{{date:D MMM YYYY}}` | `3 Feb 2026` |
| `{{date:MMMM D, YYYY}}` | `February 3, 2026` |
| `{{date:ddd D MMM}}` | `Tue 3 Feb` |
| `{{day}}` | `Tuesday` |
| `{{duration}}` | `42 min` |
| `{{source_platform}}` | `Zoom` |
| `{{description}}` | *(upstream description field)* |
| `{{participants[0]}}` | `alice@example.com` |
| `{{tags}}` | `live-coding, rust` |

Date variables are derived from `recorded_at` if set, otherwise `indexed_at`.

**Examples:**

```
title template:   "{{title}} - {{date:D MMM YYYY}}"
→ "Live Vibe Coding - 3 Feb 2026"

title template:   "{{day}} Session: {{title}} ({{duration}})"
→ "Tuesday Session: Live Vibe Coding (42 min)"

description template:
  "Recorded {{date:D MMM YYYY}}.\n\n{{description}}"
→ "Recorded 3 Feb 2026.\n\nThis session covered RvDNA and…"
```

### 3. Transcript-Derived Description

When `transcript_text` is present on the record, two modes are available:

#### `transcript_extract` (MVP — no external API)

Extracts the first N sentences (default 5) from `transcript_text` as a plain-text
summary. Operates entirely client-side.

```
description transform: {
  mode: "transcript_extract",
  max_chars: 1000
}
```

The extractor splits on sentence boundaries (`. `, `? `, `! `), takes sentences until
`max_chars` is reached, and appends `"…"` if truncated.

#### `transcript_llm` (near-term — requires OpenRouter)

Sends `transcript_text` to [OpenRouter](https://openrouter.ai) and returns a structured
summary. OpenRouter provides a single API endpoint compatible with the OpenAI SDK that
routes to any supported model (e.g. `google/gemini-2.0-flash-001`,
`anthropic/claude-3-haiku`, `meta-llama/llama-3.3-70b-instruct`). The operator picks
the model in the Processing Rules settings; the default is a fast, low-cost model.

```
{
  summary: string        // 2–4 sentence overview
  topics: string[]       // Key topics discussed
  highlights: string[]   // Notable moments or decisions
}
```

The description transform assembles these into a YouTube description using a template:

```
description template (for transcript_llm output):
  "{{summary}}\n\nTopics: {{topics}}\n\nRecorded {{date:D MMM YYYY}}."
```

**Credential storage:** The operator enters their OpenRouter API key in the
**Connections panel** (stored in `localStorage["video-sync:connections"]["OpenRouter"]`).
The key is sent from the client to `/api/process/summarize` in the POST body and is
never persisted server-side. A server-side `OPENROUTER_API_KEY` environment variable
acts as a fallback for headless/CI scenarios. The model can also be overridden per
operator in the Connections panel (`model` field), or via `OPENROUTER_MODEL` env var.

**Why OpenRouter instead of a vendor-specific API?**
- Single key, any model — the operator can switch between Gemini, Claude, Llama, or
  Mistral without changing code or managing multiple API accounts.
- Cost transparency — OpenRouter shows per-request cost; operators can choose cheaper
  models for bulk batch summarisation and stronger models for high-profile sessions.
- No vendor lock-in — if a model's pricing or quality degrades, switching is a one-line
  environment variable change.

**Why not do this in the browser?**
The transcript can be many thousands of words. Sending it via OpenRouter requires a
server-side API key that must not be exposed to the browser. The summary is computed in
a Next.js API route (`/api/process/summarize`) and the result is returned to the client
before upload.

### 4. Rule Evaluation

Processing rules are evaluated at publish time, just before the upload API call:

```
function applyProcessingRules(
  rules: ProcessingRule[],
  video: VideoRecordJSON
): PublishAttributes {
  const base: PublishAttributes = {
    title: video.title,
    description: video.description ?? "",
    tags: video.tags,
    privacy_status: "unlisted",
  };

  const enabledRules = rules
    .filter(r => r.enabled && matchesCriteria(r.criteria, video))
    .sort((a, b) => a.priority - b.priority);

  for (const rule of enabledRules) {
    if (rule.transforms.title && !overridden.title)
      base.title = applyTransform(rule.transforms.title, video);

    if (rule.transforms.description && !overridden.description)
      base.description = applyTransform(rule.transforms.description, video);

    if (rule.transforms.tags)
      base.tags = applyTagTransform(rule.transforms.tags, base.tags);

    if (rule.transforms.privacy_status)
      base.privacy_status = rule.transforms.privacy_status;
  }

  return base;
}
```

Each field is overridden by the first (lowest-priority) matching rule only — subsequent
rules skip already-overridden fields. Tag rules always accumulate (all matching rules
contribute).

### 5. Preview Before Publish

The VideoCard gains a "Preview Publish Attributes" section that shows the computed
title, description, and tags before the operator clicks "Publish to YouTube". This lets
operators verify the template output before upload.

The preview is computed on-demand (no upload) and displayed inline on the card.

### 6. Storage

Processing rules use the same localStorage pattern as ingestion rules (ADR-013):

```
localStorage["video-sync:processing-rules"] = JSON.stringify(ProcessingRule[])
```

Migrated to server-side JSON file (Tier 2) or database (Tier 3) alongside ingestion
rules.

### 7. UI

A new **ProcessingRulesPanel** (collapsible, below RulesPanel) provides:
- List of processing rules with enable/disable toggles
- Rule editor with criteria (same as ingestion rules) + transform fields per attribute
- Template input with a live preview rendered against a selected video
- "Preview on video" action: shows the computed publish attributes for any video in the store

The VideoCard "Publish to YouTube" flow:
1. Processing rules are applied → `PublishAttributes` computed
2. "Preview" section shows computed title/description/tags
3. Operator confirms or edits inline
4. Upload proceeds with the (possibly edited) attributes

---

## Consequences

### Positive

- Operators can standardise titles and descriptions across a batch without editing each
  video record individually.
- Template-based transforms are deterministic and auditable — the operator can preview
  exactly what will be sent to YouTube.
- `transcript_extract` provides a useful description automatically at zero API cost,
  even before LLM integration.
- Non-destructive design: the original VideoRecord is never mutated, so re-publishing
  with a different rule produces a different result without data loss.
- Re-uses the ADR-013 `RuleCriteria` structure — no new matching logic needed.

### Negative

- `transcript_llm` mode adds a dependency on OpenRouter and increases publish
  latency by ~2–5 seconds per video (varies by model).
- Two rule systems (ingestion + processing) increase cognitive load. Mitigation:
  clear UI separation and different panel headers.

### Risks

- **Template errors** — A malformed template (bad variable name, unclosed brace) should
  fall back to the original field value with a visible warning, not cause the upload to
  fail.
- **YouTube title length** — YouTube enforces a 100-character title limit. The transform
  layer must truncate and warn if the rendered title exceeds this.
- **Transcript quality** — Zoom auto-transcripts have errors. Extractive summaries may
  include nonsense sentences. Mitigation: operator sees the preview before upload and can
  override inline.

---

## Implementation Phases

| Phase | Scope |
|-------|-------|
| **MVP** | Template mode for title + description. `transcript_extract` mode. ProcessingRulesPanel UI. Preview on VideoCard. |
| **Near-term** | `transcript_llm` mode via `/api/process/summarize` + OpenRouter (key stored in Connections panel). |
| **Production** | Processing rules stored server-side. Rules applied in background worker (Tier 3). Audit log of computed attributes per publish event. |

---

## References

- ADR-002: Unified Video Metadata Schema (VideoRecord fields)
- ADR-009: Checklist Curation (operator review workflow)
- ADR-012: YouTube Publish Integration (upload API, field constraints)
- ADR-013: Batch Ingestion Rules Engine (RuleCriteria re-use, storage pattern)
