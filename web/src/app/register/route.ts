/**
 * Root-path convention wrapper — forward POST /register to the real
 * endpoint at /api/mcp/oauth/register. See /app/authorize/route.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../lib/serverLogger";

export const dynamic = "force-dynamic";

function realOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host && !host.startsWith("0.0.0.0")) return `${proto}://${host}`;
  return process.env.NEXT_PUBLIC_MCP_PUBLIC_ORIGIN?.trim() || new URL(req.url).origin;
}

async function postHandler(req: NextRequest) {
  const target = `${realOrigin(req)}/api/mcp/oauth/register`;
  return NextResponse.redirect(target, 308);
}

export const POST = withRequestLogging("api:register-shim", postHandler);
