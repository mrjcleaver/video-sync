# Accessibility and readability audit

Audit date: 2026-08-04

Target: WCAG 2.2 Level AA, Lighthouse accessibility, keyboard access, responsive readability

Routes: `/`, `/youtube-callback`

## Outcome

The first remediation pass fixes the shared accessibility foundation and raises the locally reachable main page Lighthouse accessibility score from 96 to 100. It addresses the original automated contrast failures and additional populated-card contrast failures, adds page landmarks and a skip link, restores visible keyboard focus, makes non-native controls keyboard operable, exposes disclosure state, labels key filters and date inputs, announces status changes, and improves narrow-screen reflow.

The project goal also includes readable responsive layouts and clear information hierarchy. Spacing, padding, typography, grouping, and action clarity should improve without changing product behavior. This pass establishes shared layout behavior; deeper component-level work is split across focused import, configuration, video-action, and theme PRs.

This is not a claim of complete WCAG conformance. Lighthouse covers only a subset of accessibility requirements. The review used representative local records for populated calendar, queue, video-card, transcript, participant, and provenance states, but it did not contain connected production data. Credential-dependent integrations and destructive workflows still require validation in an authorized environment. The remaining work is grouped into four focused follow-up PRs below.

## Method and scope

The audit combined:

- Source review of both routes and every component reachable from the main dashboard.
- Keyboard and accessibility-tree checks in Chromium.
- Visual checks at 1280 by 900, 1024 by 768, 800 by 768, and 375 by 812 pixels.
- Lighthouse accessibility runs against the populated local main page and a stable YouTube callback error state.
- Manual comparison with the [WCAG 2.2 quick reference](https://www.w3.org/WAI/WCAG22/quickref/?versions=2.2&levels=aaa).

Production at `video-sync.agentics.org` redirects to Google Identity-Aware Proxy. No production credentials were supplied, so the live site and live third-party data could not be inspected. Local checks used the repository's development-only `ALLOW_NO_IAP=1` path.

## Route and feature inventory

| Area | Features reviewed | PR 1 result | Follow-up |
| --- | --- | --- | --- |
| Main shell | Header, skip navigation, primary actions, auth state, search, view and filter controls, empty state | Shared landmarks, focus, labels, state, contrast, and reflow improved | Light, Dark, and System theme support in PR 5 |
| Import | Meetings, Zoom, Fireflies, Kaltura, YouTube Live, URL import, manual import, shared date range | Import mode and date inputs now expose names and state | Complete form-label and error review in PR 2 |
| Connections | Per-user and shared credentials, YouTube authorization | Section is named and reachable | Inline validation, confirmation, and credential field review in PR 3 |
| Sync status | Overview, calendar, profile filter, month expansion, status filters | Filter label, pressed state, calendar semantics, keyboard operation, and populated local state checked | Repeat with production-backed data in PR 2 |
| Backfill | Profiles, queue, start and stop, refresh, expandable queue entries | Mode state, button names, queue semantics, and keyboard operation added | Form labels and live job feedback in PR 3 |
| Rules | Ingestion, processing, and post-processing rules | Panel disclosures and enable controls now expose state and keyboard behavior | Every field, condition, error, and destructive action in PR 3 |
| Video cards | Source and destination metadata, participants, transcript, summary, provenance, publish and link actions | Participant, copy, transcript, and provenance interactions use native controls; populated metadata contrast and action reflow corrected | Full action, form, and error audit in PR 4 |
| Utilities | Shorts, summary prompt, catch up, event log | Named panels, disclosure state, focus entry and Escape close behavior, status announcements | Theme-safe status and overlay colors in PR 5 |
| YouTube callback | Pending, success, and failure states | Semantic main heading and announced status | Validate a real OAuth round trip in PR 2 |

## PR 1 findings addressed

| Finding | Change | Relevant WCAG 2.2 criterion |
| --- | --- | --- |
| No bypass mechanism or main landmark | Added a visible-on-focus skip link and semantic page regions | 2.4.1 Bypass Blocks |
| Global styles removed visible focus | Added a consistent high-contrast `:focus-visible` treatment | [2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html), [2.4.11 Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) |
| Red and purple status text failed automated contrast | Separated foreground and surface tokens and raised text contrast | [1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) |
| Several clickable `div` and `span` elements were mouse-only | Replaced them with buttons or supplied keyboard semantics where table and grid structure required it | 2.1.1 Keyboard, 4.1.2 Name, Role, Value |
| Drawers and expandable panels did not expose state | Added names, `aria-expanded`, controlled-region relationships, focus entry, Escape close, and focus restoration | 2.4.3 Focus Order, 4.1.2 Name, Role, Value |
| Search, date, and profile filters relied on surrounding context | Added explicit programmatic labels and grouped related controls | 1.3.1 Info and Relationships, 3.3.2 Labels or Instructions |
| Loading, filtering, callback, and error changes were silent | Added appropriate status and alert regions | 4.1.3 Status Messages |
| Header and form rows overflowed or compressed on narrow screens | Added responsive wrapping, single-column cards, and narrow-screen control sizing | 1.4.10 Reflow |
| Populated header and video-card actions overflowed at intermediate widths | Kept header utilities intact across rows and allowed dense action groups to wrap | 1.4.10 Reflow |
| Mobile drawers lost their intended left gutter when a vertical scrollbar was present | Sized drawers against their containing block instead of the layout viewport | 1.4.10 Reflow, 2.4.11 Focus Not Obscured (Minimum) |
| The mobile date range could leave the `To` label separated from its input | Kept each visible date label and input together as a wrapping pair | 1.3.1 Info and Relationships, 1.4.10 Reflow |
| Populated source links, location labels, and summary lozenges failed minimum contrast | Added a text-safe accent and removed opacity-based status dimming | 1.4.3 Contrast (Minimum) |
| Small shared buttons made touch use difficult | Increased common button heights and preserved adequate spacing | [2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) |
| Motion did not honor system preference | Disabled nonessential transitions and animations for reduced-motion users | Accessibility improvement beyond the Level AA acceptance set |

## Automated and manual evidence

| Check | Before | After |
| --- | --- | --- |
| Lighthouse accessibility, local `/` | 96 | 100 |
| Lighthouse accessibility, populated local `/` | 96 after representative records exposed three failing selector groups | 100 |
| Lighthouse accessibility, local `/youtube-callback` error state | Not recorded | 100 |
| Automated contrast failures | Original failures plus three populated-state selector groups | 0 known nodes in the audited states |
| Desktop viewport | Baseline source reviewed | 1280 by 900, 1024 by 768, and 800 by 768 visual passes |
| Mobile viewport | Baseline source reviewed | 375 by 812 visual and reflow pass across dashboard, drawers, populated data, Connections, and callback |
| Keyboard operation | Mouse-only custom controls found | Shared disclosures, calendar cells, expandable rows, transcript action, copy action, and provenance nodes operable |

Lighthouse uses weighted audits to calculate its accessibility score. A perfect automated score does not mean that a page is fully accessible, and manual checks remain necessary. See [Lighthouse accessibility scoring](https://developer.chrome.com/docs/lighthouse/accessibility/scoring).

## Follow-up PR series

Priority: high. Validate with seeded representative records and configured test integrations.

- PR 2 covers Meetings, URL, Manual, and dormant import-source forms.
- PR 3 covers Connections, backfill profiles, ingestion and processing rules, post-processing rules, Sync Status, and destructive confirmations.
- PR 4 covers video-card location, provenance, note, recovery, publish, status, and delete workflows.
- PR 5 adds persisted Light, Dark, and System themes using semantic color tokens and repeats contrast and reflow checks in both color schemes.

- Give every field in import, connection, backfill, rules, provenance, publish, and link workflows a persistent programmatic label and associated help or error text.
- Replace browser `alert` and `confirm` calls with accessible inline or dialog feedback, including focus placement and recovery after errors.
- Announce asynchronous saves, imports, authorization changes, publish progress, and failures without moving focus unexpectedly.
- Verify selected, busy, disabled, invalid, and expanded state for every action with a screen reader.
- Run complete keyboard-only flows for creating and editing rules, importing each source, linking provenance, publishing, deleting, and OAuth callback handling.
- Repeat populated overview, calendar, queue, video-card, and provenance checks against connected API data and real integration failures.

## Ongoing readability backlog

Priority: medium unless user research identifies a workflow blocker.

- Raise pervasive 0.6 to 0.75 rem metadata where density does not require it, then verify browser zoom at 200 and 400 percent.
- Consolidate repeated inline styles into a small set of tokens and components for headings, metadata, status, action groups, and form rows.
- Reduce dependence on title-only explanations, emoji, color-only dots, and inconsistent compact icons.
- Improve hierarchy in long video cards and rule editors so labels, values, status, and primary actions remain scannable.
- Review meaningful thumbnails and artwork for useful alternative text while keeping decorative images silent.
- Recheck all interactive targets against the 24 by 24 CSS pixel minimum or its spacing exception.

## Known limits and unrelated baseline failures

- Production and third-party integrations were not tested because Google IAP and platform credentials were unavailable.
- Representative local records exercised common populated branches, but real integration responses, failure modes, and destructive confirmations remain unavailable without authorized test credentials.
- The repository test baseline initially failed because the generated `web/pkg/video_sync` WASM package was absent. Generating it allows the tests to resolve the module.
- The production TypeScript build remains blocked by a pre-existing duplicate `downloadYouTubeToFile` implementation in `web/src/app/api/youtube/upload/route.ts`. This audit does not change that route.

## Acceptance criteria for the follow-up series

- Every user-facing route and reachable state has a recorded keyboard and screen-reader result.
- No known critical keyboard, focus, accessible-name, contrast, or status-message defect remains.
- Representative local states retain a Lighthouse accessibility score of 100.
- Browser zoom, narrow-screen reflow, reduced motion, and error recovery are manually verified.
- Credential-dependent gaps are either tested in an authorized environment or remain clearly recorded as limitations.
