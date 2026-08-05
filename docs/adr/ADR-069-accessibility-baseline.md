# ADR-069: Accessibility Baseline

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-05 |
| **Deciders** | Engineering, Contributors (community) |
| **Supersedes** | — |
| **Related** | ADR-057 (root-shell layout), ADR-065 (contributor role) |

---

## Context

A community contributor (Adam Kovacs, `agent@agentics.org`, member of `video-sync-contributors@`) ran an accessibility audit against the deployed dashboard and opened five pull requests on 2026-08-04:

- **#9** — Broad UI accessibility and responsive-width readability
- **#10** — Import-form labels + validation feedback
- **#11** — Video-card action labels, focus, inline delete confirmation
- **#12** — Configuration / rule form accessibility + a new `ConfirmDialog` component
- **#13** — Light / Dark / System theme selector

All five branches predate the last three weeks of heavy iteration on `VideoCard.tsx`, `URLImport.tsx`, `SummaryPromptPanel.tsx`, `ImportPanel.tsx`, `page.tsx` (root → `redirect("/overview")` under ADR-057), and the shared `(app)/layout.tsx` shell. Merging them wholesale would revert genuine product features (Meetings-tab date range + fetch-all + URL-param prefill; VideoCard's description-regen dropdown; Zoom-share URL support in URLImport; Show Notes prompt move to Config). Rebasing each PR onto current `main` would be substantially more expensive than porting the safe, non-conflicting subset by hand.

We also have no ADR yet on accessibility posture in general. The dashboard has been dark-only, has no visible focus rings on many elements, has no skip-link, uses `window.confirm` for destructive actions, exposes tab switching only via mouse click, and lets its `--text-muted` colour fail WCAG AA against `--bg`.

---

## Decision

Consolidate the safe, non-conflicting subset of PRs #9, #10, and #12 into a single "accessibility baseline" branch, credited to Adam via `Co-Authored-By` on each cherry-pick commit. Close #9, #10, #11, #12 with a courteous pointer at the consolidated PR. Leave #13 (theme selector) open pending a product decision — it is a feature, not an a11y remediation.

### 1. Global CSS baseline (from #9)

`web/src/app/globals.css` gains:

- Declared `color-scheme: dark` so form controls and scrollbars render coherent with the palette.
- Named `--focus: #93c5fd` token + universal `:focus-visible` outline (`3px` solid, `3px` offset) via a `:where(a, button, input, select, textarea, [role="button"], [tabindex])` selector so every keyboard-navigable element gets a visible ring without per-component work.
- Contrast-safe palette shifts: `--text` `#e5e5e5 → #f5f5f5`, `--text-muted` `#888 → #a3a3a3` (crosses WCAG AA at the app's typical 12-14 px muted-text size), `--border` `#2a2a2a → #525252`. New `--accent-text` (`#60a5fa`) for text-on-surface uses; `--red-surface` / `--purple-surface` for status badges (WCAG contrast on white/black caption text).
- `.visually-hidden` utility for screen-reader-only labels.
- `.skip-link` — fixed top-left, hidden until focused, jumps to `#main-content`.
- `min-height: 36px` on `.btn` and `.filter-tab`, `min-height: 24px` on the new `.meta-button` — 44×44 CSS px is the mobile-safe target; 36 px is our compromise for a data-dense operator UI.
- `@media (max-width: 768px)` and `@media (max-width: 480px)` blocks reflowing header stats, video-card actions, form grids, and filter tabs for narrow viewports (previously desktop-only).
- `@media (prefers-reduced-motion: reduce)` disables `scroll-behavior: smooth` and clamps all animation / transition durations to `0.01ms`.

### 2. Semantic shell landmarks

`web/src/app/(app)/layout.tsx`:

- Emits a `Skip to main content` link as the first focusable element.
- The `<main>` gains `id="main-content"` and `tabIndex={-1}` so the skip link lands on it and screen-reader focus follows.
- The "not authenticated" notice becomes `role="alert"` — previously silent to assistive tech.

`web/src/app/(app)/Sidebar.tsx`:

- Nav links wrap in `<nav aria-label="Primary">` using `display: contents` so no visual change. The `<aside>` already exists; this adds the missing landmark distinction between the primary nav and the role-preview control that lives inside the sidebar.

### 3. Import-form accessibility (subset of #10)

`web/src/components/URLImport.tsx`:

- Visually-hidden `<label>` associated with the URL textarea; `aria-describedby` pointing at a visible help hint; `aria-invalid` toggles with `globalError`.
- `type="button"` on the fetch button; error surfaces (global and per-item) become `role="alert"`.
- **Zoom-share detection (shipped in `8b46826`) is preserved unchanged.**

`web/src/components/ImportPanel.tsx`:

- Tab-bar wrapper becomes `role="group" aria-label="Import method"`.
- Each tab button gains `type="button"`, `id="import-tab-<id>"`, `aria-pressed`.
- `onTabKeyDown` handles ArrowLeft / ArrowRight / Home / End and moves DOM focus to the newly-active tab.

The rest of PR #10 (`ZoomImport`, `FirefliesImport`, `KalturaImport`, `YouTubeImport`, `YouTubeLiveImport`, `UnifiedImport`, `IndexForm`) is deferred — Adam's branch drops Meetings-tab features (shared date range, Fetch-all-sources button, `?from=&to=` URL-param prefill) that landed after his fork point. Follow-up work per §5 below.

### 4. Accessible confirm modal (from #12)

`web/src/components/ConfirmDialog.tsx` lands as a standalone component: focus-trapped and Escape-handled via the native `<dialog>` element, backdrop-click cancels when not busy, `aria-labelledby` + `aria-describedby` + `aria-busy`, first-focus lands on the safe (Cancel) button.

Callers are **not** converted in this ADR. Every `window.confirm(...)` site — Delete Record, Reset Local State, Discard Draft, Clear Backups — remains as-is. Introducing the component is the baseline; wiring it up on each destructive path is scoped as follow-up so each conversion can be reviewed on its own terms (some sites need a two-input confirmation, some need a "don't ask again" preference, some are fine as-is).

---

## Deferred

- **PR #11** (VideoCard action feedback + inline delete confirmation). Adam's diff is `+317/-138` against a VideoCard that has since been rewritten to add description regen, YT-transcript fetch, contributor chip, publish preview, and push-title-and-description. Manual re-application on today's VideoCard is cheaper than merge conflict resolution. Follow-up.
- **PR #13** (Light/Dark/System theme selector). This is a **product change**, not an a11y remediation — the site is intentionally dark-only today. If we add a theme selector, it also needs a decision about which brand mark shows on Light. Left open pending product review.
- **Rest of PR #10** — see §3.
- **Rest of PR #12** — the configuration/rule form label passes are welcome but touch panels (`SummaryPromptPanel`, `RulesPanel`, `ProcessingRulesPanel`, `PostProcessingRulesPanel`, `BackfillPanel`, `ConnectionsPanel`, `SyncStatusPanel`) that have moved substantially since Adam's fork. Hand-porting per panel is the plan.

---

## Consequences

### Positive

- Keyboard-only users get a visible focus indicator everywhere, plus a working skip-link.
- Screen-reader users get the shell's landmark distinctions (`<nav>` inside `<aside>` was previously ambiguous).
- The `role="alert"` on the not-authenticated banner and on import errors surfaces the failure without the user needing to see the red text.
- Mobile / narrow-viewport users get a usable header, action-row, and filter-tabs. The dashboard was previously desktop-only in practice.
- The `--text-muted` contrast bump is a passive fix for the "wait, what did that say?" muted-timestamp text that has been mentioned in stand-ups.
- `ConfirmDialog` is in the toolbox for future destructive-action work without introducing a UI library dependency.

### Negative

- Palette shift is user-visible — the dashboard is slightly brighter and the borders are slightly lighter. Not a regression, but a change.
- The reduced-motion override is universal (`*` selector); if we later add a genuinely-useful animated affordance we may need to opt it back in.
- We are declaring an a11y baseline without a lighthouse-score gate in CI. Adam's PRs added test files that assert some of these invariants (skip-link presence, focus-visible outlines, disclosure ARIA). We are **not** taking those tests wholesale in this ADR — they target Adam's page.tsx structure — but should write our own equivalents.

### Neutral

- Adam's commits are preserved as `Co-Authored-By` credit so contribution history and audit trail stay intact.
- Closing #9, #10, #11, #12 does not close the door on Adam's other suggestions; the deferred items list is public in this ADR and the PR close notes point back here.

---

## Follow-ups

1. **A11y regression tests** — write our own vitest coverage for: skip-link presence + focus-move on click; `role="alert"` on the auth-error banner; keyboard tab-cycling on ImportPanel. Land alongside a follow-up PR.
2. **Convert `window.confirm` call-sites to `ConfirmDialog`** — one PR per conversion, so each can carry its own copy + focus-return decision.
3. **Rebased subset of PR #10** — hand-port the label/error/aria pattern from Adam's ZoomImport / FirefliesImport / KalturaImport / YouTubeImport / YouTubeLiveImport / UnifiedImport / IndexForm onto their current versions.
4. **VideoCard a11y** — separate follow-up applying the intent of PR #11 to today's VideoCard. Includes: label all inline forms, `aria-describedby` on the note/location/publish sub-forms, inline delete confirmation via `ConfirmDialog`, live-region announce on push-to-YouTube success/error.
5. **Product decision on theme selector (PR #13)** — either accept and wire into user preferences, or close with a note. Independent of a11y.
6. **Lighthouse gate** — once #1 lands, wire a Lighthouse a11y score threshold into the deploy job (aim ≥ 95).

---

## Attribution

Baseline authored by Adam Kovacs (`adam.kovacs@agentics.org`) via PRs #9, #10, #12 (2026-08-04). Consolidation, rebase, and deferred-scope split by the video-sync team.
