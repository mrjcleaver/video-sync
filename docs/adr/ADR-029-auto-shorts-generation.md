# ADR-029: Automated Short-Form Clip Generation

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-03-19 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-012 (YouTube publish), ADR-013 (rules engine), ADR-019 (provenance graph), ADR-022 (provenance footer), ADR-027 (YouTube source), ADR-028 (download/re-upload) |

---

## Context

Long-form recordings (live streams, webinars, meetings) published to YouTube contain moments of standalone value — a sharp insight, a key demo, a memorable exchange — that are not discoverable by audiences who won't watch a 90-minute video. Short-form clips (YouTube Shorts, ≤60–180 s, vertical 9:16) dramatically increase reach and serve as trailers driving traffic to the full recording.

The primary use case is:

> A full live stream or webinar is published to the correct YouTube channel (via the existing pipeline). The system then automatically identifies the highest-value moments, produces short vertical clips with optional captions, holds them for human review, and publishes approved clips as YouTube Shorts — with the description linking back to the full video.

A secondary use case is manual, one-off clip generation triggered by an operator for a specific video.

---

## Decision

### 1. Primary Tool — Opus Clip API

**Opus Clip** is adopted as the primary clip-generation engine.

| Criterion | Opus Clip | VEED.io |
|-----------|-----------|---------|
| Programmatic API | Yes (REST, documented) | No public API |
| Webhooks | Yes | No |
| Signal types | Multimodal (visual + audio + sentiment + NLP + trend) | Transcript/NLP only |
| Auto-highlight | Yes (ClipAnything model) | Yes (UI only) |
| Virality score | Single composite, ranked | 4-axis (Flow/Impact/Clarity/Relevance) |
| Languages | ~5 | More |
| Cost model | 1 credit = 1 min of source video | Subscription |

**VEED.io** is retained as a **manual fallback** for operators who want to refine or caption clips via its editor UI. It is not integrated into the automated pipeline.

A future ADR may revisit this if VEED.io releases a general video API or if Klap (52-language support, comparable clip quality) becomes preferable for multilingual content.

### 2. Input to the Clip Pipeline

Both input modes are supported:

| Mode | When used |
|------|-----------|
| **YouTube URL direct** | Opus Clip accepts YouTube URLs natively — preferred when the source video is already public on YouTube (post-publish). Avoids an unnecessary download. |
| **Local file (yt-dlp download)** | Used when the source video is private/unlisted, or when the operator triggers clip generation before publish (i.e. from the downloaded file per ADR-028). |

The pipeline selects the mode automatically: if the video record has a `youtube://` download URL and a published `Destination / YouTube` location with a public URL, pass the YouTube URL to Opus Clip. Otherwise, download via yt-dlp and pass the local file.

### 3. Trigger

Two trigger modes coexist:

**A. Processing Rule (automatic)**

A new rule action `generate_shorts` is added to the rules engine (ADR-013). A rule may specify:

```json
{
  "action": "generate_shorts",
  "params": {
    "captions": true,
    "min_duration_seconds": 1200
  }
}
```

The rule fires after a successful YouTube publish (post-publish hook, same lifecycle point as post-processing rules in ADR-024). Typically applied to videos matching a title pattern or exceeding a minimum duration (e.g. "all recordings > 20 min").

**B. Manual per-video trigger**

A "Generate Shorts" button is added to VideoCard for any video in `Published` or `Approved` state. This calls the same pipeline as the rule, with the operator able to override caption preference.

### 4. Clip Count and Duration — AI Recommends

The number of clips and their duration are determined by Opus Clip's AI, not hardcoded. The operator does not pre-specify a count. Opus Clip returns a ranked list of clips ordered by virality score; all clips above a configurable minimum score threshold (default: no threshold — return all clips) are queued for review.

If the operator wants to constrain output in future, a `max_clips` parameter can be added to the rule action. For now, AI recommendation is authoritative.

### 5. Captions

Captions are **configurable** per rule and per manual trigger:

| Setting | Behaviour |
|---------|-----------|
| `captions: true` | Opus Clip burns captions into the short during generation. |
| `captions: false` | No captions. |
| `captions: "srt"` | Request SRT output separately (if Opus Clip supports; fallback: burn-in). |

