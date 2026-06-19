/**
 * Persistent rejections for match suggestions.
 *
 * Two kinds of match suggestions exist:
 *   1. YouTube match  — a VideoRecord is suggested to be linked to an
 *      external YouTube video ID (Recover flow, ADR-016).
 *   2. Sibling match  — two VideoRecords are suggested to represent the
 *      same event via UpstreamLink(SameEvent) (ADR-033 dedupe).
 *
 * When the operator dismisses a suggestion, this module records that
 * rejection so the same pair is not re-suggested in future renders.
 *
 * Rejections are per-browser (localStorage). A deliberate accept via the
 * Recover/LinkUpstream flow takes precedence and clears the rejection
 * automatically on next save.
 */

const YT_KEY = "video-sync:rejected-yt-matches";
const SIBLING_KEY = "video-sync:rejected-sibling-matches";

type Bag = Record<string, true>;

function load(key: string): Bag {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function save(key: string, bag: Bag) {
  try { localStorage.setItem(key, JSON.stringify(bag)); } catch { /* full */ }
}

// ── YouTube match rejections ──────────────────────────────────────

function ytKey(videoId: string, youtubeId: string): string {
  return `${videoId}|${youtubeId}`;
}

export function rejectYouTubeMatch(videoId: string, youtubeId: string): void {
  const bag = load(YT_KEY);
  bag[ytKey(videoId, youtubeId)] = true;
  save(YT_KEY, bag);
}

export function isYouTubeMatchRejected(videoId: string, youtubeId: string): boolean {
  return load(YT_KEY)[ytKey(videoId, youtubeId)] === true;
}

// ── Sibling (cross-source SameEvent) rejections ───────────────────

/** Canonicalise pair so rejection is symmetric: sortKey(A,B) === sortKey(B,A). */
function siblingKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

export function rejectSiblingMatch(idA: string, idB: string): void {
  const bag = load(SIBLING_KEY);
  bag[siblingKey(idA, idB)] = true;
  save(SIBLING_KEY, bag);
}

export function isSiblingMatchRejected(idA: string, idB: string): boolean {
  return load(SIBLING_KEY)[siblingKey(idA, idB)] === true;
}
