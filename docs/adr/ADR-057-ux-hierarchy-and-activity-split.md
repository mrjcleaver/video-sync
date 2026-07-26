# ADR-057: UX hierarchy and activity-based navigation split

**Status**: Proposed (exploration)
**Date**: 2026-07-26
**Deciders**: Architecture Team

---

## Context

The dashboard has grown into a single very long scroll. As of ADR-056 the main page (`web/src/app/page.tsx`) mounts, in vertical order:

1. `ConnectionsPanel` — shared + per-operator credentials
2. `SummaryPromptPanel` — ADR-046 prompt config
3. `CatchUpPanel` — side drawer with 4 maintenance cards (ADR-047 catch-up + broadcast-pair migration + YouTube row backfill + summary badge backfill + title alignment)
4. `ImportPanel` — Zoom / Fireflies / Loom / Kaltura / YouTube-Live / URL sub-panels
5. `SyncStatusPanel` — Overview + Calendar tabs
6. `BackfillPanel` — retrospective backfill orchestrator
7. `RulesPanel` — ingestion rules
8. `ProcessingRulesPanel` — publish-time transforms
9. `PostProcessingRulesPanel` — post-publish webhooks / email
10. `ShortsPanel` — Opus-Clip-derived clips
11. `VideoCard` grid — the catalog (the actual content)
12. `ProvenanceGraph` — toggle view of item 11
13. `EventLog` — global session log

That's ~12 major sections plus the drawer. Operators report the UX feels crowded, and a single page can't answer "what am I working on right now?" without them scrolling / scanning. The catch-up drawer has four cards inside itself, headed toward five as ADR-057-siblings ship.

The activities operators actually undertake, grouped by cadence and mental mode:

| Activity | Frequency | Panels used today |
|---|---|---|
| **Setup / configure** | Once per operator / per new connection | ConnectionsPanel, RulesPanel (all 3), SummaryPromptPanel, series-registry |
| **Bring content in** | Weekly / after a meeting | ImportPanel, BackfillPanel |
| **Review + curate** | Daily | VideoCard grid, ProvenanceGraph, per-card event log |
| **Publish** | Per approved record | Actions on VideoCard |
| **Maintain the catalog** | Ad-hoc, event-driven | CatchUpPanel drawer (4 cards, growing) |
| **Monitor progress** | Passive / background | SyncStatusPanel, EventLog global |
| **Distribute clips** | Post-publish, per video | ShortsPanel |

Only Review + Curate is the daily-driver activity. The others are episodic. Yet every one of them shares vertical screen real estate with Review, competing for the operator's attention.

## Alternatives

Five architecturally distinct directions, each with a rough sketch. None are decided; the point of this ADR is to lay out the trade space.

### Option A — Left-nav sidebar (classic SaaS shape)

A persistent left rail. Each nav item corresponds to one activity from the table above; the main content area swaps.

```
┌─────────────────────────────────────────────────────────────────┐
│ Video Bridge                                       operator@…   │
├──────────────┬──────────────────────────────────────────────────┤
│ • Catalog    │                                                  │
│   Overview   │   [main content: VideoCard grid]                 │
│   Calendar   │                                                  │
│ • Import     │                                                  │
│ • Publish Q. │                                                  │
│ • Maintain   │                                                  │
│ • Shorts     │                                                  │
│ • Rules      │                                                  │
│ • Config     │                                                  │
└──────────────┴──────────────────────────────────────────────────┘
```

**Pros**
- Familiar SaaS pattern — operators map it to Stripe / Linear / Notion instantly.
- URL routing (`/catalog`, `/import`, `/maintain`, `/config`) enables deep-linking, browser back, and bookmarks.
- Every activity gets its own "canvas" — no vertical competition.
- Adding a new activity later means adding one nav row, not one more full-width panel.

**Cons**
- Requires adopting Next.js App Router routing across pages that today mount side-by-side. Non-trivial one-shot refactor — every hook that assumes shared page state (`videos`, `broadcastPairs`, `actorState`) needs to move to a shared layout or a context.
- Some workflows cross activities (import → immediately review the freshly-imported records). Cross-page navigation with preserved scroll/filters is UX work.
- Mobile: sidebar needs to collapse to a hamburger — small increment but new state.

