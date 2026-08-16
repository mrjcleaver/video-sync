/**
 * ADR-055 — client-side helper for the series-registry endpoint.
 *
 * Cached for one page-load; call refreshSeriesRegistry() if a
 * mutation happens elsewhere and you need to see it immediately.
 */

import type { SeriesRegistryEntry } from "./youtubeTitleAlign";

/** ADR-075 Phase 2 §Follow-up — registry-level config knobs. */
export interface SeriesRegistryConfig {
  /** When true (default), records not matching any series still get
   *  the YouTube fallback destination via profile default_privacy /
   *  global default. When false, no fallback: publish UI hides. */
  youtube_fallback_when_no_series_match: boolean;
}

const DEFAULT_CONFIG: SeriesRegistryConfig = {
  youtube_fallback_when_no_series_match: true,
};

let cache: SeriesRegistryEntry[] | null = null;
let configCache: SeriesRegistryConfig | null = null;
let inflight: Promise<SeriesRegistryEntry[]> | null = null;

async function fetchOnce(): Promise<SeriesRegistryEntry[]> {
  try {
    const res = await fetch("/api/series-registry", { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { entries?: SeriesRegistryEntry[]; config?: Partial<SeriesRegistryConfig> };
    configCache = {
      youtube_fallback_when_no_series_match:
        typeof data.config?.youtube_fallback_when_no_series_match === "boolean"
          ? data.config.youtube_fallback_when_no_series_match
          : DEFAULT_CONFIG.youtube_fallback_when_no_series_match,
    };
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    configCache = { ...DEFAULT_CONFIG };
    return [];
  }
}

/** Get the current registry. Cached after the first successful fetch. */
export async function getSeriesRegistry(): Promise<SeriesRegistryEntry[]> {
  if (cache) return cache;
  if (!inflight) inflight = fetchOnce().then((v) => { cache = v; inflight = null; return v; });
  return inflight;
}

/**
 * Synchronous accessor for the AppContext-warmed cache. Returns
 * [] until the first async fetch resolves. Suitable for
 * applyProcessingRules and other hot-path callers that can't
 * await; the cache is warmed once at boot by AppContext so by
 * the time any interaction runs it's populated.
 */
export function getSeriesRegistryCached(): SeriesRegistryEntry[] {
  return cache ?? [];
}

/** Get the config knobs synchronously from the cache. Returns the
 *  legacy-default config until the first fetch resolves. */
export function getSeriesRegistryConfigCached(): SeriesRegistryConfig {
  return configCache ?? { ...DEFAULT_CONFIG };
}

/** Force a re-fetch. Call after saving the registry via saveSeriesRegistry. */
export function refreshSeriesRegistry(): void {
  cache = null;
  configCache = null;
  inflight = null;
}

export async function saveSeriesRegistry(
  entries: SeriesRegistryEntry[],
  config?: SeriesRegistryConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const body: { entries: SeriesRegistryEntry[]; config?: SeriesRegistryConfig } = { entries };
    if (config) body.config = config;
    const res = await fetch("/api/series-registry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: (data as { error?: string }).error ?? `HTTP ${res.status}` };
    }
    cache = entries;
    if (config) configCache = config;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
