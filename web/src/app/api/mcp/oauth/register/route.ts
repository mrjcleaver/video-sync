/**
 * RFC 7591 — Dynamic Client Registration. Public endpoint: Claude
 * Desktop POSTs `{redirect_uris, client_name}` on first setup and we
 * return a `client_id`. No client_secret is issued (PKCE is the auth).
 *
 * Public because it needs to be reachable before the OAuth flow.
 * Rate limits + abuse mitigation are TODO — this is an early cut.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../../lib/serverLogger";
import { registerClient } from "../../../../../lib/mcpOauth";

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

async function postHandler(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const redirect_uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]).filter(u => typeof u === "string") as string[] : [];
  if (redirect_uris.length === 0) {
    serverLog("warn", "api:mcp/oauth/register", "no redirect_uris", { body_preview: JSON.stringify(body).slice(0, 400) });
    return NextResponse.json({ error: "invalid_client_metadata", error_description: "redirect_uris required" }, { status: 400, headers: CORS });
  }
  const client_name = typeof body.client_name === "string" ? body.client_name : undefined;
  const client = await registerClient({ client_name, redirect_uris });
  serverLog("info", "api:mcp/oauth/register", "client registered", {
    client_id: client.client_id,
    name: client.client_name,
    redirect_uris,
    request_body: JSON.stringify(body).slice(0, 400),
  });
  // RFC 7591 §3.2.1 response. Beyond the required `client_id` we
  // include `client_id_issued_at`, echo back every metadata field the
  // caller sent that we can honour, and set `client_secret_expires_at: 0`
  // to mark this as a public client (PKCE only, no secret). Anthropic's
  // Custom Connector "sign-in service" reads this response strictly —
  // omissions cause the frontend to show "Couldn't register with …".
  const now = Math.floor(Date.now() / 1000);
  const scopeIn = typeof body.scope === "string" ? body.scope : "mcp";
  const grantsIn = Array.isArray(body.grant_types)
    ? (body.grant_types as unknown[]).filter(g => typeof g === "string") as string[]
    : ["authorization_code"];
  const responseTypesIn = Array.isArray(body.response_types)
    ? (body.response_types as unknown[]).filter(r => typeof r === "string") as string[]
    : ["code"];
  return NextResponse.json({
    client_id: client.client_id,
    client_id_issued_at: now,
    client_secret_expires_at: 0,           // public client, no secret rotation
    client_name: client.client_name ?? "unnamed",
    redirect_uris: client.redirect_uris,
    grant_types: grantsIn.filter(g => g === "authorization_code"),  // we only honour code grant
    response_types: responseTypesIn.filter(r => r === "code"),
    token_endpoint_auth_method: "none",
    application_type: "native",
    scope: scopeIn,
  }, {
    status: 201,
    headers: { ...CORS, "Cache-Control": "no-store", "Pragma": "no-cache" },
  });
}

export const POST = withRequestLogging("api:mcp/oauth/register", postHandler as never);
