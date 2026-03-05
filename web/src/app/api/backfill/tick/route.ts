import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

const STATE_FILE = join(process.cwd(), "data", "backfill-state.json");

interface ServerState {
  uploads_today: number;
  last_reset_date: string;
}

async function readState(): Promise<ServerState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw) as ServerState;
  } catch {
    return { uploads_today: 0, last_reset_date: "" };
  }
}

async function writeState(s: ServerState) {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(s), "utf-8");
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

interface TickRequest {
  max_uploads_per_day: number;
  window_start_hour: number;
  queue: string[]; // ordered video IDs, oldest-queued first
}

/** POST /api/backfill/tick (internal — wrapped by withRequestLogging below)
 *  Checks server-side quota state, returns the next video ID to upload (if any).
 *  Does NOT trigger the actual upload — the client does that after receiving next_id.
 */
async function handler(req: NextRequest) {
  let body: TickRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { max_uploads_per_day, window_start_hour = 0, queue = [] } = body;

  let s = await readState();
  const today = todayUtc();
  if (s.last_reset_date !== today) {
    s = { uploads_today: 0, last_reset_date: today };
    await writeState(s);
  }

  const nowHour = new Date().getUTCHours();
  const window_open = nowHour >= window_start_hour;

  if (!window_open) {
    return NextResponse.json({
      can_upload: false,
      next_id: null,
      uploads_today: s.uploads_today,
      quota_limit: max_uploads_per_day,
      window_open: false,
      reason: `Upload window opens at ${String(window_start_hour).padStart(2, "0")}:00 UTC`,
    });
  }

  if (s.uploads_today >= max_uploads_per_day) {
    return NextResponse.json({
      can_upload: false,
      next_id: null,
      uploads_today: s.uploads_today,
      quota_limit: max_uploads_per_day,
      window_open: true,
      reason: `Daily quota reached (${s.uploads_today}/${max_uploads_per_day})`,
    });
  }

  const next_id = queue[0] ?? null;
  serverLog("info", "backfill:tick", "tick", {
    can_upload: next_id !== null,
    uploads_today: s.uploads_today,
    quota_limit: max_uploads_per_day,
    queue_depth: queue.length,
    rid: req.headers.get("x-request-id") ?? "n/a",
  });
  return NextResponse.json({
    can_upload: next_id !== null,
    next_id,
    uploads_today: s.uploads_today,
    quota_limit: max_uploads_per_day,
    window_open: true,
    reason: next_id ? undefined : "Queue is empty",
  });
}

export const POST = withRequestLogging("api:backfill/tick", handler);
