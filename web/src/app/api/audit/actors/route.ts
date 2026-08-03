/**
 * GET /api/audit/actors
 *
 * Admin-only. Aggregates the in-memory audit ring (ADR-041) into a
 * per-actor summary so an admin can see who has been in the app and
 * with what effective role.
 *
 * The ring is per-Cloud-Run-instance and capped at 500 entries — this
 * is a "recent" view, not a full audit history. For long-window queries
 * point Cloud Logging at `jsonPayload.audit`.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, getRecentAudit } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";

export const dynamic = "force-dynamic";

interface ActorSummary {
  actor_email: string;
  roles: string[];              // distinct roles observed (usually one; changes on view-as / group edit)
  latest_role: string;
  first_seen: string;
  last_seen: string;
  request_count: number;
  mutation_count: number;
  paths_touched: string[];      // small sample of distinct paths, up to 8
  last_status: number;
  last_path: string;
}

async function handler(req: NextRequest) {
  let actor;
  try { actor = await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role !== "Admin") {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  const events = getRecentAudit(undefined, 500);
  const byActor = new Map<string, ActorSummary>();
  for (const e of events) {
    if (!e.actor_email) continue;
    const key = e.actor_email;
    let s = byActor.get(key);
    if (!s) {
      s = {
        actor_email: e.actor_email,
        roles: [],
        latest_role: e.actor_role ?? "unknown",
        first_seen: e.ts,
        last_seen: e.ts,
        request_count: 0,
        mutation_count: 0,
        paths_touched: [],
        last_status: e.status,
        last_path: e.path,
      };
      byActor.set(key, s);
    }
    s.request_count++;
    if (e.audit === "mutation") s.mutation_count++;
    if (e.actor_role && !s.roles.includes(e.actor_role)) s.roles.push(e.actor_role);
    if (e.ts < s.first_seen) s.first_seen = e.ts;
    if (e.ts >= s.last_seen) {
      s.last_seen = e.ts;
      s.latest_role = e.actor_role ?? s.latest_role;
      s.last_status = e.status;
      s.last_path = e.path;
    }
    if (s.paths_touched.length < 8 && !s.paths_touched.includes(e.path)) s.paths_touched.push(e.path);
  }
  const rows = Array.from(byActor.values()).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  return NextResponse.json({
    actors: rows,
    ring_size: events.length,
    ring_capacity: 500,
  });
}

export const GET = withRequestLogging("api:audit/actors", handler as never);
