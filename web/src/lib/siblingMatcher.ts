/**
 * Cross-source same-event sibling detector (ADR-033 §1).
 *
 * Given one VideoRecord, scan the rest of the catalog for records that
 * likely represent the SAME underlying meeting/event but were captured
 * on a different source platform (e.g. Zoom + Fireflies).
 *
 * Scoring heuristic (weighted):
 *   - Participant email overlap      (strong, 0.4)
 *   - Recording-start proximity      (strong, 0.3; within 60 min ideal)
 *   - Title token-set overlap        (medium, 0.3)
 *
 * Duration is deliberately NOT used: ADR-033 Observation 2 showed that
 * Zoom starts recording when the host hits record (often early) while
 * Fireflies joins at scheduled time, so durations diverge by minutes.
 *
 * Two records on the SAME source platform never qualify — they would
 * be a duplicate import, not a same-event sibling.
 */

import type { VideoRecordJSON } from "./wasm";

/** ADR-049 — relation the matcher recommends when auto-linking this pair. */
export type RecommendedRelation = "SameEvent" | "BroadcastedFrom";

/**
 * Platforms that can broadcast into YouTube Live (RTMP source side).
 * Adding Streamyard / OBS / Wirecast / Restream / Riverside etc. here
 * widens the BroadcastedFrom detection without touching scoring code.
 * Google Meet is not yet a broadcaster source — added when/if Meet
 * support lands.
 */
const BROADCASTER_PLATFORMS: ReadonlySet<string> = new Set(["Zoom", "Streamyard", "OBS", "Wirecast"]);

/** ADR-049 — tighter time gate for BroadcastedFrom auto-classification.
 *  RTMP relay delay is seconds, plus operators start broadcasts at the
 *  top of the hour (per operator note 2026-06-07), so 60 minutes is a
 *  comfortable bound. Beyond 60 min the pair stays SameEvent. */
const BROADCAST_MAX_DELTA_MIN = 60;

export interface SiblingCandidate {
  video: VideoRecordJSON;
  score: number;
  reasons: {
    participant_overlap: number;   // 0..1 Jaccard on emails
    time_delta_minutes: number | null;
    title_overlap: number;         // 0..1 token-set
  };
  /** ADR-049: recommended relation when auto-linking. */
  recommendedRelation: RecommendedRelation;
}

/**
 * ADR-049 — does this (target, candidate) pair look like a YouTube-Live
 * broadcast whose RTMP source was the candidate?
 *
 * Triggered when:
 *  - target is a YouTube-Live record (source_platform=YouTube + tag or
 *    metadata_extra.live_broadcast === "1")
 *  - candidate is on a known broadcaster platform
 *  - time delta within BROADCAST_MAX_DELTA_MIN (broadcasts start
 *    near-simultaneously with the source recording)
 *
 * Either direction can trigger — sibling matching runs from both sides.
 */
