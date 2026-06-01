/**
 * ADR-046 — client-side memoised fetch of the current prompt version.
 * Used by SummaryLozenge to flag stale-prompt rows without every card
 * (50+ on the Overview) hammering /api/summary/prompt independently.
 *
 * One in-flight promise, 5-minute TTL. Tolerant of failure — returns
 * null on error so the lozenge just stops showing the "stale" hint.
 */

const TTL_MS = 5 * 60 * 1000;

interface Cached {
  version: number | null;
  fetchedAt: number;
}

let cached: Cached | null = null;
let inflight: Promise<number | null> | null = null;

export async function getCurrentPromptVersion(): Promise<number | null> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.version;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/summary/prompt", { cache: "no-store" });
      if (!res.ok) {
        cached = { version: null, fetchedAt: Date.now() };
        return null;
      }
      const data = await res.json() as { version?: number };
      const v = typeof data.version === "number" ? data.version : null;
      cached = { version: v, fetchedAt: Date.now() };
      return v;
    } catch {
      cached = { version: null, fetchedAt: Date.now() };
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Force a refresh on next read — call after the admin bumps the prompt. */
export function invalidateCurrentPromptVersion() {
  cached = null;
  inflight = null;
}
