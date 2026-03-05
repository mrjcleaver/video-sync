import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging } from "../../../../lib/serverLogger";

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

function maybeReset(s: ServerState): ServerState {
  const today = todayUtc();
  if (s.last_reset_date !== today) {
    return { uploads_today: 0, last_reset_date: today };
  }
  return s;
}

async function getHandler() {
  const s = maybeReset(await readState());
  await writeState(s);
  return NextResponse.json(s);
}

async function postHandler(req: NextRequest) {

  let body: { increment?: boolean; uploads_today?: number; last_reset_date?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const s = maybeReset(await readState());

  if (body.increment) {
    s.uploads_today += 1;
  } else {
    if (typeof body.uploads_today === "number") s.uploads_today = body.uploads_today;
    if (body.last_reset_date) s.last_reset_date = body.last_reset_date;
  }

  await writeState(s);
  return NextResponse.json(s);
}

export const GET = withRequestLogging("api:backfill/state", getHandler);
export const POST = withRequestLogging("api:backfill/state", postHandler);
