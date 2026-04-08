import { NextRequest, NextResponse } from "next/server";
import { getMemorySnapshot, getMemoryAlerts } from "../../../lib/memoryMonitor";
import { withRequestLogging } from "../../../lib/serverLogger";

async function handler(req: NextRequest) {
  const url = new URL(req.url);
  const since = url.searchParams.get("since") ?? undefined;

  const memory = getMemorySnapshot();
  const alerts = getMemoryAlerts(since);

  return NextResponse.json({ memory, alerts });
}

export const GET = withRequestLogging("api:health", handler);