function isBroadcastFromPair(
  target: VideoRecordJSON,
  candidate: VideoRecordJSON,
  timeDeltaMin: number | null,
): boolean {
  const youtubeLive = (rec: VideoRecordJSON) =>
    rec.source_platform === "YouTube"
      && ((rec.tags ?? []).includes("youtube-live")
          || (rec.metadata_extra as { live_broadcast?: string } | null)?.live_broadcast === "1");

  const broadcaster = (rec: VideoRecordJSON) => BROADCASTER_PLATFORMS.has(rec.source_platform);

  const youtubeSide = youtubeLive(target) ? target : youtubeLive(candidate) ? candidate : null;
  const broadcasterSide = broadcaster(target) ? target : broadcaster(candidate) ? candidate : null;
  if (!youtubeSide || !broadcasterSide || youtubeSide === broadcasterSide) return false;

  if (timeDeltaMin === null || timeDeltaMin > BROADCAST_MAX_DELTA_MIN) return false;
  return true;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalise(a).split(" ").filter(Boolean));
  const tb = new Set(normalise(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

/** Extract lowercase email addresses from a participant string or list. */
function extractEmails(participants: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of participants) {
    const m = p.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    if (m) out.add(m[1].toLowerCase());
  }
  return out;
}

function participantJaccard(a: string[], b: string[]): number {
  const ea = extractEmails(a);
  const eb = extractEmails(b);
  if (ea.size === 0 || eb.size === 0) {
    // Fall back to display-name token overlap (weaker)
    return tokenOverlap(a.join(" "), b.join(" ")) * 0.7;
  }
  let inter = 0;
  for (const x of ea) if (eb.has(x)) inter++;
  const union = new Set([...ea, ...eb]).size;
  return union === 0 ? 0 : inter / union;
}

function timeDeltaMinutes(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (isNaN(ta) || isNaN(tb)) return null;
  return Math.abs(ta - tb) / 60000;
}

/** UTC calendar day key (YYYY-MM-DD) extracted from any Date-parseable string. */
function calendarDayUtc(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function sameCalendarDay(a: string | null, b: string | null): boolean {
  const da = calendarDayUtc(a);
  const db = calendarDayUtc(b);
  return da !== null && db !== null && da === db;
}

/**
 * Score temporal proximity. Tolerant of different date formats and
 * timezone-shifted timestamps: same UTC calendar day always gets at
 * least 0.6 even when the wallclock hours differ (e.g. a YouTube
 * Live broadcast's actualStartTime vs. a Fireflies meeting's
 * end-of-call timestamp on the same day).
 */
/**
 * The maximum gap in minutes that's still plausibly explainable by a
 * timezone offset. UTC+14 to UTC-12 = 26h of real-world span; we add
 * a small slack for DST transitions and Zoom-vs-Fireflies start/end
 * timestamp drift on long sessions, then round to a clean 30h.
 *
 * Beyond this, two recordings are on genuinely different days — even
 * perfect participant + title overlap shouldn't link them, because
 * recurring meetings (same hosts, same agenda template) would
 * false-positive every week. rankSiblingCandidates drops candidates
 * whose delta exceeds this gate before scoring.
 */
export const MAX_PLAUSIBLE_TIME_DELTA_MIN = 30 * 60;

function timeScore(target: string | null, candidate: string | null, deltaMin: number | null): number {
  if (deltaMin == null) return 0;
  if (deltaMin <= 10) return 1;            // near-simultaneous
  if (deltaMin <= 60) return 0.85;         // within an hour
  if (deltaMin <= 4 * 60) return 0.7;      // four hours
  if (sameCalendarDay(target, candidate)) return 0.6;  // same UTC day
  if (deltaMin <= 24 * 60) return 0.4;     // 24 h delta but cross-day in UTC (timezone shift)
  // Beyond 24h is reachable only when the caller bypasses the hard
  // MAX_PLAUSIBLE_TIME_DELTA_MIN gate; we keep a residual tier so
  // diagnostic uses of timeScore() outside rankSiblingCandidates
  // still degrade gracefully rather than dropping to 0.
  if (deltaMin <= MAX_PLAUSIBLE_TIME_DELTA_MIN) return 0.2;
  return 0;
}

export function rankSiblingCandidates(
  target: VideoRecordJSON,
  all: VideoRecordJSON[],
  limit = 3,
): SiblingCandidate[] {
  const targetRecorded = target.recorded_at ?? target.indexed_at;
  const candidates: SiblingCandidate[] = [];

  for (const v of all) {
    if (v.id === target.id) continue;
    if (v.source_platform === target.source_platform) continue;
    // Published-to-YouTube matches belong to the ADR-016 Recover flow, not here
    if (v.source_platform === "YouTube") continue;

    const candidateRecorded = v.recorded_at ?? v.indexed_at;
    const participant_overlap = participantJaccard(target.participants ?? [], v.participants ?? []);
    const time_delta_minutes = timeDeltaMinutes(targetRecorded, candidateRecorded);

    // Hard gate: a date gap exceeding the max plausible timezone
    // difference is a strong NOT-match signal that should override
    // participant + title overlap. Recurring meetings (same hosts,
    // same agenda template, same Zoom room) would otherwise
    // false-positive against every other instance of themselves.
    if (time_delta_minutes !== null && time_delta_minutes > MAX_PLAUSIBLE_TIME_DELTA_MIN) {
      continue;
    }

    const title_overlap = tokenOverlap(target.title, v.title);
    const t = timeScore(targetRecorded, candidateRecorded, time_delta_minutes);

    // Re-allocate weights when a signal is genuinely unavailable so
    // sources without participant metadata (e.g. YouTube Live broadcasts,
    // Zoom recordings before joining) aren't capped at 0.6 by the missing
    // 0.4 participant slot. Title and time pick up the slack.
    const participantsAvailable =
      (target.participants?.length ?? 0) > 0 && (v.participants?.length ?? 0) > 0;
    const timeAvailable = time_delta_minutes !== null;

    let pW = 0.4, tW = 0.3, titleW = 0.3;
    if (!participantsAvailable) {
      // Redistribute equally to time + title (or all to title if time also missing)
      tW += timeAvailable ? 0.2 : 0;
      titleW += timeAvailable ? 0.2 : 0.4;
      pW = 0;
    }
    if (!timeAvailable) {
      titleW += tW;
      tW = 0;
    }

    const score = participant_overlap * pW + t * tW + title_overlap * titleW;
    if (score <= 0) continue;

    const recommendedRelation: RecommendedRelation =
      isBroadcastFromPair(target, v, time_delta_minutes) ? "BroadcastedFrom" : "SameEvent";
    candidates.push({
      video: v,
      score,
      reasons: { participant_overlap, time_delta_minutes, title_overlap },
      recommendedRelation,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
