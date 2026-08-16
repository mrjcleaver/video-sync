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
  /** ADR-060 — scheduled show window (all three or none). */
  scheduled_start_local?: string;
  scheduled_end_local?: string;
  scheduled_timezone?: string;
}

interface RegistryConfig {
  /** ADR-075 Phase 2 §Follow-up — when true (legacy default), a
   *  record whose title matches no series still gets a YouTube
   *  destination (via profile default_privacy / global default).
   *  When false, no fallback: the record shows an advisory and
   *  no publish action until it's covered by a series with
   *  explicit destinations. */
  youtube_fallback_when_no_series_match: boolean;
}

interface RegistryStore {
  entries: RegistryEntry[];
  config?: RegistryConfig;
}

const DEFAULT_CONFIG: RegistryConfig = {
  youtube_fallback_when_no_series_match: true,
};

async function readRegistry(): Promise<RegistryStore> {
  try {
    const raw = await fs.readFile(REGISTRY_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RegistryStore>;
    const config: RegistryConfig = {
      youtube_fallback_when_no_series_match:
        typeof parsed.config?.youtube_fallback_when_no_series_match === "boolean"
          ? parsed.config.youtube_fallback_when_no_series_match
          : DEFAULT_CONFIG.youtube_fallback_when_no_series_match,
    };
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      config,
    };
  } catch {
    return { entries: [], config: { ...DEFAULT_CONFIG } };
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
    // ADR-060 — either all three scheduled_* fields are set or none.
    // Enforcing here saves the derivation code from partial state.
    const scheduledCount = (["scheduled_start_local","scheduled_end_local","scheduled_timezone"] as const)
      .filter(k => typeof entry[k] === "string" && (entry[k] as string).trim().length > 0).length;
    if (scheduledCount > 0 && scheduledCount < 3) {
      return NextResponse.json({ error: `entry[${i}] — scheduled_start_local, scheduled_end_local, and scheduled_timezone must all be set together (or all left blank)` }, { status: 400 });
    }
    if (scheduledCount === 3) {
      const hhmmRe = /^([01]?\d|2[0-3]):[0-5]\d$/;
      if (!hhmmRe.test(entry.scheduled_start_local!.trim())) {
        return NextResponse.json({ error: `entry[${i}].scheduled_start_local must be "HH:MM" 24-hour (e.g. "12:00")` }, { status: 400 });
      }
      if (!hhmmRe.test(entry.scheduled_end_local!.trim())) {
        return NextResponse.json({ error: `entry[${i}].scheduled_end_local must be "HH:MM" 24-hour (e.g. "13:30")` }, { status: 400 });
      }
      // Best-effort IANA validation via Intl. Bad zone → catch, reject.
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: entry.scheduled_timezone!.trim() });
      } catch {
        return NextResponse.json({ error: `entry[${i}].scheduled_timezone must be a valid IANA zone (e.g. "America/New_York")` }, { status: 400 });
      }
    }
  }
  // ADR-075 Phase 2 follow-up — carry the youtube_fallback toggle
  // through if the client sent one; otherwise preserve the stored
  // value so a fields-only save doesn't clobber the config.
  let config: RegistryConfig;
  const inbound = (body as Partial<RegistryStore>).config;
  if (inbound && typeof inbound.youtube_fallback_when_no_series_match === "boolean") {
    config = { youtube_fallback_when_no_series_match: inbound.youtube_fallback_when_no_series_match };
  } else {
    const prior = await readRegistry();
    config = prior.config ?? { ...DEFAULT_CONFIG };
  }
  const store: RegistryStore = { entries: body.entries, config };
  await writeRegistry(store);
  return NextResponse.json(store);
}

export const GET = withRequestLogging("api:series-registry", getHandler);
export const POST = withRequestLogging("api:series-registry", postHandler);
