/**
 * ADR-077 §2 — server-side destination resolution.
 *
 * The layering logic lives in destinationResolver.ts and is pure. This
 * module supplies its inputs from FUSE instead of the browser, so any
 * headless caller — an API route, a cron sweep, an MCP tool, the §6
 * conformance report — can answer "where is this record supposed to go"
 * without a client session.
 *
 * Before this existed, destination resolution was reachable only from
 * the video card: it read processing rules out of localStorage, so the
 * declared destination set was invisible to every server path. That is
 * why the bulk and backfill publishers post straight to
 * /api/youtube/upload (ADR-077 §Context) — they had no way to ask.
 *
 * Reads, never writes. Both files are the same ones the client-facing
 * endpoints serve:
 *   data/series-registry.json  — { entries, config }  (ADR-055 / ADR-075)
 *   data/rules.json            — { processingRules }  (ADR-014 / ADR-035)
 *
 * Server-only — never import from a client component.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { resolveDestinationsWith, type ResolvedDestinations, type ResolverInputs } from "./destinationResolver";
import type { SeriesRegistryConfig } from "./seriesRegistryClient";
import type { SeriesRegistryEntry } from "./youtubeTitleAlign";
import type { ProcessingRule } from "./processingRules";
import type { BackfillProfile } from "./backfill";
import type { VideoRecordJSON } from "./wasm";

const DATA_DIR = () => join(process.cwd(), "data");

/** Mirrors seriesRegistryClient's DEFAULT_CONFIG. Duplicated rather than
 *  imported as a value so this module pulls in no client code path; the
 *  toggle's meaning is documented on SeriesRegistryConfig.
 *
 *  ADR-077 §Decisions-resolved #2: existing deployments keep the YouTube
 *  fallback, so the default stays `true` here. New deployments ship it
 *  off via the stored config rather than by changing this constant. */
const DEFAULT_CONFIG: SeriesRegistryConfig = {
  youtube_fallback_when_no_series_match: true,
};

/** Read the series registry and its config knobs. Missing or malformed
 *  file → empty registry with default config, matching the client's
 *  fetch-failure behaviour so both surfaces degrade the same way. */
export async function readSeriesRegistryServer(): Promise<{
  entries: SeriesRegistryEntry[];
  config: SeriesRegistryConfig;
}> {
  try {
    const raw = await fs.readFile(join(DATA_DIR(), "series-registry.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      entries?: unknown;
      config?: Partial<SeriesRegistryConfig>;
    };
    return {
      entries: Array.isArray(parsed.entries) ? (parsed.entries as SeriesRegistryEntry[]) : [],
      config: {
        youtube_fallback_when_no_series_match:
          typeof parsed.config?.youtube_fallback_when_no_series_match === "boolean"
            ? parsed.config.youtube_fallback_when_no_series_match
            : DEFAULT_CONFIG.youtube_fallback_when_no_series_match,
      },
    };
  } catch {
    return { entries: [], config: { ...DEFAULT_CONFIG } };
  }
}

/** Read the stored processing rules. `data/rules.json` is the system of
 *  record (`/api/rules` serves it); localStorage on the client is only a
 *  cache of it. */
export async function readProcessingRulesServer(): Promise<ProcessingRule[]> {
  try {
    const raw = await fs.readFile(join(DATA_DIR(), "rules.json"), "utf-8");
    const parsed = JSON.parse(raw) as { processingRules?: unknown };
    return Array.isArray(parsed.processingRules) ? (parsed.processingRules as ProcessingRule[]) : [];
  } catch {
    return [];
  }
}

/**
 * Load every resolver input from disk once. Callers resolving a batch of
 * records should hold onto the result and pass it to
 * resolveDestinationsWith per record rather than re-reading both files
 * for each one — a catalog-wide conformance sweep would otherwise do two
 * FUSE reads per record.
 */
export async function loadResolverInputs(
  profile: BackfillProfile | null = null,
): Promise<ResolverInputs> {
  const [registry, rules] = await Promise.all([
    readSeriesRegistryServer(),
    readProcessingRulesServer(),
  ]);
  return { registry: registry.entries, rules, profile, config: registry.config };
}

/**
 * Resolve one record's destinations server-side. Convenience wrapper for
 * single-record callers; batch callers should use loadResolverInputs +
 * resolveDestinationsWith to avoid re-reading the input files.
 */
export async function resolveDestinationsServer(
  record: VideoRecordJSON,
  profile: BackfillProfile | null = null,
): Promise<ResolvedDestinations> {
  return resolveDestinationsWith(record, await loadResolverInputs(profile));
}
