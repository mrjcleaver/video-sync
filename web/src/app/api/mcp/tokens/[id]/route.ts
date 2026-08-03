/**
 * DELETE /api/mcp/tokens/[id] — revoke a token by id. Admin-only.
 * Immediate — the token stops resolving on next call.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../../lib/serverLogger";
import { getActor } from "../../../../../lib/auth";
import { revokeToken } from "../../../../../lib/mcpTokens";

export const dynamic = "force-dynamic";

async function deleteHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor;
  try { actor = await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role !== "Admin") {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const ok = await revokeToken(id);
  if (!ok) return NextResponse.json({ error: "token not found" }, { status: 404 });
  serverLog("info", "api:mcp/tokens", "revoked", { id, actor: actor.email });
  return NextResponse.json({ ok: true, id });
}

export const DELETE = withRequestLogging("api:mcp/tokens", deleteHandler as never);
