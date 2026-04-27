import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging } from "../../../../lib/serverLogger";

// ADR-035 Level 2 — server-side transcript map.
//
// Stored separately from data/catalog.json so transcript blobs (often
// 100KB+ each from Fireflies) don't bloat the catalog list payload.
// Shape: { [recordId]: <transcript-text> }

const TRANSCRIPTS_FILE = join(process.cwd(), "data", "transcripts.json");

type TranscriptStore = Record<string, string>;

// In-process mutex (see ../route.ts for rationale).
let writeQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn);
  writeQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function readTranscripts(): Promise<TranscriptStore> {
  try {
    const raw = await fs.readFile(TRANSCRIPTS_FILE, "utf-8");
    return JSON.parse(raw) as TranscriptStore;
  } catch {
    return {};
  }
}

async function writeTranscripts(store: TranscriptStore) {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(TRANSCRIPTS_FILE, JSON.stringify(store), "utf-8");
}

async function getHandler(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  const store = await readTranscripts();
  if (id) {
    const text = store[id];
    if (text === undefined) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ id, text });
  }
  return NextResponse.json(store);
}

async function postHandler(req: NextRequest) {
  let body: { id?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id || typeof body.id !== "string") {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  if (typeof body.text !== "string") {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  const tid = body.id;
  const text = body.text;
  return withLock(async () => {
    const current = await readTranscripts();
    current[tid] = text;
    await writeTranscripts(current);
    return NextResponse.json({ ok: true, id: tid });
  });
}

async function deleteHandler(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id query param required" }, { status: 400 });
  }
  return withLock(async () => {
    const current = await readTranscripts();
    delete current[id];
    await writeTranscripts(current);
    return NextResponse.json({ ok: true, id });
  });
}

export const GET = withRequestLogging("api:catalog/transcripts", getHandler);
export const POST = withRequestLogging("api:catalog/transcripts", postHandler);
export const DELETE = withRequestLogging("api:catalog/transcripts", deleteHandler);
