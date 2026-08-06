# ADR-072: Zoom Share Transcript Extraction — Fallback Ladder

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-08-06 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Related** | ADR-050 (Fireflies downstream of the meeting source), ADR-053 (transcript provenance lookup), ADR-065 (contributor role), ADR-071 (Google Drive ingest — introduced the transcript-paste field) |

---

## Context

Contributors submit public Zoom recording shares (`zoom.us/rec/share/<blob>`) via `/contribute` (shipped in `8b46826`, ADR-065 contributor-role work). The URL-import flow accepts them, but the resulting catalog record is a **placeholder** — no title, no duration, no thumbnail, and, most consequentially, **no transcript**. That last gap matters because most of the platform's downstream value (Show Notes generation, description sync, chapter-cue extraction, search-across-content) is transcript-dependent.

Zoom's public share pages are hostile to un-authenticated extraction:

- The `zoom.us/rec/share/<blob>` URL renders HTML that redirects to a signed CDN player URL. The player fetches `.vtt` captions from a second signed URL that requires the passcode + session cookies set by the redirect chain.
- There is no un-authenticated JSON API for share metadata — the JSON that populates the player is inlined in a `<script>` tag and its shape has broken across Zoom UI revisions historically (twice observed in adjacent Loom-scrape work, per ADR-050 postmortem).
- The authenticated Zoom Cloud Recording API (used by `ZoomImport.tsx`) requires the *host account* — a contributor's share URL from *their* Zoom account is unreachable from our org's OAuth token.

So the transcript has to come from somewhere else — or we don't get one.

### What we already have

Two paths *already resolve* the transcript for a contributor Zoom share without touching Zoom's UI, and both landed as side effects of unrelated work:

1. **ADR-053 borrowed transcript**. If the recording *also* exists on an org-authenticated Zoom account (e.g. because the host is an Agentics chapter organiser whose account is OAuth-connected under `ZoomImport`), a paired-record match on title + `recorded_at` sources the transcript from that record. The contributor's placeholder record then borrows it via `resolveTranscriptForOperation` at Show Notes / description generation time. **Cost: zero. Reliability: high when the org owns the meeting, zero otherwise.**

