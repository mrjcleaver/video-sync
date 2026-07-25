/**
 * ADR-055 — client-side helper for the series-registry endpoint.
 *
 * Cached for one page-load; call refreshSeriesRegistry() if a
 * mutation happens elsewhere and you need to see it immediately.
 */

import type { SeriesRegistryEntry } from "./youtubeTitleAlign";

let cache: SeriesRegistryEntry[] | null = null;
let inflight: Promise<SeriesRegistryEntry[]> | null = null;

async function fetchOnce(): Promise<SeriesRegistryEntry[]> {
  try {
    const res = await fetch("/api/series-registry", { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { entries?: SeriesRegistryEntry[] };
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

/** Get the current registry. Cached after the first successful fetch. */
export async function getSeriesRegistry(): Promise<SeriesRegistryEntry[]> {
  if (cache) return cache;
  if (!inflight) inflight = fetchOnce().then((v) => { cache = v; inflight = null; return v; });
  return inflight;
}

/** Force a re-fetch. Call after saving the registry via saveSeriesRegistry. */
export function refreshSeriesRegistry(): void {
  cache = null;
  inflight = null;
}

export async function saveSeriesRegistry(entries: SeriesRegistryEntry[]): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/series-registry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: (data as { error?: string }).error ?? `HTTP ${res.status}` };
    }
    cache = entries;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
