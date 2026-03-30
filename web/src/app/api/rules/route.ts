import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging } from "../../../lib/serverLogger";

const RULES_FILE = join(process.cwd(), "data", "rules.json");

interface RulesStore {
  processingRules?: unknown[];
  postProcessingRules?: unknown[];
  ingestionRules?: unknown[];
}

async function readRules(): Promise<RulesStore> {
  try {
    const raw = await fs.readFile(RULES_FILE, "utf-8");
    return JSON.parse(raw) as RulesStore;
  } catch {
    return {};
  }
}

async function writeRules(store: RulesStore) {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(RULES_FILE, JSON.stringify(store, null, 2), "utf-8");
}

async function getHandler() {
  return NextResponse.json(await readRules());
}

async function postHandler(req: NextRequest) {
  let body: RulesStore;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const current = await readRules();
  const updated: RulesStore = {
    ...current,
    ...(body.processingRules !== undefined && { processingRules: body.processingRules }),
    ...(body.postProcessingRules !== undefined && { postProcessingRules: body.postProcessingRules }),
    ...(body.ingestionRules !== undefined && { ingestionRules: body.ingestionRules }),
  };
  await writeRules(updated);
  return NextResponse.json(updated);
}

export const GET = withRequestLogging("api:rules", getHandler);
export const POST = withRequestLogging("api:rules", postHandler);
