/**
 * ADR-058 Option D — client-side helper for /api/import-state.
 *
 * getImportState() — fetch current state; cached per page-load.
 *   Call refreshImportState() to invalidate.
 * saveSourceCheck(source, from, to) — POST after a successful fetch
 *   from a source-import panel. Widens the source's last-known
 *   range (see server route).
 */

export interface SourceCheckState {
  last_checked_at: string;   // ISO
  last_range_from: string;   // YYYY-MM-DD
  last_range_to: string;     // YYYY-MM-DD
}

export interface ImportStateSnapshot {
  sources: Record<string, SourceCheckState>;
}

let cache: ImportStateSnapshot | null = null;
let inflight: Promise<ImportStateSnapshot> | null = null;

async function fetchOnce(): Promise<ImportStateSnapshot> {
  try {
    const res = await fetch("/api/import-state", { cache: "no-store" });
    if (!res.ok) return { sources: {} };
    const data = await res.json() as Partial<ImportStateSnapshot>;
    return { sources: (data.sources ?? {}) as Record<string, SourceCheckState> };
  } catch {
    return { sources: {} };
  }
}

export async function getImportState(): Promise<ImportStateSnapshot> {
  if (cache) return cache;
  if (!inflight) inflight = fetchOnce().then((v) => { cache = v; inflight = null; return v; });
  return inflight;
}

export function refreshImportState(): void {
  cache = null;
  inflight = null;
}

/**
 * Report a successful source fetch. Fire-and-forget — the operator's
 * import flow doesn't wait on this. On success the local cache
 * updates optimistically so the Overview banner reflects it without
 * a round-trip.
 */
export async function saveSourceCheck(source: string, from: string, to: string): Promise<void> {
  try {
    const res = await fetch("/api/import-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, from, to }),
    });
    if (res.ok) {
      const data = await res.json() as ImportStateSnapshot;
      cache = data;
    }
  } catch {
    // Bookkeeping is best-effort; don't disturb the operator's flow.
  }
}

/** Is the given YYYY-MM-DD day within a source's known-checked range?
 *  Falsy if the source has never been checked or the date is out of range. */
export function dayWithinCheckRange(state: ImportStateSnapshot, source: string, day: string): boolean {
  const s = state.sources[source];
  if (!s) return false;
  return day >= s.last_range_from && day <= s.last_range_to;
}
