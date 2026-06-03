/**
 * Client-side cache of the authorized YouTube channel's uploads, used by
 * the Recover from YouTube lookup. Populated on demand; 1-hour TTL.
 *
 * ADR-016 addendum (Recover auto-lookup).
 */

import { setPrivacy, normalisePrivacy } from "./youtubePrivacyCache";

const STORAGE_KEY = "video-sync:yt-uploads";
const TTL_MS = 60 * 60 * 1000; // 1 hour

export interface YouTubeUpload {
  id: string;
  title: string;
  publishedAt: string;
  privacyStatus?: string;
}

interface CachedUploads {
  channelId: string;
  channelTitle: string;
  fetchedAt: string;
  uploads: YouTubeUpload[];
}

function loadCache(): CachedUploads | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUploads;
    const age = Date.now() - new Date(parsed.fetchedAt).getTime();
    if (age > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(data: CachedUploads) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* full */ }
}

export function getCachedUploads(): CachedUploads | null {
  return loadCache();
}

export function clearUploadsCache() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * Fetch (or reuse cached) channel uploads. Also populates privacy cache
 * entries for every upload that came back with a privacyStatus.
 */
export async function fetchChannelUploads(force = false): Promise<CachedUploads> {
  if (!force) {
    const cached = loadCache();
    if (cached) return cached;
  }

  let creds: { refreshToken?: string; clientId?: string; clientSecret?: string } = {};
  try {
    const raw = localStorage.getItem("video-sync:connections");
    const conn = raw ? JSON.parse(raw) : {};
    creds = conn["YouTube"]?.credentials ?? {};
  } catch { /* ignore */ }
  if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) {
    throw new Error("YouTube not authorised. Configure in Connections.");
  }

  const res = await fetch("/api/youtube/channel-uploads", {
    headers: {
      "x-youtube-refresh-token": creds.refreshToken,
      "x-youtube-client-id": creds.clientId,
      "x-youtube-client-secret": creds.clientSecret,
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `Uploads lookup failed (${res.status})`);
  }
  const data = await res.json() as { channelId: string; channelTitle: string; uploads: YouTubeUpload[] };

  // Seed the privacy cache while we have the data
  for (const u of data.uploads) {
    if (u.privacyStatus) setPrivacy(u.id, normalisePrivacy(u.privacyStatus));
  }

  const cached: CachedUploads = {
    channelId: data.channelId,
    channelTitle: data.channelTitle,
    fetchedAt: new Date().toISOString(),
    uploads: data.uploads,
  };
  saveCache(cached);
  return cached;
}

// ── Fuzzy matching ──────────────────────────────────────────────────────

/** Normalise a title for comparison: lowercase, strip punctuation, collapse whitespace. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")  // punctuation and symbols → space
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-set overlap ratio (Jaccard-ish). Returns 0..1. */
function tokenScore(a: string, b: string): number {
  const ta = new Set(normalise(a).split(" ").filter(Boolean));
  const tb = new Set(normalise(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

export interface MatchCandidate {
  upload: YouTubeUpload;
  score: number;      // 0..1 final score
  titleScore: number; // token-overlap 0..1
  dateDeltaDays: number | null;
}

/**
 * Hard upper bound on plausible "recorded → published" lag. Operators
 * routinely upload weeks after recording (backfill orchestrator alone
 * can stretch this to a month), but beyond 90 days the YouTube upload
 * almost certainly belongs to a *different* instance of the same
 * recurring meeting. Candidates past this threshold are dropped before
 * scoring so a perfect-title match can't false-positive against
 * historical uploads.
 *
 * Parallel to MAX_PLAUSIBLE_TIME_DELTA_MIN in siblingMatcher.ts —
 * different semantic (record-vs-record there, record-vs-publish here)
 * so the value differs, but the principle is identical: a date gap
 * past plausibility is a strong NOT-match signal that should override
 * other features.
 */
export const MAX_PLAUSIBLE_PUBLISH_LAG_DAYS = 90;

/**
 * Date-boost tier table. A close upload is a strong corroborating
 * signal; a distant one (within the plausibility window) is a weak
 * negative signal that pushes the total below the auto-suggest
 * threshold even on a perfect title overlap.
 *
 * With titleScore ∈ [0, 1] weighted at 0.7, a perfect title contributes
 * 0.7. The auto-suggest banner threshold is 0.7. So a >30-day delta
 * needs to subtract at least 0.01 to keep recurring-meeting false
 * positives out of the auto-suggest banner; -0.15 leaves comfortable
 * headroom and still allows an operator-set bar below to surface the
 * candidate in manual recovery.
 */
function dateBoost(deltaDays: number): number {
  if (deltaDays <= 1) return 0.30;
  if (deltaDays <= 7) return 0.20;
  if (deltaDays <= 30) return 0.10;
  // 30-90 days: negative — within plausibility but past the typical
  // publish-lag of the operators' workflow. Suppresses auto-suggest;
  // remains discoverable in manual "Recover from YouTube" lookups.
  return -0.15;
}

/**
 * Rank a channel's uploads against a candidate title (+ optional recorded date).
 * Returns top N candidates sorted by score descending.
 */
export function rankCandidates(
  uploads: YouTubeUpload[],
  title: string,
  recordedAt: string | null,
  limit = 5,
): MatchCandidate[] {
  const recDate = recordedAt ? new Date(recordedAt).getTime() : null;
  const scored: MatchCandidate[] = [];
  for (const upload of uploads) {
    const titleScore = tokenScore(title, upload.title);
    let dateDeltaDays: number | null = null;
    let boost = 0;
    if (recDate && upload.publishedAt) {
      const pub = new Date(upload.publishedAt).getTime();
      dateDeltaDays = Math.abs(pub - recDate) / 86400000;
      // Hard gate: past the plausibility window, the upload is
      // almost certainly a different recording — drop entirely so
      // it can't surface as a high-confidence match.
      if (dateDeltaDays > MAX_PLAUSIBLE_PUBLISH_LAG_DAYS) continue;
      boost = dateBoost(dateDeltaDays);
    }
    // Clamp to [0, 1] so a strongly-penalised candidate doesn't go
    // negative and break downstream "score > 0" filters.
    const score = Math.max(0, Math.min(1, titleScore * 0.7 + boost));
    scored.push({ upload, score, titleScore, dateDeltaDays });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).filter(c => c.score > 0);
}