### Option B — Top tabs with sub-navigation

A tab bar under the header. Fewer top-level buckets than A; sub-navigation inside each bucket where needed.

```
┌─────────────────────────────────────────────────────────────────┐
│ Video Bridge                                       operator@…   │
├─────────────────────────────────────────────────────────────────┤
│ Catalog │ Import │ Maintain │ Shorts │ Config                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [main content: current tab]                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

- **Catalog**: VideoCard grid + Overview/Calendar toggle + ProvenanceGraph toggle (existing UX preserved)
- **Import**: ImportPanel + BackfillPanel
- **Maintain**: what's in the Catch-Up drawer today, promoted to first-class page with cards laid out horizontally
- **Shorts**: ShortsPanel + (future) Opus API extensions
- **Config**: Connections, Rules (all 3), SummaryPromptPanel, Series Registry

**Pros**
- Shallower routing than A (single-level nav; no need for a full layout refactor if we keep it client-side-only with query-string state).
- Retains "one page" feel — cheaper to build first pass.
- Groups related things together (all three rule types under Config, not scattered).

**Cons**
- Top tabs don't scale past ~5–7 items; if we add a "Distribute" activity later we'd need a sub-tab or drop something.
- Sub-nav inside a tab is less discoverable than a left rail's tree.
- No URL routing without extra plumbing → refresh-loses-tab problem unless we back it with `localStorage`.

### Option C — Hub-and-spoke landing

A "home" dashboard that shows the operator status at a glance with count-driven cards linking to activity pages.

```
┌─────────────────────────────────────────────────────────────────┐
│ Video Bridge — Home                                             │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │
│  │ 12 to review  │  │ 3 imports rdy │  │ 42 stale sum. │        │
│  │ →  Review     │  │ →  Import     │  │ →  Maintain   │        │
│  └───────────────┘  └───────────────┘  └───────────────┘        │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │
│  │ 5 clips ready │  │ Provenance    │  │ Rules & Auth  │        │
│  │ →  Shorts     │  │ →  Explore    │  │ →  Config     │        │
│  └───────────────┘  └───────────────┘  └───────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

Click a card → dedicated activity page (same content as Option A/B).

**Pros**
- Answers "what should I be doing right now?" — the counts drive attention.
- Each activity page can be maximalist without competing with other activities.
- Great onboarding surface — new operators see the app's scope in one view.

**Cons**
- Requires an extra click for the returning daily-driver operator. They arrive at Home, then click Review — one interstitial that non-daily activities do NOT justify.
- Count computation across activities may be expensive; needs cheap-to-compute proxies for each.
- Empty-state design matters more (a 0-count card should read as "all clear", not "nothing to click").

### Option D — Progressive disclosure (least invasive)

Keep everything on one page but collapse every panel behind a header by default. Only the VideoCard grid + EventLog stay always-visible. Operators expand what they need.

```
┌─────────────────────────────────────────────────────────────────┐
│ ▶ Connections   ▶ Rules   ▶ Import   ▶ Backfill   ▶ Shorts      │
├─────────────────────────────────────────────────────────────────┤
│  [VideoCard grid — always visible]                              │
├─────────────────────────────────────────────────────────────────┤
│  [EventLog — always visible]                                    │
└─────────────────────────────────────────────────────────────────┘
```

**Pros**
- Ship in hours, not days — zero routing.
- Preserves the current architecture entirely.
- Operator's persisted `localStorage` remembers which panels they open frequently.

**Cons**
- Doesn't solve "which activity am I doing?" — just hides the surface. Screen depth is unchanged; scroll is only reduced.
- All the state hooks + prop drilling stay; adding another panel later is still a page-level edit.
- Discoverability suffers — a new operator doesn't know what "▶ Maintain" contains until they click.

### Option E — Activity-mode header switcher

Header carries a mode selector: **I want to… [Import / Review / Publish / Maintain / Configure]**. Selecting a mode swaps the panels below.

```
┌─────────────────────────────────────────────────────────────────┐
│ Video Bridge   [ Review ▾ ]                        operator@…   │
├─────────────────────────────────────────────────────────────────┤
│  [main content: only Review-relevant panels]                    │
└─────────────────────────────────────────────────────────────────┘
```

