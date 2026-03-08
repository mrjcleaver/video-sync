# ADR-020: Import UX Enhancements — Preview Title Display and Destination Visibility

Date: 2026-03-06
Status: Accepted

## Context

Two UX gaps were identified after the ADR-014 processing rules and ADR-019 provenance graph shipped:

1. **Preview title vs source title in VideoCard**: The processing rules engine (ADR-014) transforms video titles at publish time via templates (e.g. `AI Hackerspace Live — 6 Mar 2026`). The VideoCard showed only the raw source title, so users had no constant visual feedback of what the title would be after publishing. The only way to see it was to open the "Preview" modal.

2. **No destination visibility in the import list**: The UnifiedImport panel (ADR-015/019) listed sessions from Zoom and Fireflies but gave no indication whether a recording had already been published to YouTube. Users had to mentally cross-reference the video list to avoid redundant imports or duplicate uploads.

## Decision

### 1. VideoCard: processed title as primary heading

`VideoCard` computes `applyProcessingRules(loadProcessingRules(), video).title` via `useMemo` at render time (synchronous — LLM mode falls back to the source title per ADR-014 design). If the processed title differs from the raw source title, the processed title is shown as the `<h3>` heading and the original source title is rendered in smaller italic text below it. When no rules are configured, or no rule changes the title, only the original title is shown (no visual change from before).

### 2. UnifiedImport: YouTube destination badge

`UnifiedImport` builds a `Map<source_id, VideoRecordJSON>` from the local catalog (`videoStore.getAll()`) inside a `useMemo` keyed on the fetched sessions list. For each session row, it checks whether the Zoom or Fireflies source ID resolves to a stored record that has a `Destination` location on YouTube. A red `▶ YouTube` link (or label) is shown inline in the metadata line. The link opens the published video in a new tab.

Only YouTube is checked for now; Kaltura and other platforms can be added in future iterations by extending `getYouTubeDestination` into a general `getDestinations` helper.

## Consequences

- **Performance**: `loadProcessingRules()` reads from `localStorage` on every VideoCard render. For typical catalog sizes (< 200 records) this is imperceptible. A future optimisation could hoist the rules read to the parent Dashboard as a stable prop.
- **Staleness**: The destination map in `UnifiedImport` reflects the **local** store at fetch time. A recording published in another browser session or device will not show the badge until the catalog is reloaded. This is consistent with the existing local-first architecture (ADR-004).
- **LLM titles**: When a processing rule uses `transcript_llm` mode, `applyProcessingRules` returns the source title as the preview (async LLM result is not available at render time). This matches the existing behaviour in the Preview modal and is noted in ADR-014.
