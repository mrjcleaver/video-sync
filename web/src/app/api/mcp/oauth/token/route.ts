/**
 * OAuth 2.1 token endpoint. Redeems an authorization code + PKCE
 * verifier for a bearer access token. The access token is minted
 * through the existing mcpTokens store, so it's a normal `vsync_`
 * token and getActor() resolves it identically to a hand-minted one.
 *
 * Public endpoint (no auth requirement). PKCE + single-use code
 * bind the exchange to the browser that started the flow.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../../lib/serverLogger";
import { redeemCode } from "../../../../../lib/mcpOauth";
import { mintToken } from "../../../../../lib/mcpTokens";
import type { Role } from "../../../../../lib/types/actor";

export const dynamic = "force-dynamic";

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

async function readForm(req: NextRequest): Promise<Record<string, string>> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text).entries()) out[k] = v;
    return out;
  }
  if (ct.includes("application/json")) {
    const j = await req.json().catch(() => ({} as Record<string, unknown>));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  }
  // multipart/form-data
  const fd = await req.formData().catch(() => null);
  if (fd) {
    const out: Record<string, string> = {};
    fd.forEach((v, k) => { if (typeof v === "string") out[k] = v; });
    return out;
  }
  return {};
}

async function postHandler(req: NextRequest) {
  const params = await readForm(req);
  if (params.grant_type !== "authorization_code") {
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400, headers: CORS });
  }
  const code = params.code;
  const client_id = params.client_id;
  const redirect_uri = params.redirect_uri;
  const code_verifier = params.code_verifier;
  if (!code || !client_id || !redirect_uri || !code_verifier) {
    return NextResponse.json({ error: "invalid_request", error_description: "code, client_id, redirect_uri, code_verifier all required" }, { status: 400, headers: CORS });
  }
  const result = await redeemCode({ code, client_id, redirect_uri, code_verifier });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400, headers: CORS });
  }
  const rec = result.record;
  const { plaintext } = await mintToken({
    name: `OAuth · ${client_id}`,
    actor_email: rec.actor_email,
    actor_role: rec.actor_role as Role,
    actor_user_id: rec.actor_user_id,
  });
  serverLog("info", "api:mcp/oauth/token", "code exchanged", { client_id, actor: rec.actor_email });
  return NextResponse.json({
    access_token: plaintext,
    token_type: "Bearer",
    scope: rec.scope ?? "mcp",
    // No refresh token in this MVP — clients can re-run the flow.
  }, { headers: CORS });
}

export const POST = withRequestLogging("api:mcp/oauth/token", postHandler as never);
