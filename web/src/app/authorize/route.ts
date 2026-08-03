/**
 * Root-path convention wrapper. Some MCP clients (including Claude
 * Desktop as of Aug 2026) ignore the discovery metadata and probe
 * conventional OAuth 2.1 paths (`/authorize`, `/token`, `/register`)
 * at the connector URL's origin. Forward to the real endpoint at
 * `/api/mcp/oauth/authorize` (which then chains to the main IAP
 * service for browser consent).
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../lib/serverLogger";

export const dynamic = "force-dynamic";

function realOrigin(req: NextRequest): string {
  // Cloud Run without a load balancer surfaces the internal
  // 0.0.0.0:8080 as new URL(req.url).origin. Prefer the forwarded
  // proto+host, then the env override.
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host && !host.startsWith("0.0.0.0")) return `${proto}://${host}`;
  return process.env.NEXT_PUBLIC_MCP_MAIN_ORIGIN?.trim()
      || process.env.NEXT_PUBLIC_MCP_PUBLIC_ORIGIN?.trim()
      || new URL(req.url).origin;
}

async function getHandler(req: NextRequest) {
  const url = new URL(req.url);
  const target = new URL(`${realOrigin(req)}/api/mcp/oauth/authorize`);
  for (const [k, v] of url.searchParams.entries()) target.searchParams.set(k, v);
  return NextResponse.redirect(target.toString(), 302);
}

async function postHandler(req: NextRequest) {
  const url = new URL(req.url);
  const target = new URL(`${realOrigin(req)}/api/mcp/oauth/authorize`);
  for (const [k, v] of url.searchParams.entries()) target.searchParams.set(k, v);
  return NextResponse.redirect(target.toString(), 307);
}

export const GET = withRequestLogging("api:authorize-shim", getHandler);
export const POST = withRequestLogging("api:authorize-shim", postHandler);
