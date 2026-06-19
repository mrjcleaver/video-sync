/**
 * Client-side cache of Kaltura presence keyed by catalog record id.
 * Populated from /api/kaltura/presence-batch responses.
 * Mirrors the shape and TTL of `youtubePrivacyCache`.
 *
 * ADR-044: a record is "on Kaltura" if any of:
 *   1. locations[] contains a Kaltura entry (definitive — we know about it)
 *   2. This cache holds a matched entry (we asked Kaltura and got an answer)
 *   3. Otherwise: unknown (caller can render a "?" lozenge)
 *
 * Sources (2) are populated by the Fill Kaltura status flow in the Overview.
 */

const STORAGE_KEY = "video-sync:kaltura-presence";

export type KalturaState = "ready" | "processing" | "live" | "absent" | "unknown";
export type KalturaMatchBy = "referenceId" | "footer" | "fuzzy";

export interface KalturaPresence {
  state: KalturaState;
  entryId?: string;
  playerUrl?: string;
  matchedBy?: KalturaMatchBy;
  matchScore?: number;
  checkedAt: string;
}

type Cache = Record<string, KalturaPresence>;

const ONE_HOUR_MS = 60 * 60 * 1000;

function load(): Cache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function save(cache: Cache) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full — best effort
  }
}

/** Read presence for a catalog record id. Returns null if not cached or expired. */
export function getPresence(recordId: string): KalturaPresence | null {
  const cache = load();
  const entry = cache[recordId];
  if (!entry) return null;
  const age = Date.now() - new Date(entry.checkedAt).getTime();
  if (age > ONE_HOUR_MS) return null;
  return entry;
}

/** Read presence ignoring TTL — used for legacy hydration paths. */
export function getPresenceUnconditional(recordId: string): KalturaPresence | null {
  return load()[recordId] ?? null;
}

/** Write presence for a catalog record id. */
export function setPresence(recordId: string, presence: Omit<KalturaPresence, "checkedAt"> & { checkedAt?: string }) {
  const cache = load();
  cache[recordId] = { ...presence, checkedAt: presence.checkedAt ?? new Date().toISOString() };
  save(cache);
}

/** Bulk write — used by the Fill Kaltura status flow. */
export function setPresenceBulk(entries: Record<string, KalturaPresence>) {
  const cache = load();
  for (const [id, p] of Object.entries(entries)) {
    cache[id] = p;
  }
  save(cache);
}

/** Read all cached presence entries (for debugging or bulk views). */
export function getAllPresence(): Cache {
  return load();
}
