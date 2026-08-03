/**
 * RFC 8414 — OAuth Authorization Server Metadata. Tells the client
 * which endpoints to hit for /register, /authorize, /token, and what
 * grant types + PKCE methods we support.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function GET(req: NextRequest) {
  const selfOrigin = new URL(req.url).origin;
  // authorize needs an IAP-fronted browser session → lives on MAIN.
  // register + token are called by external clients (Claude Desktop /
  // mcp-remote) that can't drive IAP → live on PUBLIC. Env-defaults
  // to selfOrigin so a single-service deploy also works.
  const publicOrigin = process.env.NEXT_PUBLIC_MCP_PUBLIC_ORIGIN?.trim() || selfOrigin;
  return NextResponse.json({
    // RFC 8414 §3 — issuer MUST match the origin serving this metadata
    // document. Everything hangs off the public origin — including
    // authorization_endpoint. The public /authorize handler 302s
    // over to the main IAP origin so browser consent still runs
    // where we know the user's identity. That redirect is invisible
    // to strict OAuth validators that check endpoint origins.
    issuer: publicOrigin,
    authorization_endpoint: `${publicOrigin}/api/mcp/oauth/authorize`,
    token_endpoint: `${publicOrigin}/api/mcp/oauth/token`,
    registration_endpoint: `${publicOrigin}/api/mcp/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
    service_documentation: "https://github.com/mrjcleaver/video-sync/blob/main/docs/adr/ADR-066-mcp-show-notes-server.md",
  }, { headers: CORS });
}
