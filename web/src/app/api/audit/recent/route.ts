/**
 * GET /api/audit/recent
 * Returns the in-memory audit ring buffer for client polling (ADR-041).
 *
 * Query params:
 *   since?: ISO timestamp — return events strictly later than this
 *   limit?: 1..500 — max events when `since` is absent (default 100)
 *
 * Response: { events: AuditEvent[] }
 *
 * Buffer is per-Cloud-Run-instance. Multi-instance deployments have
 * per-instance views; for full audit history use Cloud Logging
 * (the events here also flow there via stdout).
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, getRecentAudit } from "../../../../lib/serverLogger";

export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  const url = new URL(req.url);
  const since = url.searchParams.get("since") ?? undefined;
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
  return NextResponse.json({ events: getRecentAudit(since, limit) });
}

export const GET = withRequestLogging("api:audit/recent", handler);
