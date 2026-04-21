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
  const scored: MatchCandidate[] = uploads.map(upload => {
    const titleScore = tokenScore(title, upload.title);
    let dateDeltaDays: number | null = null;
    let dateBoost = 0;
    if (recDate && upload.publishedAt) {
      const pub = new Date(upload.publishedAt).getTime();
      dateDeltaDays = Math.abs(pub - recDate) / 86400000;
      // Boost for close dates: 1.0x at 0 days, 0.5x at 30 days, 0 beyond 180
      if (dateDeltaDays <= 180) {
        dateBoost = Math.max(0, 1 - dateDeltaDays / 180) * 0.3;
      }
    }
    const score = titleScore * 0.7 + dateBoost;
    return { upload, score, titleScore, dateDeltaDays };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).filter(c => c.score > 0);
}
