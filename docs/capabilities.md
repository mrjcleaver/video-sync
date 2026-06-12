# Video Bridge — Capabilities Matrix

A capability-by-capability rundown of what Video Bridge (this tool, also called video-sync) can do. Designed for side-by-side comparison with similar tools. Each row links to the ADR(s) that establish or implement the capability.

**Status legend**:
- ✅ **Shipped** — implemented and live in the current revision
- 🟡 **Proposed** — has an accepted-design ADR, implementation underway or not yet started
- ⚪ **Not in scope** — explicitly out of scope today (often deferred to a future ADR)

**Format**: tables grouped by capability axis. Each capability has a short description; "How" links to the implementing file or ADR. The column on the right is intentionally blank for the comparison target — fill it in when comparing against another tool.

---

## 1. Source ingestion (where videos come from)

| Capability | Status | How | Other tool |
|---|---|---|---|
| Import from **Zoom** (Server-to-Server OAuth, transcript captured) | ✅ | ADR-005, ADR-007, ADR-021 | — |
| Import from **Fireflies** (transcripts + bot meeting captures) | ✅ | ADR-015 | — |
| Import from **Loom** (URL-based after Loom's API was retired 2025) | ✅ | ADR-025 | — |
| Import from **YouTube** (channel polling + per-video lookup) | ✅ | ADR-027, ADR-040 | — |
| Import from **Kaltura** (entries + live-broadcast streams) | ✅ | ADR-040 | — |
| Import from **YouTube Live broadcasts** with `liveBroadcastContent` metadata captured | ✅ | ADR-040, ADR-049 | — |
| **Operator-triggered** imports (no automatic background polling — explicit click required) | ✅ | ADR-005 design | — |
| Multi-origin awareness — recognises that the same meeting was captured by multiple platforms | ✅ | ADR-033 | — |
| **Operator-shared exclusions list** — once excluded, all operators skip re-importing the source | ✅ | ADR-043 | — |
| Audio-transcription fallback (Whisper / Gemini-audio when no transcript source exists) | ⚪ | Out of scope; would be a future ADR | — |

---

## 2. Provenance graph (how videos relate across platforms)

| Capability | Status | How | Other tool |
|---|---|---|---|
| Records track **Origin / Intermediate / Destination** locations | ✅ | ADR-019 | — |
| **Provenance graph** view: nodes (records on platforms) + edges (relations) | ✅ | ADR-019, user-guide §8 | — |
| `SameEvent` relation — peer captures of the same meeting | ✅ | ADR-033 | — |
| `BroadcastedFrom` relation — YouTube-Live is the broadcast of a meeting source | ✅ | ADR-049 | — |
| `TranscribedFrom` relation — Fireflies is the transcript of a meeting source | ✅ | ADR-050 | — |
| `ClipOf` relation — a short clip generated from a longer video | ✅ | ADR-029 | — |
| `ScreenRecordingOf` relation — Loom screen-rec of a meeting | ✅ | ADR-019 | — |
| **Pair-aware UI collapse** — downstream records hide under their canonical with a badge (📺 broadcast, 📝 transcript) | ✅ | ADR-049 slice 3, ADR-050 | — |
| **Fallback canonical** — when meeting source isn't in catalog, downstream record becomes its own canonical (no invented nodes) | ✅ | ADR-049, ADR-050 | — |
| Sibling matcher with **Jaccard scoring** (participants + time + title) + 30-hour hard date gate | ✅ | ADR-033, ADR-048 | — |
| Auto-link threshold (silent ≥ 0.85) + review-banner threshold (0.6–0.85) | ✅ | ADR-033, ADR-047 | — |
| **Transcript provenance lookup** — read-time borrowing of a related record's transcript via safe relations | ✅ | ADR-053 | — |

---

## 3. Curation & review

| Capability | Status | How | Other tool |
|---|---|---|---|
| Per-record **status lifecycle**: Discovered → InScope → Approved → Publishing → Published, with off-ramps (Skipped / Failed / Abandoned / ToRetry) | ✅ | ADR-008 | — |
| **Bulk approve / skip / abandon** | ✅ | ADR-009 | — |
| **Rules engine** — ingestion rules, processing rules, post-processing rules | ✅ | ADR-013, ADR-014, ADR-024 | — |
| **Dry-run** for rules — see which records would match before commit | ✅ | user-guide §5 | — |
| **Operator-shared rule definitions** (server-persisted, not per-browser) | ✅ | ADR-031 | — |
| Per-record **Exclude** that widens to any retireable status, not just Discovered/InScope | ✅ | 2026-06-09 widening; VideoCard `canExclude` | — |
| Manual override of any auto-classification | ✅ | VideoCard manual link/unlink UI | — |
| **Curator-supplied notes** (audit trail of human decisions on records) | ✅ | ADR-008 (notes field on VideoRecord) | — |

---

## 4. Publication (where videos go)

| Capability | Status | How | Other tool |
|---|---|---|---|
| Publish to **YouTube** (per-operator brand-account OAuth) | ✅ | ADR-012, ADR-042 | — |
| Publish to **Kaltura** (org-shared admin credential) | ✅ | ADR-037, ADR-044 | — |
| **Side-publish** — push a record already published to one destination to the other in one click | ✅ | ADR-044 | — |
| **Provenance footer** on YouTube descriptions — auto-stamped trail back to the catalog row that produced the upload | ✅ | ADR-022 | — |
| **Pre-processing trim-to-boundary** — drop pre-meeting silence before uploading | ✅ | ADR-023 | — |
| **Post-processing webhook + email** triggers on publish | ✅ | ADR-024 | — |
| **Recover from out-of-band publish** — link a YouTube video uploaded outside the app back into the catalog | ✅ | user-guide §12 / VideoCard Recover | — |
| **Forward-only YouTube source-row auto-ingest** — every successful publish creates the YouTube row in catalog with the right `BroadcastedFrom` link | ✅ | ADR-049/050 C3 | — |
| YouTube-source rows from the publish-trail land at Published (not Discovered) — born-on-platform records reflect reality | ✅ | ADR-051 | — |

---

## 5. Maintenance (operator-invoked bulk operations)

| Capability | Status | How | Other tool |
|---|---|---|---|
| **Run Catch-Up** — per-record pipeline (transcript hydrate → sibling link → ensure summary) with a chosen scope | ✅ | ADR-047 | — |
| **Broadcast-Pair Migration** — one-shot reclassification of legacy `SameEvent` links to directional `BroadcastedFrom` / `TranscribedFrom` + duplicate-location dedupe | ✅ | ADR-049 slice 5 | — |
| **YouTube Row Backfill** (C1-A) — walks Destination-YouTube locations on host records and creates missing YouTube source rows + correct upstream links | ✅ | ADR-049/050 C1-A | — |
| **Summary Badge Backfill** — generates summaries for records missing or stale relative to current prompt version | ✅ | ADR-052 | — |
| Per-run **cost cap** on LLM-incurring operations (default $5.00 USD) | ✅ | ADR-052 + `lib/llmCost.ts` | — |
| **Idempotent reruns** — re-clicking any maintenance button after partial completion re-derives the work list from current state | ✅ | All maintenance cards | — |
| **Resumability** — closing the browser mid-run doesn't lose completed work | ✅ | localStorage-immediate persist + 500ms debounced server push + last-writer-wins boot merge | — |
| **Retrospective backfill orchestrator** — quota-aware bulk upload of historical content | ✅ | ADR-016, ADR-043 | — |
| **Shorts generation** — auto-clip short-form derivatives from long-form videos | 🟡 | ADR-029 | — |

---

## 6. Summaries

| Capability | Status | How | Other tool |
|---|---|---|---|
| **Prompt-driven summaries** — Markdown summary docs written to Drive, versioned by prompt version | ✅ | ADR-046 | — |
| **Version-aware staleness** — badge indicates when prompt version has drifted from current | ✅ | ADR-046, `SummaryLozenge.tsx` | — |
| **Lock** to freeze a particular summary version (bulk-regen skips locked) | ✅ | ADR-046 (`summary_locked`) | — |
| **Include-locked override** when an operator wants to forcibly re-summarise even locked records | ✅ | ADR-052 (override checkbox) | — |
| **Counts breakdown** (M / L / T / C) surfaced on the badge | ✅ | ADR-046 | — |
| Summary doc **lives on Drive** (operator can edit it directly in Google Docs) | ✅ | ADR-039, ADR-046 | — |
| Summarise records **without their own transcript** by borrowing from a paired Fireflies / Zoom / YouTube auto-caption record | ✅ | ADR-053 | — |

---

## 7. Hosting, identity, auth

| Capability | Status | How | Other tool |
|---|---|---|---|
| **Google Cloud Run** hosting (gen2 execution env, FUSE-mounted GCS for state) | ✅ | ADR-018, ADR-026 | — |
| **IAP-gated** for all `@agentics.org` Workspace users; unauthorised → redirect to project wiki | ✅ | ADR-036, ADR-045 | — |
| Roles: **Admin / Publisher / Viewer** — derived from Cloud Identity Groups, not stored per-app | ✅ | ADR-036 | — |
| **Shared platform credentials** in Google Secret Manager (Zoom, Fireflies, Kaltura, OpenRouter, OpusClip) | ✅ | ADR-042 | — |
| **Per-operator local override** of any shared credential | ✅ | ADR-042 | — |
| **YouTube auth is always per-operator** (so publishes carry the operator's brand-account identity for accountability) | ✅ | ADR-042 | — |
| **Audit log** — every API request emits an `access`/`mutation` entry with the actor's email, surfaced in EventLog within 8s | ✅ | ADR-041 | — |
| **Memory-pressure monitoring** + auto-alert via `/api/health` polled every 30s | ✅ | ADR-032 | — |
| **Build version surfaced** in `/api/version` for diagnosis ("which revision am I on?") | ✅ | ADR-030 | — |

---

## 8. Persistence & state model

| Capability | Status | How | Other tool |
|---|---|---|---|
| **Single shared catalog** — all operators see the same records (FUSE GCS) | ✅ | ADR-035 | — |
| **WASM aggregate** as the source of truth for VideoRecord (Rust + serde, compiled to WASM) | ✅ | ADR-002, ADR-008 | — |
| **Event-sourced state changes** — every transition emits a CatalogEvent | ✅ | ADR-001, ADR-008 | — |
| Per-record `lastModified` map → **per-id last-writer-wins** merge across browsers/tabs | ✅ | ADR-035 L2, `catalog/route.ts` | — |
| **localStorage offline fallback** — local cache hydrates the page before server fetch | ✅ | `lib/store.ts` | — |
| **Defensive shape coercion** in the catalog route — corrupt top-level fields auto-heal (e.g. the 2026-06-07 `lastModified` clobber incident) | ✅ | `catalog/route.ts` ; P1 fix | — |
| **Catalog shape validator script** for post-deploy smoke + ad-hoc audit | ✅ | `scripts/validate-catalog.sh` | — |
| **Drive-based artifact storage** — transcripts, descriptions, summaries, chat all in a per-meeting Drive folder readable by the operator | ✅ | ADR-039 | — |

---

## 9. Observability

| Capability | Status | How | Other tool |
|---|---|---|---|
| **Structured logging** (JSON) with `component`, `rid`, `actor` fields | ✅ | ADR-017 | — |
| **In-app EventLog** — global and per-video views | ✅ | user-guide §9 | — |
| **Cross-instance correlation** — every request gets a request ID (rid) surfaced both client- and server-side | ✅ | ADR-017 | — |
| **Audit ring buffer** — server-side recent audit entries readable via `/api/audit/recent` | ✅ | ADR-041 | — |
| **Memory pressure alerts** auto-bubble to the operator | ✅ | ADR-032, user-guide §9 | — |

---

## 10. Cost & efficiency

| Capability | Status | How | Other tool |
|---|---|---|---|
| **Per-record LLM cost estimation** (transcript length × per-model rate) | ✅ | `lib/llmCost.ts` | — |
| Cost cap per maintenance run (default $5.00) | ✅ | ADR-052 | — |
| **Prompt-version-aware skip** — already-current summaries are skipped, not re-generated | ✅ | ADR-046 | — |
| **Daily YouTube upload quota awareness** in the backfill orchestrator (auto-pause + resume next day) | ✅ | ADR-016 | — |

---

## 11. Operator UX

| Capability | Status | How | Other tool |
|---|---|---|---|
| **Single dashboard** showing every record across every platform/status | ✅ | user-guide §3 | — |
| **Per-record card** with status-aware affordances (Approve, Skip, Publish, Recover, etc.) | ✅ | `VideoCard.tsx` | — |
| **Manual transition affordances** widened past their state-machine minimums where reasonable (e.g. Exclude valid from Publishing, Failed, Published, Skipped) | ✅ | 2026-06-09 widening | — |
| **Per-video event log** filterable from the global log | ✅ | user-guide §9 | — |
| **Auto-detected sibling banner** with one-click confirm / reject | ✅ | ADR-033 | — |
| **Dry-run rule preview** before saving | ✅ | user-guide §5 | — |
| **Status filter + search** on the dashboard | ✅ | user-guide §11 | — |
| **Pair-collapse toggle** ("show paired records") to expose hidden downstream rows | ✅ | ADR-049 slice 3 | — |
| **Provenance footer**-rendered YouTube description so operator/viewers can navigate back to the catalog row | ✅ | ADR-022 | — |

---

## 12. What's deliberately out of scope (today)

| Item | Why | Tracked as |
|---|---|---|
| Audio transcription via Whisper / Gemini-audio when no transcript source exists | Substantial new dependency; the ADR-053 provenance route gets us 80%+ for free | Would be a future ADR (ADR-054+) |
| MCP server for querying live-broadcast chat messages | Exploration only | ADR-034 (Proposed/exploration) |
| Automatic background polling for new content on source platforms | Operator-triggered model is intentional — predictable cost, predictable behaviour | ADR-005 design |
| Multi-organisation / multi-tenant | Single-org by design today | — |
| Real-time collaboration (two operators editing the same card simultaneously) | LWW merge across browsers is sufficient for current use | ADR-035 |
| Synthetic stub summaries (badge populated without a real summary doc) | Confuses the operator more than it helps — empty state is clearer | ADR-052 alternatives table |
| Auto-relock after override-regen | Operator can manually re-lock; deferred until pain emerges | ADR-052 open questions |

---

## 13. Comparison checklist

When evaluating Video Bridge against another tool, walk through these sections in order:

1. **Source coverage** — does the other tool cover the same set of source platforms with the same depth (transcript capture, live-broadcast metadata, multi-origin awareness)?
2. **Provenance** — does the other tool understand that the same meeting captured by Zoom + Fireflies + YouTube is one logical event, with directional relations between them? Or does it treat them as separate?
3. **Maintenance / catch-up** — does the other tool let you fix retroactively when you bring in legacy data, or does it only work on the forward path?
4. **Curation** — can a single operator review and approve at scale, or is the workflow human-per-video?
5. **Identity & audit** — does each action carry the actor's identity all the way through to a queryable log? Are roles derived from your org's existing identity system, or is there a separate user database?
6. **Cost guardrails** — does the other tool let you cap LLM/API spend per operation?
7. **Resumability** — does work survive a browser refresh or a deploy mid-run?
8. **State persistence** — is state per-browser, or shared across the org? Can two operators on the same URL see the same catalog?
9. **Operator UX** — is the UI honest about what's been done vs what's pending? Or do you have to dig?

---

## References

- **Mission and vision**: [`docs/mission-and-vision.md`](mission-and-vision.md)
- **User guide** (full feature walkthrough): [`docs/user-guide.md`](user-guide.md)
- **User flows** (step-by-step diagrams): [`docs/user-flows.md`](user-flows.md)
- **Stakeholders**: [`docs/stakeholders.md`](stakeholders.md)
- **ADR index**: [`docs/adr/README.md`](adr/README.md) — links to ADR-001 through ADR-053
- **Domain model** (DDD): [`docs/ddd/`](ddd/)
