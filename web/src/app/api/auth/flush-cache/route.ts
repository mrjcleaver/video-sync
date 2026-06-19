import { NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getActor, flushGroupCache } from "../../../../lib/auth";

/**
 * POST /api/auth/flush-cache
 *
 * Admin-only escape hatch to drop the in-memory group-membership cache
 * (5-min TTL by default). Used when a Workspace admin removes someone
 * from a group and needs the access revocation to take effect within
 * seconds rather than minutes.
 *
 * Requires the caller to be authenticated AND have role=Admin. 401 on
 * unauthenticated, 403 on non-admin.
 */

export const dynamic = "force-dynamic";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
};

async function handler(req: Request) {
  let actor;
  try {
    actor = await getActor(req);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 401, headers: NO_CACHE_HEADERS },
    );
  }
  if (actor.role !== "Admin") {
    return NextResponse.json(
      { error: "Admin role required" },
      { status: 403, headers: NO_CACHE_HEADERS },
    );
  }
  flushGroupCache();
  return NextResponse.json({ ok: true }, { headers: NO_CACHE_HEADERS });
}

export const POST = withRequestLogging("api:auth/flush-cache", handler);