Default for processing rules: `true` (burn-in captions). Default for manual trigger: operator's last-used preference (persisted to localStorage).

### 6. Provenance

Every generated short is catalogued as a **child record** in the provenance graph (ADR-019):

| Field | Value |
|-------|-------|
| `source_id` | `shorts-{opus_clip_job_id}-{clip_index}` |
| `source_platform` | `OpusClip` |
| `parent_source_id` | Source ID of the full-length parent video |
| `metadata_extra.parent_youtube_id` | YouTube video ID of the parent |
| `metadata_extra.clip_start_seconds` | Timestamp in source video where clip begins |
| `metadata_extra.clip_end_seconds` | Timestamp where clip ends |
| `metadata_extra.virality_score` | Opus Clip composite score |
| `metadata_extra.opus_clip_job_id` | For traceability and re-fetching |

When the short is published to YouTube, its description **must** include the provenance footer (ADR-022) with a link to the full video, e.g.:

```
📹 Full recording: https://www.youtube.com/watch?v={PARENT_ID}
```

### 7. Destination — YouTube Shorts Only

Shorts are published to YouTube only (as Shorts, using the standard YouTube upload API from ADR-012 with `#Shorts` appended to the title or description to trigger the Shorts shelf).

TikTok and Instagram Reels are explicitly out of scope for this ADR. They may be added in a future ADR once cross-platform publishing infrastructure is established.

### 8. Approval Gate — Human Review Required

Generated clips are created in `Pending` state and placed in a review queue. They are **never auto-published**. An operator must:

1. Watch the clip preview.
2. Optionally edit the title (Opus Clip suggests a title; operator may override).
3. Approve → moves clip to `Approved`, queuing it for YouTube publish.
4. Reject → marks clip `Rejected`; it is retained in the catalogue for audit but never published.

This gate exists because:
- Clip selection AI can surface off-brand or contextually inappropriate moments.
- A clip taken out of context may misrepresent the speaker.
- YouTube Shorts are public and high-visibility; the cost of a poor clip is reputational.

---

## Consequences

**Positive:**
- Automated clip generation from rules means no manual effort for regular live stream series.
- Full provenance chain: short → parent video → original recording source (Zoom/Fireflies/YouTube).
- Human review gate prevents embarrassing or off-brand clips from reaching the public.
- Captions configurable — can be turned off for content where burn-in is undesirable.

**Negative / Risks:**
- **Opus Clip API cost**: 1 credit = 1 minute of source video. A 90-min live stream costs 90 credits per run. Rules should include a `min_duration_seconds` guard to avoid spending credits on short recordings that don't benefit from clip generation.
- **Opus Clip virality model bias**: trained on general social media engagement data. May rank clips by mainstream virality signals rather than by what is meaningful to a specialist audience. Mitigation: ClipAnything prompt can guide selection; human review is the final gate.
- **Review queue backlog**: if many videos trigger the rule, the review queue may grow faster than operators process it. A future enhancement may add bulk approve/reject with preview thumbnails.
- **Webhook reliability**: the pipeline relies on Opus Clip's webhook to signal completion. If the webhook is missed (Cloud Run instance recycled), a polling fallback should be implemented against the Opus Clip job status endpoint.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| VEED.io as primary | No public API; clips cannot be generated programmatically |
| Klap | Comparable quality; stronger multilingual support; less documented API — revisit if multilingual content becomes a requirement |
| Manual only (no automation) | Defeats the purpose; operators would not consistently create shorts without automation |
| Auto-publish without review | Too high a risk of off-brand or decontextualised clips reaching the public |
| Fixed clip count (e.g. top 3) | Artificially caps value from long content; AI ranking + full list + human review is more flexible |

---

## Out of Scope (Future ADRs)

- **VEED.io API integration** — monitor for general video API availability; would add captioning and editing step between Opus Clip generation and publish
- **TikTok / Instagram Reels publishing**
- **Bulk approve UI** for the review queue
- **Custom virality rubric** — defining brand-specific clip selection criteria beyond Opus Clip's prompt system
