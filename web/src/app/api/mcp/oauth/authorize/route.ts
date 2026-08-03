/**
 * OAuth 2.1 authorization endpoint. Two verbs:
 *
 *   GET  — the browser lands here after Claude Desktop opens the URL.
 *          IAP has already authenticated the user, so we know who they
 *          are. We render an HTML consent page listing what the client
 *          will get access to, with an "Approve" button that POSTs back.
 *   POST — Approve action. Validates state, mints an authorization code
 *          bound to the current actor + PKCE challenge, redirects to
 *          the client's redirect_uri with `?code=…&state=…`.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../../lib/serverLogger";
import { getTrueActor } from "../../../../../lib/auth";
import { getClient, issueCode } from "../../../../../lib/mcpOauth";

export const dynamic = "force-dynamic";

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope?: string;
}

function parseParams(url: URL): Partial<AuthorizeParams> {
  return {
    response_type: url.searchParams.get("response_type") ?? undefined,
    client_id: url.searchParams.get("client_id") ?? undefined,
    redirect_uri: url.searchParams.get("redirect_uri") ?? undefined,
    code_challenge: url.searchParams.get("code_challenge") ?? undefined,
    code_challenge_method: url.searchParams.get("code_challenge_method") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    scope: url.searchParams.get("scope") ?? undefined,
  };
}

function errorPage(msg: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>MCP authorization error</title>` +
    `<style>body{font-family:system-ui;max-width:640px;margin:64px auto;padding:0 16px;color:#333}h1{color:#dc2626}pre{background:#fafafa;padding:12px;border:1px solid #eee;border-radius:4px;white-space:pre-wrap}</style>` +
    `<h1>MCP authorization error</h1><pre>${msg.replace(/</g, "&lt;")}</pre>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function getHandler(req: NextRequest) {
  const url = new URL(req.url);
  // Two-service topology: the PUBLIC service can't authenticate the
  // browser (no IAP), so it 302s the whole flow over to the MAIN
  // service which has IAP. Anthropic-style OAuth validators that
  // enforce authorization_endpoint === issuer-origin still pass
  // because they only inspect the metadata URL, not the ultimate
  // destination the browser lands on.
  const mainOrigin = process.env.NEXT_PUBLIC_MCP_MAIN_ORIGIN?.trim();
  const selfOrigin = url.origin;
  if (mainOrigin && mainOrigin !== selfOrigin) {
    const forwarded = new URL(`${mainOrigin}${url.pathname}`);
    for (const [k, v] of url.searchParams.entries()) forwarded.searchParams.set(k, v);
    return NextResponse.redirect(forwarded.toString(), 302);
  }

  let actor;
  try { actor = await getTrueActor(req); }
  catch (err) { return errorPage(`Not authenticated: ${err instanceof Error ? err.message : String(err)}`); }

  const p = parseParams(url);
  if (p.response_type !== "code") return errorPage("response_type must be 'code'");
  if (!p.client_id) return errorPage("client_id required");
  if (!p.redirect_uri) return errorPage("redirect_uri required");
  if (!p.code_challenge) return errorPage("code_challenge required (PKCE)");
  if (p.code_challenge_method !== "S256") return errorPage("code_challenge_method must be 'S256'");
  if (!p.state) return errorPage("state required");

  const client = await getClient(p.client_id);
  if (!client) return errorPage(`Unknown client_id: ${p.client_id}`);
  if (!client.redirect_uris.includes(p.redirect_uri)) return errorPage(`redirect_uri not registered for this client`);

  // Render the consent page. Form POSTs back to the same URL with the
  // same query params so the POST handler can re-validate.
  const clientNameHtml = (client.client_name ?? p.client_id).replace(/</g, "&lt;");
  const roleHtml = actor.role;
  const emailHtml = actor.email.replace(/</g, "&lt;");
  const redirectHtml = p.redirect_uri.replace(/</g, "&lt;");

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Authorise MCP access</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 48px auto; padding: 0 20px; color: #1f2937; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  h1 { margin: 0 0 8px; font-size: 1.25rem; }
  .lead { color: #6b7280; margin: 0 0 20px; font-size: 0.92rem; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f4f6; font-size: 0.92rem; }
  .row:last-of-type { border-bottom: none; }
  .row .k { color: #6b7280; }
  .row .v { color: #111827; font-weight: 500; word-break: break-all; }
  .actions { display: flex; gap: 8px; margin-top: 20px; }
  button { padding: 10px 20px; border-radius: 6px; border: 1px solid transparent; font-size: 0.92rem; cursor: pointer; }
  .approve { background: #4f46e5; color: white; }
  .deny { background: white; color: #4b5563; border-color: #d1d5db; }
  .grant { background: #fef3c7; border: 1px solid #fbbf24; border-radius: 4px; padding: 8px 12px; margin: 16px 0; font-size: 0.85rem; color: #92400e; }
</style>
<div class="card">
  <h1>🔌 Authorise MCP access</h1>
  <p class="lead"><strong>${clientNameHtml}</strong> is requesting access to video-sync as you.</p>
  <div class="row"><span class="k">Signed in as</span><span class="v">${emailHtml}</span></div>
  <div class="row"><span class="k">Effective role</span><span class="v">${roleHtml}</span></div>
  <div class="row"><span class="k">Redirect URL</span><span class="v">${redirectHtml}</span></div>
  <div class="grant">
    Approving will issue a bearer token that inherits your <strong>${roleHtml}</strong> role and email. The client can
    read what you can read. Revoke anytime from <strong>Config → 🔌 MCP tokens</strong>.
  </div>
  <form method="POST" action="${url.pathname}${url.search}">
    <div class="actions">
      <button class="approve" type="submit" name="decision" value="approve">Approve</button>
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
    </div>
  </form>
</div>`;

  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function postHandler(req: NextRequest) {
  let actor;
  try { actor = await getTrueActor(req); }
  catch (err) { return errorPage(`Not authenticated: ${err instanceof Error ? err.message : String(err)}`); }

  const url = new URL(req.url);
  const p = parseParams(url);
  if (p.response_type !== "code" || !p.client_id || !p.redirect_uri || !p.code_challenge || p.code_challenge_method !== "S256" || !p.state) {
    return errorPage("Invalid authorization request");
  }

  const client = await getClient(p.client_id);
  if (!client) return errorPage(`Unknown client_id: ${p.client_id}`);
  if (!client.redirect_uris.includes(p.redirect_uri)) return errorPage(`redirect_uri not registered for this client`);

  const form = await req.formData();
  const decision = form.get("decision");
  const redirect = new URL(p.redirect_uri);
  if (decision !== "approve") {
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("state", p.state);
    return NextResponse.redirect(redirect.toString(), 302);
  }

  const code = await issueCode({
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge,
    code_challenge_method: "S256",
    scope: p.scope,
    actor_email: actor.email,
    actor_role: actor.role,
    actor_user_id: actor.user_id,
  });
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", p.state);
  return NextResponse.redirect(redirect.toString(), 302);
}

export const GET = withRequestLogging("api:mcp/oauth/authorize", getHandler as never);
export const POST = withRequestLogging("api:mcp/oauth/authorize", postHandler as never);
