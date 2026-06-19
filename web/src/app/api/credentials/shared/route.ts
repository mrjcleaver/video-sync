/**
 * GET /api/credentials/shared
 * Returns metadata-only summary of which shared credentials are
 * configured, who set them, and when. Never returns the secret bodies.
 *
 * Any authenticated user; the Connections UI uses this to show
 * "Source: shared default (set by …)" badges.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { listSharedSecretMeta } from "../../../../lib/sharedCredentials";

export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  try {
    await getActor(req);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  const meta = await listSharedSecretMeta();
  return NextResponse.json({ shared: meta });
}

export const GET = withRequestLogging("api:credentials/shared", handler);
