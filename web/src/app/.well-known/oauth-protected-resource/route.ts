/**
 * RFC 9728 — Protected Resource Metadata. Advertises where our
 * authorization server lives so a client (Claude Desktop, mcp-remote)
 * knows which /authorize + /token to talk to.
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
  // Two-service topology (ADR-066 §4 follow-up): the RPC + token +
  // register endpoints are served from the PUBLIC no-IAP Cloud Run
  // service; /authorize lives on the MAIN IAP-fronted service because
  // it needs the operator's browser session. Both env vars default to
  // the current request origin so a single-service deploy still works.
  const publicOrigin = process.env.NEXT_PUBLIC_MCP_PUBLIC_ORIGIN?.trim() || selfOrigin;
  return NextResponse.json({
    resource: `${publicOrigin}/api/mcp`,
    // authorization_servers must be reachable WITHOUT auth (RFC 9728
    // discovery). The main IAP service can't serve this because IAP
    // 302s unauthenticated GETs to Google login. Point at the public
    // service — its oauth-authorization-server doc names the main
    // service's /authorize URL inside the response body, so the
    // browser hop for consent still lands on the IAP-fronted origin.
    authorization_servers: [publicOrigin],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/mrjcleaver/video-sync/blob/main/docs/adr/ADR-066-mcp-show-notes-server.md",
  }, { headers: CORS });
}
