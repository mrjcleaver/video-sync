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

export interface SiblingCandidate {
  video: VideoRecordJSON;
  score: number;
  reasons: {
    participant_overlap: number;   // 0..1 Jaccard on emails
    time_delta_minutes: number | null;
    title_overlap: number;         // 0..1 token-set
  };
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

function timeScore(deltaMin: number | null): number {
  if (deltaMin == null) return 0;
  if (deltaMin <= 10) return 1;       // near-simultaneous → full credit
  if (deltaMin <= 60) return 1 - (deltaMin - 10) / 50 * 0.5;  // 60 min → 0.5
  if (deltaMin <= 240) return 0.25;   // same half-day
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

    const participant_overlap = participantJaccard(target.participants ?? [], v.participants ?? []);
    const time_delta_minutes = timeDeltaMinutes(targetRecorded, v.recorded_at ?? v.indexed_at);
    const title_overlap = tokenOverlap(target.title, v.title);
    const t = timeScore(time_delta_minutes);

    const score = participant_overlap * 0.4 + t * 0.3 + title_overlap * 0.3;
    if (score <= 0) continue;

    candidates.push({
      video: v,
      score,
      reasons: { participant_overlap, time_delta_minutes, title_overlap },
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