2. **Contributor-paste field on `/contribute`**. Landed as ADR-071 §4 (the Drive-ingest work) because Drive files had the same "arrives without a transcript" gap. The field is source-agnostic — a contributor pasting a Zoom-share URL can paste the transcript they already have (from Otter, Fathom, Zoom's own downloaded VTT, or Fireflies) into the same textarea. **Cost: zero. Reliability: depends on the contributor having the transcript to hand.**

These two solve the *common* cases:

- **A chapter meeting the host recorded to their org-connected Zoom account** → §1 catches it automatically.
- **A guest presenter who has their own Otter / Fathom pipeline** → §2 catches it, with one textarea copy-paste.

What they don't solve:

- **A one-off share from a Zoom account we don't have OAuth on**, submitted by someone who doesn't already have a transcript. Today that record sits in the catalog with a Show Notes / description path that will silently fall back to no output.

### What we could build

Two candidates beyond the shipped baseline:

- **Playwright headless scrape**. A Cloud Run container running Chromium + Playwright renders the Zoom share page, waits for the player XHR to fire, intercepts the signed VTT URL from network events, downloads the VTT, dedups the captions, writes them to the record. Reliable when it works, expensive to build (~1–2 engineering days), brittle to Zoom UI revisions (Loom's Apollo-scrape has broken twice — Zoom's payload shape is likely worse-tenured because Zoom pushes web-UI updates far more often than Loom does), and requires a second Cloud Run service with an inflated image (Chromium is ~200 MB).
- **Whisper transcription on the audio**. The public share page *does* stream playable audio through the signed player URL. Playwright could capture the media stream (or `yt-dlp` could resolve it), we run OpenAI Whisper (or `whisper.cpp` local) on the bytes, emit a transcript marked `source: "whisper_generated"` for provenance. Cost per minute: ~$0.006 (OpenAI) or ~free compute (local). Reliability: high (Whisper handles Zoom-quality audio fine). Cost of *building* it: ~2 engineering days for Playwright audio capture + Whisper wrapper + provenance markers. Cost per record after that: ~$0.36 per hour of recording × org's throughput.

### The choice

We do NOT build Playwright/Whisper right now. Three reasons:

1. **Skeptical demand.** The paths shipped as §1 + §2 cover the meeting shapes we've actually seen. The uncovered case ("one-off external Zoom share, contributor without a transcript") is *possible* but we don't yet have evidence it happens at a rate that justifies a headless-browser service.
2. **The transcript-paste field lowers the bar.** A contributor who has a transcript in *any* form can paste it. That's often true even for external shares — Zoom's own "Download transcript" button in the share page's UI produces a `.vtt` the contributor can paste in ~30 seconds. This ADR proposes making that flow more discoverable (§Decision.3) before spending engineering days on scraping.
3. **Zoom ToS exposure.** Scraping Zoom's UI and re-hosting the VTT is at best a grey area under Zoom's Terms of Service. We shouldn't sink build effort into something that a legal review could subsequently kill.

---

## Decision

### 1. Adopt the fallback ladder

For any record with `source_platform = "Zoom"` and a `zoom-share-<blob>` source_id, the transcript resolves in this order:

1. **Contributor-provided at submit time** — the paste field on `/contribute` (ADR-071 §4). Shipped.
2. **ADR-053 borrowed** — matched against org-Zoom / Fireflies / YouTube-Live paired records at Show Notes / description generation time. Shipped.
3. **Manual curator paste later** — Publisher/Admin opens the record, pastes a transcript into the existing edit-transcript affordance on the video card. No new UI; just documented as the escalation path.
4. **No transcript, mark the record** — Show Notes / description regen paths skip cleanly, and the record surfaces in the catalog with a "transcript missing (contributor Zoom share)" hint so curators can decide whether to escalate to §3 or leave it.

### 2. Add a "transcript missing" hint on Zoom-share records

Video cards with `source_platform = "Zoom"` + `source_id = "zoom-share-*"` + no transcript get a small badge (`⚠ no transcript`) with a tooltip explaining the fallback ladder. Non-blocking; the record remains fully catalog-navigable. Renders only if all four ladder rungs have failed (i.e. no borrowed transcript is available at render time), so the badge signals "this is stuck at rung 4" specifically.

### 3. Reduce the contributor's cost of §1

The `/contribute` transcript-paste field (ADR-071 §4) is a collapsed `<details>` disclosure — a contributor who doesn't already know it's there won't discover it. Two tweaks:

- **Auto-open the disclosure when a `zoom-share` URL is detected** in the URL box. Preserves the "hidden by default" affordance for YouTube / Loom (which have their own transcript paths) while nudging contributors submitting Zoom shares to notice the paste field.
- **Add a "How to get the Zoom transcript" hint** under the textarea. Two-line: "In your Zoom share page → Transcript tab → click 'Download'. Paste the VTT content here." Legibly short, no walkthrough video, no external link.

Both are ~30-line client-side changes to `contribute/page.tsx`. Not shipped in this ADR — they are the scoped follow-up work (§Follow-ups).

### 4. Explicitly defer Playwright + Whisper

Both stay as **§Deferred** with the trigger conditions we would need to see before revisiting:

- **Playwright headless scrape**: revisit iff (a) we see ≥ 10 records/month in the "rung 4" state (missing transcript despite the ladder) AND (b) a legal review clears the ToS posture on scraping + re-storing Zoom VTTs.
- **Whisper transcription**: revisit iff (a) ≥ 10 records/month rung-4 AND (b) either the ADR-071 §Follow-up #1 (Whisper on FUSE Drive files) has already shipped its provenance + prompt-semantics ADR (so we get the framework for free) OR the org accepts a standalone Whisper-only ADR.

Both triggers write the deferred work back in as an explicit ADR-072-follow-up, not a stealth commit.

---

## Consequences

### Positive

- Ships zero engineering effort in the near term. The two rungs that cover the common cases are already live.
- Makes the transcript-paste field discoverable exactly when it matters (Zoom-share contributor) without adding UI noise for other sources.
- Preserves a legible escalation path (§3 curator paste) that doesn't need code — Publisher already has the video-card transcript-edit affordance.
- Keeps our posture toward Zoom's ToS conservative. If Zoom ever offers a public metadata / transcript API for share URLs, we adopt it cleanly; we haven't built brittle scraping we'd need to unwind.

### Negative

- Records at rung 4 stay transcript-less indefinitely. Show Notes / description generation is a no-op for them; catalog search over content misses them; ADR-068's bulk-description-sync skips them for lack of source. The **⚠ no transcript** badge is honest about this — the failure mode is visible — but honest ≠ solved.
- The "auto-open the disclosure" behaviour is a subtle UX pattern (`<details>` opening imperatively). Contributors who dismiss it aren't nudged again; if they don't paste, we're back at rung 4.
- We defer a real solution to a metrics threshold we don't yet measure. If the "rung 4" rate really is high, we'll only find out once someone complains — no dashboard, no alert. The Sidebar maintenance badge could surface this (§Follow-ups) but we're not committing to that in this ADR.

### Neutral

- The fallback ladder shape (deterministic rung ordering + explicit non-goal at the bottom) is a good pattern we could apply to Google Drive files, guest YouTube channels the org doesn't own, or any other source with imperfect coverage. It's fine to formalise the shape here even before we generalise it.

---

## Deferred

1. **Discoverability tweaks on `/contribute`** — auto-open the transcript paste field when a Zoom share URL is detected, add the "How to get the Zoom transcript" hint. Scoped as ~30 LOC + one screenshot in the Contributor guide.
2. **"⚠ no transcript" badge on Zoom-share cards** — client-side only, uses existing resolution paths to decide whether it renders. ~40 LOC on `VideoCard.tsx`.
3. **Rung-4 metrics** — Sidebar badge count for Zoom-share records without transcript. Would surface the volume so we can objectively evaluate the Playwright / Whisper triggers.
4. **Playwright headless scrape service** — gated on §1 + rung-4 metric + ToS review. Would be a separate Cloud Run service; ADR at authoring time will cover: Chromium container size, ToS posture, VTT provenance markers, DOM-selector fragility mitigation, error budget for Zoom UI revisions.
5. **Whisper on Zoom-share audio** — even more deeply deferred. Only makes sense if §4 (Playwright) is already in place (needs Playwright to capture the audio stream) OR the ADR-071 §Follow-up #1 (Whisper on FUSE videos) ADR arrives first with a general audio-transcription framework we can reuse.
6. **Contributor guide entry** — README-style walkthrough of "how to submit a Zoom share with a transcript". Lives with the other contributor docs; belongs to the ADR-065 documentation surface, not this one.

---

## Open questions

- Should the "⚠ no transcript" badge on rung-4 records also count toward the `/maintain` badge, or is that too noisy? (Leaning: NO for MVP — the paste field on `/contribute` and curator paste on the video card already give enough surfaces.)
- Is there a threshold (e.g. record count, catalog fraction) at which we would move from "wait for triggers" to "build Playwright"? Naming a number would let this ADR fire itself when the number is crossed. Leaning: **≥ 10 rung-4 records per month sustained for ≥ 3 months.**
- When contributors DO paste a transcript, should we mark provenance? Today it lands in `transcript_text` indistinguishably from a machine-fetched one. A single `metadata_extra.transcript_source = "contributor_pasted"` would let downstream tooling weight it appropriately (e.g. LLM Show Notes could add a "transcript accuracy: contributor-provided" caveat). Leaning: **yes, but as a distinct 20-LOC PR** rather than folded into this ADR.
