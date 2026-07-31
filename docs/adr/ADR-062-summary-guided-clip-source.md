# ADR-062: Summary-Guided Clip Source Construction

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-07-27 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | Partially supersedes ADR-060 §4 (hard main-show trim as clip source) |
| **Related** | ADR-029 (auto-shorts generation), ADR-046 (prompt-driven summaries), ADR-052 (summary badge backfill), ADR-059 (pre-show trim for summaries), ADR-060 (scheduled show windows) |

---

## Context

ADR-060 introduced a scheduled show window per series and made "the main show" the default source region for Opus Clip. Two problems with that hard boundary have surfaced:

1. **Great moments live outside the main show.** Late-arriving guests, unfiltered Q&A that outshines the scripted programme, an inadvertent hot take at 2 minutes into the pre-show — none of these get considered when Opus is bounded to the scheduled window. Ops feedback: "the tradeoff of hard cut off for the after show is that there are sometimes great moments."
2. **Opus bills by source duration, not by `curationPref.range`.** ADR-060 §4 (Billing correction, 2026-07-27) established this operationally — Opus refuses uploads exceeding available credit. So passing a 5-hour source with a 1.5-hour range still consumes 5 hours of credit; the range only constrains candidate surfacing.

Meanwhile ADR-046 summaries already put the model to work identifying Key Moments (`M` section), Key Learnings (`L`), and Chat-Sparked highlights (`C`) with `[HH:MM:SS]` timestamps. That's a highlight-detection pipeline we already run, with cost we've already paid, whose output is currently only used to build a human-readable Doc. Feeding those timestamps back into the clip pipeline is a reuse win in three dimensions: it recovers post-show gems, cuts Opus credit spend by the exact width of the pieces we skip, and keeps clip candidate selection aligned with what the summary already deemed important.

---

## Decision

### 1. The clip source becomes a stitched multi-window mp4

