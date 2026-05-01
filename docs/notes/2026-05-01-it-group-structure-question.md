# Note for IT — Workspace group structure for video-sync auth

**To**: Workspace / Identity admins
**From**: video-sync engineering
**Date**: 2026-05-01
**Decision needed**: Confirm or revise the Workspace group structure that gates access to https://video-sync.agentics.org

---

## Why we're asking

We're authenticating users into a Cloud Run app (video-sync) via Identity-Aware Proxy. IAP gates the door (only allow-listed users reach the service); inside the app, **roles** decide what each user can do (read-only, publish, manage keys). We need a way to ask Cloud Identity "what role does this user have?" on every request.

We tried two query patterns and want your view on the long-term shape before we lock it in.

---

## Current setup (working as of this commit)

Three Workspace email groups, one per role:

| Group | App role | Capabilities |
|-------|----------|--------------|
| `video-sync-viewers@agentics.org`     | Viewer    | Read the catalog, view metadata, read transcripts |
| `video-sync-operators@agentics.org`   | Publisher | All Viewer + import recordings + publish to YouTube/Kaltura + edit rules |
| `video-sync-key-admins@agentics.org`  | Admin     | All Publisher + run migrations + invalidate caches |

The Cloud Run runtime service account (`667037737667-compute@developer.gserviceaccount.com`) is **MEMBER + MANAGER** on each of the three groups. On every authenticated request the app calls Cloud Identity's `groups:lookup` + `memberships:lookup` to see whether the requesting user is in each group.

This works today, but it required iterating through several failed approaches and we're not sure it's the *right* shape for the long term.

---

## What we tried that didn't work — and why

### A. `searchTransitiveGroups` (asked "what groups is THIS user in?")

This is the cleaner API: one call per user, returns every group they're in, we filter to ours. Implementation is short.

**It returned 403 PERMISSION_DENIED.** Even with the runtime SA promoted to MANAGER on all three groups, the API requires the caller to have **Workspace-admin-level user-reader privilege** to enumerate arbitrary users' memberships. Being a Manager *of a group* gives you authority over that group; it doesn't authorise you to read other users' membership lists.

To use this approach we'd need IT to grant the runtime SA a Workspace admin role with the "Users → Read" privilege (or assign it `roles/cloudidentity.groupsReader` at the Workspace tier). That's a meaningful expansion of the SA's authority — probably worth a separate sign-off.

### B. `memberships:lookup` per group (asked "is this user in THIS group?")

This is what we ship today. For each of the three groups, we look up the group resource name and then ask "is `agent@agentics.org` a member?" The SA can do this **because it's a member of the group itself** — listing/checking memberships of a group you're in is allowed without admin-tier permissions.

Costs: 3 API calls per uncached lookup. Group resource names are cached 24h; user→roles caches 5min. Adds ~50–150ms to a cold lookup.

---

## Three structures IT could choose between

We'd like to converge on one of these and stop iterating. Each has different operational implications for IT.

### Option 1 — **Three groups, one per role** (current shape)

What we have. Adding a person to a role = adding their email to the corresponding group. Removing a role = removing them. One person can be in multiple groups (e.g. an Admin is also a Publisher and Viewer); the app picks the highest role.

**For IT**:
- Familiar Workspace pattern.
- Three group lifecycles to manage (creation, membership lists, retirement).
- Per-group ownership/managers can be different humans if you want layered approval.

**For us**:
- Either keep the per-group `memberships:lookup` approach (B above, no IT permission grant needed) **or** ask for the SA to get user-reader admin (A above, simpler app code).

### Option 2 — **One group, multi-tier with sub-groups or labels**

A single `video-sync-users@agentics.org` group with role information carried out-of-band. Either:

- (2a) A **single group** + we maintain role membership in the app (e.g. an `OPERATOR_EMAILS` env var or a `roles.json` config). Workspace just answers "is this person in any video-sync group at all?"
- (2b) A **single group + nested sub-groups** (Workspace allows groups-within-groups). One outer group for IAP gating, three inner groups for role differentiation, all inheriting upward.

**For IT**:
- 2a is one group to manage. Role changes happen in code/config, not in Workspace. Worse audit trail in Workspace, better velocity for engineering.
- 2b is four groups to manage (one outer + three inner) but provides clean Workspace-side audit of role membership.

**For us**:
- 2a removes the need to query Cloud Identity for role at all — IAP gating is sufficient and roles come from app config. Simplest app code.
- 2b is structurally similar to Option 1 from our side; we'd still query each role-group.

### Option 3 — **Domain-restriction + role attributes on user records**

Anyone with an `@agentics.org` Workspace account is allowed in (no group required). Roles come from a Workspace user attribute (custom schema field, e.g. `videoSyncRole: "admin"`).

**For IT**:
- Most permissive — no per-app group needed. Custom schema is a Workspace Directory feature.
- Potentially expands the trust boundary (every Workspace user → every internal app), unless paired with per-app IAP allowlists.

**For us**:
- We'd query `users.get` (Admin SDK) to read the attribute. SA needs Directory user.read scope.
- Reasonable if you're standardising this pattern across multiple internal tools.

---

## Comparison table

| | Option 1 (3 groups) | Option 2a (1 group + app config) | Option 2b (1 outer + 3 nested) | Option 3 (domain + attribute) |
|--|--|--|--|--|
| Groups to manage | 3 | 1 | 4 | 0 (per app) |
| Role audit trail in Workspace | Yes | No | Yes | Partial (via attribute history) |
| App code complexity | Medium | Lowest | Medium | Medium-high |
| SA permission needed | None special (currently) OR `groupsReader` (cleaner) | None | None | `directory.user.readonly` |
| Onboarding a new operator | Add to `-operators@` group | Edit env var + redeploy | Add to `-operators-inner@` group | Set their `videoSyncRole` attribute |
| Offboarding | Remove from group(s) | Edit env var + redeploy | Remove from group(s) | Clear their attribute |
| Reusability for other apps | Per-app group cluster | Per-app config | Per-app group cluster | Yes, with different attributes |

---

## What we need from you

1. **Preferred structure** — Option 1, 2a, 2b, 3, or something we missed.
2. If Option 1: do you want us to keep the per-group `memberships:lookup` approach, or would you rather grant the runtime SA a `groupsReader`-equivalent so we can switch to the simpler `searchTransitiveGroups` query? Either is fine for us.
3. **Group ownership / Manager assignment policy** — should the runtime SA stay as a Manager on the role groups, or is that something you'd rather not have a service account doing?
4. **Cadence for membership changes** — if an admin removes someone from a group, how quickly do you expect that to take effect in the app? We currently cache for 5 minutes; we can drop it shorter or longer based on your audit/responsiveness preference.

For context, the runtime SA is `667037737667-compute@developer.gserviceaccount.com` and the app is at https://video-sync.agentics.org.

Happy to walk through this on a 15-minute call — usually faster than an email thread. Let me know what works.
