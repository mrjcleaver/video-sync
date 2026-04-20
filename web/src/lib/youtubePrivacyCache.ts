/**
 * Client-side cache of YouTube privacy status keyed by YouTube video ID.
 * Populated from /api/youtube/status responses (e.g. from VideoCard's "Check Status").
 * Persisted to localStorage so the Overview can colour-code YouTube badges
 * without re-querying the API on every render.
 *
 * ADR-012 addendum (privacy status tracking).
 */

const STORAGE_KEY = "video-sync:yt-privacy";

export type PrivacyStatus = "public" | "unlisted" | "private" | "unknown";

interface CacheEntry {
  privacy: PrivacyStatus;
  checked_at: string;
}

type Cache = Record<string, CacheEntry>;

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

/** Read privacy for a YouTube video id. Returns null if not cached. */
export function getPrivacy(youtubeId: string): PrivacyStatus | null {
  const cache = load();
  return cache[youtubeId]?.privacy ?? null;
}

/** Write privacy for a YouTube video id. */
export function setPrivacy(youtubeId: string, privacy: PrivacyStatus) {
  const cache = load();
  cache[youtubeId] = { privacy, checked_at: new Date().toISOString() };
  save(cache);
}

/** Read all cached privacy entries (for debugging or bulk views). */
export function getAllPrivacy(): Cache {
  return load();
}

/** Normalise an arbitrary string to PrivacyStatus enum. */
export function normalisePrivacy(s: string | null | undefined): PrivacyStatus {
  if (s === "public" || s === "unlisted" || s === "private") return s;
  return "unknown";
}