Instead of pointing Opus at the raw source with `curationPref.range` (which doesn't save credits), we construct an mp4 containing exactly the regions we want Opus to consider — nothing else — and hand Opus **that** file. The regions:

- **Main-show window** (from ADR-060) — the default backbone. The largest single region and the operator's baseline expectation.
- **Summary highlight windows** — extracted from the current summary's `[HH:MM:SS]` markers, one region per marker, with a configurable radius (default: `[t − 30s, t + 90s]` so the model catches setup + payoff).

The stitcher merges overlapping / adjacent regions before ffmpeg is called, so a highlight inside the main-show window doesn't cause a duplicate cut. Regions are sorted by start-time to preserve the recording's narrative order in the stitched file — Opus's clip generation reads left-to-right and appreciates it.

Which summary sections contribute highlights is configurable per series (see §4). Default: `M` + `C` (Key Moments + Chat-Sparked). `L` (Key Learnings) is opt-in — often high-value but sometimes wraps into extended explanations that don't clip well.

### 2. Pipeline shape

1. **Preflight**: does the record have a current summary (`summary_prompt_version === currentPromptVersion`)? If not, the operator can either (a) generate the summary first (surfaced as a call-to-action in the Shorts modal), or (b) fall back to main-show-only.
2. **Region extraction**:
   - Main show: `[main_show_start_sec, main_show_end_sec]` from ADR-060 processing rules.
   - Highlights: parse each `[HH:MM:SS]` marker in the enabled summary sections; convert to seconds; expand to the configured `(radius_before, radius_after)`.
3. **Merge**: sort regions, coalesce any pair where `next.start ≤ prev.end + merge_gap` (default `merge_gap = 5s` so two highlights 3s apart become one region). Clamp to `[0, duration_seconds]`.
4. **Extract**: for each merged region, `ffmpeg -ss <start> -to <end> -c copy -avoid_negative_ts make_zero <tmp/<uuid>-<i>.mp4>`. `-c copy` avoids re-encoding when the container permits; fall back to `-c:v libx264 -preset ultrafast` when the source's GOP structure produces broken keyframes at the cut boundaries.
5. **Concat**: `ffmpeg -f concat -safe 0 -i <segments.txt> -c copy <stitched.mp4>`. Same fallback if `-c copy` fails.
6. **Publish stitched file to a place Opus can fetch**: signed GCS URL (see §3) with a 24h TTL.
7. **Submit to Opus** with `videoUrl` pointing at the stitched file. No `curationPref.range` — the stitch IS the range.
8. **Manifest sidecar**: alongside `stitched.mp4`, write `stitched.manifest.json` recording each merged region's original source offset. This lets the clip → parent → segment lookup remain honest (a clip at `stitched_t=45s` maps back to `source_t=<region_offset + 45s>`).
9. **Cleanup**: when the Opus project reaches `COMPLETE` / `STALLED`, delete the stitched file + manifest. The status route already knows the terminal state; a small post-terminal hook removes the artifacts.

### 3. Storage and access

The stitched mp4 lives at `data/opus-stitches/<record_id>-<job_id>.mp4` on the FUSE-mounted GCS bucket (ADR-035). Opus needs a public-or-signed URL. Two options:

- **Signed URL** via `gcloud storage signed-url` / GCS client — expires in 24h. Preferred: no permanent public exposure.
- **Public path on the bucket** — simpler but exposes any human who guesses the URL. Rejected as a default; can be turned on per operator preference if the bucket is behind IAM.

Signed URL wins for MVP.

### 4. Per-series configuration lives on the series registry

Extending ADR-055's `SeriesRegistryEntry`:

```
clip_source_sections?: Array<"M" | "L" | "T" | "C">   // default ["M", "C"]
clip_highlight_radius_before_sec?: number             // default 30
clip_highlight_radius_after_sec?:  number             // default 90
clip_include_main_show?: boolean                      // default true
```

All optional. Blank / omitted → defaults. Editable on `/config` → Series Registry.

### 5. UX

The Shorts modal on VideoCard grows a compact panel above the existing prompt / captions:

- Radio row: `Main show + summary highlights (default)` / `Main show only` / `Whole recording` / `Custom regions…`.
- When "Main show + summary highlights" is selected, an inline preview shows the merged region count and the total stitched duration ("4 regions · 1h 47m — you'll be billed for 1h 47m of Opus credit, not the source's 5h").
- If the record has no current summary, the "highlights" radio option is disabled with a hint: "Generate the summary first (📄 Summarise) so highlights can be picked."

### 6. Provenance

Each clip's `metadata_extra.parent_video_id` still points to the true parent (the raw record). New `metadata_extra.source_stitch_manifest_ref` records which stitched-source revision produced this clip, so provenance can be re-derived if the operator re-stitches with different sections/radius. The manifest sidecar lets a later view resolve `clip.start_seconds` inside the stitched file back to source-video absolute time — mirrors the ADR-059 chapters-in-absolute-time invariant.

---

## Consequences

**Positive**
- Recovers post-show / pre-show highlights the ADR-060 hard cut was throwing away.
- Opus credit spend scales to `stitched_duration ≤ main_show + Σ highlight_windows`, not to source duration. On a 5-hour raw capture with a 1.5-hour main show and ~10 minutes of highlights, credit spend drops from 300 → ~100 credits — 66% cheaper.
- Summary generation cost, already paid for the badge, does double duty as clip-source curation. No new LLM call.
- Opus's own clip-scoring model competes only against high-signal candidates, so virality scores (ADR-061) become more meaningful — fewer "high score for a low-signal clip because everything else was worse" false peaks.

**Negative / trade-offs**
- **Depends on a current summary**. Records without one either fall back to main-show-only or block on generating the summary first. The UX makes this explicit; the summary itself is cheap enough (~$0.02) that generating one first is not a real friction.
- **Concat re-encoding risk**: `-c copy` fails when cut boundaries don't align with keyframes. Fallback re-encodes with `libx264 ultrafast`; slower and slightly larger file. Acceptable for a pipeline that runs once per record.
- **Highlight radius is a tuning knob**. Too small → payoffs get truncated; too large → warmup phrases pollute the candidate window. Defaults (30s / 90s) are informed by Opus's typical clip length target (60–180s) plus a comfortable pre-roll for context.
- **Stitched provenance is one hop indirect** — the clip's start-time in the stitched source doesn't equal its start-time in the raw recording. The manifest sidecar handles this but any consumer that reads `clip_start_seconds` without consulting the manifest will show a bogus offset. Fix: add a helper (`resolveClipSourceOffset(clip, manifest)`) and route all UI that shows "at time X in the source" through it.
- **Cleanup dependency**: if the terminal-state hook is missed, the stitched file leaks storage. A weekly janitor job (crontab entry, or Cloud Scheduler cron) enforces a 30-day TTL on `data/opus-stitches/` as a backstop.

**Downstream effects to watch**
- **ADR-029** clip generation flow: `/api/shorts/generate` grows a `sourceMode` parameter (`stitched | main_show | whole`) and a stitched-source builder step. The existing YouTube-URL passthrough remains the fallback for `sourceMode: whole`.
- **ADR-052** summary badge backfill: unaffected. Summaries are still generated the same way; this ADR consumes them.
- **ADR-058** clip repair / discovery: the stitch manifest becomes part of the discovery reconciliation — a "clip discovered from Opus" needs the manifest to map back correctly.
- **ADR-060** §4 (Billing correction): superseded for the default path. Main-show-only remains available as a mode but is no longer the default when a current summary exists.

---

## Alternatives Considered

| Alternative | Reason Not Chosen |
|-------------|-------------------|
| Multiple Opus projects — one per region | 3–8× the per-request overhead (webhooks, credits floors, review-queue clutter). One stitched source keeps the ADR-029 review flow single-threaded. |
| Ship the raw source + `curationPref.range` list | Opus's schema accepts a single range, and even if a list existed billing scales with source duration. |
| Highlight detection via non-LLM signal (audio energy peaks) | Real work with unclear ROI when we already have an LLM summary running. Deferred. |
| Have Opus consume a URL playlist / segment list | Not supported by the API. |

---

## Out of Scope

- Automatic radius tuning per series based on Opus's own clip length distribution. Future ADR if operators find themselves editing radius often.
- Chapter-aware highlight extraction (weight highlights near chapter boundaries). Deferred.
- Multi-summary layering (e.g. combine two prompt versions' highlight picks). Not requested.
