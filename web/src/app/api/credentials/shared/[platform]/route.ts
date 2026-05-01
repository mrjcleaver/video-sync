/**
 * PUT /api/credentials/shared/:platform
 *   Body: platform-specific JSON shape
 *   Auth: Admin role only
 *   Effect: writes a new Secret Manager version, disables prior versions
 *
 * DELETE /api/credentials/shared/:platform
 *   Auth: Admin role only
 *   Effect: removes the shared secret entirely; falls through to
 *           operator override / unconfigured for everyone
 *
 * Returns 403 to non-Admin actors. Audited via ADR-041's withRequestLogging
 * (audit=mutation, actor_email captured automatically).
 *
 * Per-platform body shapes (Phase 1 — caller is responsible for validity):
 *   zoom        { accountId, clientId, clientSecret }
 *   fireflies   { apiKey }
 *   kaltura     { partnerId, adminSecret }
 *   openrouter  { apiKey }
 *   opusclip    { apiKey }
 *
 * Stripped on read (never returned to clients): `_set_by`, `_set_at`.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../../lib/serverLogger";
import { getActor } from "../../../../../lib/auth";
import {
  isSharedPlatform,
  setSharedCredential,
  deleteSharedCredential,
} from "../../../../../lib/sharedCredentials";

export const dynamic = "force-dynamic";

async function requireAdmin(req: NextRequest) {
  const actor = await getActor(req);
  if (actor.role !== "Admin") {
    const e = new Error("Admin role required");
    (e as Error & { status?: number }).status = 403;
    throw e;
  }
  return actor;
}

async function putHandler(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!isSharedPlatform(platform)) {
    return NextResponse.json({ error: `unknown platform '${platform}'` }, { status: 400 });
  }

  let actor;
  try {
    actor = await requireAdmin(req);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 401;
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON object body required" }, { status: 400 });
  }
  // Strip any reserved metadata keys the caller might try to spoof
  delete body._set_by;
  delete body._set_at;

  try {
    const result = await setSharedCredential(platform, body, actor.email);
    return NextResponse.json({ ok: true, platform, ...result });
  } catch (err) {
    // gRPC errors from @google-cloud/secret-manager carry .code (numeric),
    // .details, and .metadata in addition to (or instead of) name/message.
    // Dump every plausible field so we can actually see what failed.
    const e = err as Record<string, unknown> & Error;
    const detail = JSON.stringify({
      name: e?.name,
      message: e?.message,
      code: e?.code,
      details: e?.details,
      stack: typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 6).join(" | ") : undefined,
      raw: typeof err === "string" ? err : undefined,
    });
    serverLog("error", "api:credentials/shared", "set failed", {
      platform,
      actor: actor.email,
      error: detail,
    });
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}

async function deleteHandler(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!isSharedPlatform(platform)) {
    return NextResponse.json({ error: `unknown platform '${platform}'` }, { status: 400 });
  }
  try {
    await requireAdmin(req);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 401;
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
  try {
    await deleteSharedCredential(platform);
    return NextResponse.json({ ok: true, platform });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const PUT = withRequestLogging("api:credentials/shared/[platform]", putHandler as never);
export const DELETE = withRequestLogging("api:credentials/shared/[platform]", deleteHandler as never);
