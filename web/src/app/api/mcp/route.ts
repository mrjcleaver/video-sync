/**
 * ADR-066 — MCP endpoint. Streamable-HTTP transport, JSON-only variant.
 *
 * Client POSTs a JSON-RPC 2.0 request → server returns a JSON-RPC
 * response (or empty 202 for notifications). Auth reuses ADR-036
 * IAP + optional bearer API keys (see /api/mcp/tokens for issuance).
 *
 * GET on the same URL returns a small identity page so a browser
 * visit + Claude Desktop's "test connection" affordance both work.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../lib/serverLogger";
import { getActor } from "../../../lib/auth";
import { handleMcpRpc, parseJsonRpc } from "../../../lib/mcpServer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "www-authenticate, mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

async function getHandler(req: NextRequest) {
  // Advertise identity + basic guidance for a curious operator.
  try { await getActor(req); }
  catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 401, headers: CORS },
    );
  }
  return NextResponse.json({
    name: "video-sync",
    protocol: "mcp/2025-06-18",
    transport: "streamable-http",
    endpoint: new URL(req.url).origin + "/api/mcp",
    docs: "https://github.com/mrjcleaver/video-sync/blob/main/docs/adr/ADR-066-mcp-show-notes-server.md",
    hint: "POST JSON-RPC 2.0 to this URL. Start with `initialize` then `tools/list` / `resources/list`.",
  }, { headers: CORS });
}

async function postHandler(req: NextRequest) {
  let actor;
  try {
    actor = await getActor(req);
  } catch (e) {
    // RFC 9728 — advertise the protected-resource metadata URL in the
    // WWW-Authenticate header so an MCP client discovers our OAuth
    // authorization server automatically. Claude Desktop / mcp-remote
    // follow the resource_metadata link, then hit .well-known/
    // oauth-authorization-server on the returned origin.
    // Prefer NEXT_PUBLIC_MCP_PUBLIC_ORIGIN when set — new URL(req.url)
    // on Cloud Run without a load balancer surfaces the internal
    // 0.0.0.0:8080 URL, not the public one.
    const origin = process.env.NEXT_PUBLIC_MCP_PUBLIC_ORIGIN?.trim() || new URL(req.url).origin;
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: e instanceof Error ? e.message : String(e) } },
      {
        status: 401,
        headers: {
          ...CORS,
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="invalid_token"`,
        },
      },
    );
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { headers: CORS }); }

  // MCP allows batch (JSON array of requests) or single (object).
  const requests = Array.isArray(body) ? body : [body];
  const responses = [] as unknown[];

  for (const raw of requests) {
    const parsed = parseJsonRpc(raw);
    if (!parsed.ok) {
      responses.push(parsed.response);
      continue;
    }
    serverLog("info", "mcp", "rpc", { method: parsed.req.method, actor: actor.email });
    const resp = await handleMcpRpc(actor, parsed.req);
    if (resp) responses.push(resp);
    // resp === null → notification, no response emitted.
  }

  // Batch shape: array in → array out (minus notifications). Single in
  // → single out. If everything was notifications, return 202.
  if (responses.length === 0) return new NextResponse(null, { status: 202, headers: CORS });
  if (Array.isArray(body)) return NextResponse.json(responses, { headers: CORS });
  return NextResponse.json(responses[0], { headers: CORS });
}

export const GET = withRequestLogging("api:mcp", getHandler);
export const POST = withRequestLogging("api:mcp", postHandler as never);