**Pros**
- Explicitly names the operator's intent — different from Option A/B where the operator has to translate "I want to X" into "which nav item?"
- No new routing surface — single dropdown backs it.

**Cons**
- Novel pattern — operators have to learn "modes" as a concept.
- Mode-switching is heavier than tab-switching (no visual context of other activities). A caller who says "I approved one; now I want to see what to publish" has to context-switch modes rather than glance at the neighbouring tab.

## Considerations to weigh across options

Independent of which option wins, several design forces show up on all of them:

1. **URL routing.** Deep-linking (paste-a-link-to-record `foo`, resume-where-I-left-off) becomes materially easier with Option A. Option B / C need URL discipline to preserve. Option D forfeits it.
2. **Cross-activity flow.** After importing 3 records the operator's next move is usually reviewing them. Whichever option we pick needs "just imported → jump to review, filtered to these" as a first-class flow.
3. **Session state.** `videos`, `broadcastPairs`, `actorState`, EventLog buffer all currently live in one component and cascade down. Moving to multi-page routes means either a shared layout with a store context, or a switch to a global state library. Not a huge lift but a real architectural change.
4. **Mobile / narrow-window.** Two operators are known to use the app on iPad in landscape (~1024px width). Every option must degrade gracefully — Option A benefits most since sidebars collapse cleanly; Option B's tab bar can wrap.
5. **Keyboard nav.** Currently minimal. Option A's sidebar is natural for tab-to-nav; Options B/C need explicit accelerator keys.
6. **The catch-up drawer.** All four (soon five, six, ...) maintenance cards live in a side drawer today. If Maintain becomes a first-class page (Options A/B/C), the drawer disappears — cards become the page's grid. This is a UX win but requires re-thinking their layout at page-scale.
7. **Feature-flag / progressive rollout.** Any of A/B/C can ship behind a flag with the legacy single-page as fallback. Option D is a strict subset — no rollback needed.

## Recommendation direction (not a decision)

Author-lean: **Option A (left-nav sidebar) as the target end state, arrived at via Option D (progressive disclosure) as the immediate shipping step.**

Rationale:
- Option D unblocks the reported crowding pain now (~half a day of work) without prejudicing the architecture.
- Option A is where operators intuitively expect a growing SaaS to land. The counts-in-nav-badges idea from Option C can grafts onto A's sidebar naturally (small numbers next to nav items).
- Options B and E remain viable if the group prefers less initial refactor; the ADR keeps them open.

If the group agrees on the destination, the migration is one activity at a time — cheapest first (Config → left-rail item under a `/config` route, moving Connections / Rules / SummaryPromptPanel with minimal props change), then Maintain (the catch-up-drawer content), then Import, then finally Catalog itself (biggest state graph).

## What this ADR is NOT deciding

- Exact URL scheme.
- Which state library (context / zustand / redux-toolkit / …).
- Whether to keep the current visual style — this is purely IA, not colour / typography.
- The full nav tree — enumerated candidates are illustrative, subject to the actual chosen shape.

## Open Questions

1. **Which option does the group prefer?** Answer before implementation begins.
2. **URL scheme.** If we go with Option A/B/C with routing: activities as top-level (`/catalog`, `/import`) or grouped (`/work/catalog`, `/work/import`, `/admin/config`)?
3. **How much of the current props-drilled state should move to a global store**, and does that require a library or does React context suffice?
4. **Mobile / touch UX** — do any of these options change assumptions about interaction patterns?
5. **Cross-activity return flows.** Where should the "just imported N records" toast land the operator? Same page? Auto-jump to Review filtered?

## References

- `web/src/app/page.tsx` — the current all-in-one page mounting every panel.
- ADR-047 (automated catch-up) — the source of the drawer + its maintenance cards.
- ADR-052 / ADR-055 / ADR-056 — recent additions that each grew the Catch-Up drawer or added new UI real estate.
- `docs/user-flows.md` — existing operator workflows to preserve across any re-architecture.
- `docs/user-guide.md` §11 (Dashboard Filters and Sorting) + §12 (Catch-Up Maintenance) — surface areas most affected.
