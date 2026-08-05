# ADR-070: Light / Dark / System Theme Selector

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-05 |
| **Deciders** | Engineering, Product |
| **Supersedes** | — |
| **Related** | ADR-069 (accessibility baseline) |

---

## Context

The dashboard has always shipped dark-only. Two forces are pushing us toward a theme choice:

1. **Community contributor request.** `adam.kovacs@agentics.org` opened PR #13 (2026-08-04) with a Light / Dark / System selector, a `data-theme` attribute driver, a pre-paint sync to avoid the flash-of-wrong-theme, and a semantic-color-token pass on 27 components. His diff was ~700 LOC.

2. **Accessibility posture.** ADR-069 introduced a contrast-safe token layer but committed to dark only. Some contributors (particularly outdoor / high-ambient-light users on mobile after our narrow-viewport reflow landed) need a light option, and the browser's `prefers-color-scheme` gives us a reasonable default without any UI at all.

Rejecting PR #13 outright would leave the intent unhonored; merging it wholesale would revert (a) `page.tsx`'s ADR-057 redirect (Adam's branch predated the multi-page split) and (b) touch the many components rewritten during ADR-063 → ADR-068. Rebasing the whole diff is expensive.

---

## Decision

Ship a **minimum theme selector** as a follow-up to ADR-069, without the color-token migration across every inline-style call site.

### 1. Runtime

Three new files, ported wholesale from PR #13 (they are self-contained and have no bearing on the deferred component-inline-style migration):

- `web/src/components/theme.ts` — `ThemePreference` type (`"system" | "light" | "dark"`), `applyThemePreference()`, `readThemePreference()`, `isThemePreference()`. `localStorage["video-sync-theme"]` is the persistence key.
- `web/src/components/ThemeRuntime.tsx` — client component that mounts once in `<body>`, resolves the preference on mount (system → matchMedia), and subscribes to `matchMedia("(prefers-color-scheme: dark)")` so a `"system"` user's theme tracks OS changes live.
- `web/src/components/ThemeSelector.tsx` — a labelled `<select>` with `System / Light / Dark`. Persists to localStorage; sets `document.documentElement.dataset.theme` and `.dataset.themePreference`.

### 2. Pre-paint script

`web/src/app/layout.tsx` (root) embeds an inline `<script>` in `<head>` that:

1. Reads `localStorage["video-sync-theme"]` (or defaults to `"system"`).
2. Resolves `"system"` to `"light"` / `"dark"` via `matchMedia`.
3. Stamps `document.documentElement.dataset.theme` and `.dataset.themePreference` **before** React hydrates.

This is the standard no-flash pattern for Next.js App Router + persisted theme preferences. `ThemeRuntime` inside `<body>` picks up whatever the pre-paint script decided and installs the runtime subscriber.

### 3. CSS token layer

`web/src/app/globals.css` gets **one new block**, `:root[data-theme="light"]`, that overrides the dark palette's variables with a light equivalent:

- `--bg` `#0a0a0a → #f4f6f8`
- `--surface` `#141414 → #ffffff`
- `--text` `#f5f5f5 → #17202a`
- `--text-muted` `#a3a3a3 → #52606d` (still WCAG AA)
- `--accent` `#2563eb → #1d4ed8` (deeper blue on white)
- Semantic surfaces (`--red-surface`, `--purple-surface`, `--green`, `--yellow`, `--orange`) shift to darker variants that carry acceptable contrast against light text.
- `color-scheme: light` (mirrors the dark block's `color-scheme: dark`).

Existing rules that reference these tokens (`.status-*`, `.btn`, `.video-card`, `.stat-badge`, layout landmarks, the panel/rule styles) recolor automatically. No rule-level rewrite required for the palette swap to work at the token level.

### 4. Selector placement

`ThemeSelector` mounts in the `(app)/layout.tsx` header band between `BuildBadge` and the `View Logs` button — reachable from every authenticated page. The unauthenticated fallback (root `layout.tsx`'s `<body>`) does not render the selector; the pre-paint script still applies whichever preference was persisted, so bounced-through-IAP redirects don't visually flicker.

---

## Deferred

- **Component inline-style migration.** PR #13's 27-file color-token pass touched components across `EventLog`, `HelpTip`, `VideoCard`, `Sidebar`, `BackfillOverview`, `CatchUpPanel`, `ShortsPanel`, `SummaryLozenge`, `TranscriptLozenge`, `URLImport`, `UnifiedImport`, `KalturaImport`, `YouTubeLiveImport`, `ConnectionsPanel`, `SummaryPromptPanel`, `ImportPanel`, `BackfillPanel`, `BackfillCalendar`, `ProvenanceGraph`, `youtube-callback/page.tsx`, and `lib/backfill.ts`. Most of these swaps replace hard-coded rgba(...) with `var(--*-soft)` / `var(--*-border)` tokens that don't exist in the baseline palette. Deferred: track down the components that look wrong in Light and migrate their inline styles one at a time — Light will look "mostly right" but not "polished right" until this lands.
- **Callback page redesign.** PR #13 restyles `web/src/app/youtube-callback/page.tsx` with a card layout and semantic tokens; kept as-is for now (the page shows for < 1 second during OAuth handoff — low blast radius).
- **Test file `web/tests/themeSelector.test.tsx`.** Ported to the baseline branch alongside the component. Also tracks: pre-paint script coverage (`web/tests/youtubeCallback.test.tsx` from PR #13 is deferred with the callback redesign).

---

## Consequences

### Positive

- Users get a theme choice without waiting for the full color-token migration.
- Dark stays exactly as ADR-069 shipped it.
- Pre-paint script avoids a flash-of-wrong-theme on cold load or hard refresh.
- Adam's contribution — theme.ts / ThemeRuntime / ThemeSelector — is preserved via `Co-Authored-By`.

### Negative

- **Light theme will have visual rough spots** until the inline-style migration completes. Anywhere a component hard-codes `rgba(...)` or a hex value in an inline `style={{}}` prop, Light users will see a dark patch. Explicit call-outs from a quick audit: the "not authenticated" banner uses `rgba(248,113,113,0.1)` + `#f87171`; ProvenanceGraph edges use hard-coded stroke colors; ShortsPanel has hard-coded chart colors. These stay dark-mode-appropriate in Light and will need touch-ups.
- Adds an inline `<script>` to the root document. This is unavoidable for no-flash theming under Next.js App Router (the alternatives are FOUC or SSR-computed themes tied to session, neither of which is worth the complexity).
- `--text-muted` in Light (`#52606d`) crosses the AA threshold at typical operator UI sizes but not by much. Any future audit should re-check.

### Neutral

- Theme choice is per-browser (localStorage), not per-user. If we later add server-side user preferences we can migrate the persistence key with a one-time client-side upgrade.

---

## Follow-ups

1. Inline-style migration — one PR per surface area (`VideoCard`, `BackfillOverview`, etc.), rebasing Adam's semantic-token swap against today's file.
2. Callback page redesign — port PR #13's `youtube-callback/page.tsx` changes if we decide the card layout is an upgrade.
3. Test coverage — add a test that the pre-paint script resolves `"system"` correctly on cold boot (jsdom `matchMedia` mock).
4. Consider `prefers-color-scheme: light/dark` media queries inside components that CAN'T easily use CSS variables (SVG stroke colors in `ProvenanceGraph`, canvas fills in analytics charts).

---

## Attribution

Theme selector authored by Adam Kovacs (`adam.kovacs@agentics.org`) via PR #13 (2026-08-04). Rebase, palette-only integration, and deferred-scope split by the video-sync team.
