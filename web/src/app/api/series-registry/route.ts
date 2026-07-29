/**
 * ADR-055 — Series-registry persistence.
 *
 * A list of {series_name, pattern} entries used by the YouTube
 * title-alignment resolver when no paired canonical exists.
 * Persisted server-side (FUSE-mounted GCS bucket) per the ADR-031
 * pattern so it's shared across operators.
 *
 * Shape on disk (data/series-registry.json):
 *   { entries: [ { series_name: "AI Hackerspace Live", pattern: "^AI Hackerspace Live" }, ... ] }
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging } from "../../../lib/serverLogger";

const REGISTRY_FILE = join(process.cwd(), "data", "series-registry.json");

interface RegistryEntry {
  series_name: string;
  pattern: string;
  /** Optional per-series Discord webhook URL used by the
   *  "Push to Discord" affordance on VideoCard clips + summaries. */
  discord_channel?: string;
}

interface RegistryStore {
  entries: RegistryEntry[];
}

async function readRegistry(): Promise<RegistryStore> {
  try {
    const raw = await fs.readFile(REGISTRY_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RegistryStore>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

async function writeRegistry(store: RegistryStore) {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(REGISTRY_FILE, JSON.stringify(store, null, 2), "utf-8");
}

async function getHandler() {
  return NextResponse.json(await readRegistry());
}

async function postHandler(req: NextRequest) {
  let body: Partial<RegistryStore>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.entries)) {
    return NextResponse.json({ error: "entries array required" }, { status: 400 });
  }
  // Validate each entry's regex compiles — reject the whole payload
  // if any is malformed so we never persist unusable patterns.
  for (const [i, entry] of body.entries.entries()) {
    if (!entry || typeof entry.series_name !== "string" || !entry.series_name.trim()) {
      return NextResponse.json({ error: `entry[${i}].series_name must be a non-empty string` }, { status: 400 });
    }
    if (typeof entry.pattern !== "string") {
      return NextResponse.json({ error: `entry[${i}].pattern must be a string` }, { status: 400 });
    }
    try {
      new RegExp(entry.pattern, "i");
    } catch (err) {
      return NextResponse.json({ error: `entry[${i}].pattern is not a valid regex: ${err instanceof Error ? err.message : String(err)}` }, { status: 400 });
    }
    if (entry.discord_channel != null) {
      if (typeof entry.discord_channel !== "string") {
        return NextResponse.json({ error: `entry[${i}].discord_channel must be a string` }, { status: 400 });
      }
      const trimmed = entry.discord_channel.trim();
      if (trimmed.length > 0 && !/^https:\/\/(?:.*\.)?discord(?:app)?\.com\//i.test(trimmed)) {
        return NextResponse.json({ error: `entry[${i}].discord_channel must be a Discord webhook URL (starts with https://discord.com/ or https://discordapp.com/)` }, { status: 400 });
      }
    }
  }
  const store: RegistryStore = { entries: body.entries };
  await writeRegistry(store);
  return NextResponse.json(store);
}

export const GET = withRequestLogging("api:series-registry", getHandler);
export const POST = withRequestLogging("api:series-registry", postHandler);
