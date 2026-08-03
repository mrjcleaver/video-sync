/**
 * ADR-066 §7 — MCP token mint / list endpoints.
 *
 * GET  /api/mcp/tokens          — list the caller's own tokens (Admin sees theirs).
 *                                Admins can pass ?all=1 to see every token in the
 *                                system (surfaces owner email + last-4).
 * POST /api/mcp/tokens          — mint a new token. Body: { name }. Response
 *                                includes the plaintext ONE TIME.
 *
 * Every token inherits the caller's role at mint time. A Publisher token
 * created today stays a Publisher token even if the operator's group
 * membership changes later — revoke and re-mint if the role needs to shift.
 *
 * Currently Admin-only for both list and mint. Publishers can be
 * enabled once we're comfortable with the security model; ADR-066 §4
 * notes tokens max at Publisher scope anyway.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { listTokens, mintToken } from "../../../../lib/mcpTokens";

export const dynamic = "force-dynamic";

async function getHandler(req: NextRequest) {
  let actor;
  try { actor = await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role !== "Admin") {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }
  const showAll = req.nextUrl.searchParams.get("all") === "1";
  const scoped = showAll ? null : actor.email;
  const tokens = await listTokens(scoped);
  return NextResponse.json({
    tokens: tokens.map(t => ({
      id: t.id,
      name: t.name,
      last4: t.last4,
      actor_email: t.actor_email,
      actor_role: t.actor_role,
      created_at: t.created_at,
      last_used_at: t.last_used_at ?? null,
    })),
  });
}

async function postHandler(req: NextRequest) {
  let actor;
  try { actor = await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role !== "Admin") {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const name = typeof body.name === "string" && body.name.trim().length > 0
    ? body.name.trim()
    : "unnamed";
  const { record, plaintext } = await mintToken({
    name,
    actor_email: actor.email,
    actor_role: actor.role,
    actor_user_id: actor.user_id,
  });
  serverLog("info", "api:mcp/tokens", "minted", { id: record.id, actor: actor.email });
  return NextResponse.json({
    id: record.id,
    name: record.name,
    last4: record.last4,
    actor_email: record.actor_email,
    actor_role: record.actor_role,
    created_at: record.created_at,
    plaintext,                                // ← ONE TIME ONLY
    warning: "This is the only time the plaintext is shown. Store it now.",
  });
}

export const GET = withRequestLogging("api:mcp/tokens", getHandler as never);
export const POST = withRequestLogging("api:mcp/tokens", postHandler as never);
