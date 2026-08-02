/**
 * Client-safe transcript slicing helpers. Kept out of summaryGenerate.ts
 * so client components can import them without pulling in the
 * server-side Secret Manager / OpenRouter fetch machinery.
 *
 * Both operate on the [HH:MM:SS] marker convention emitted by
 * Kaltura caption import, Fireflies fetch and Zoom VTT flatten.
 * Marker forms accepted: [HH:MM:SS], [H:MM:SS], [MM:SS], [M:SS].
 */

const MARKER_RE = /^\s*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/;

function markerSeconds(match: RegExpMatchArray): number {
  return match[3] !== undefined
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Drop all transcript lines whose leading marker precedes `startSecs`.
 * Non-positive `startSecs` or a transcript with no markers returns the
 * input untouched (so we never over-truncate).
 */
export function sliceTranscriptFromSeconds(text: string, startSecs: number): string {
  if (!text || startSecs <= 0) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARKER_RE);
    if (!m) continue;
    if (markerSeconds(m) >= startSecs) return lines.slice(i).join("\n");
  }
  return text;
}

/**
 * Tail-side companion — drop all transcript lines whose leading
 * marker is at or after `endSecs`. Pair with sliceTranscriptFromSeconds
 * to isolate the scheduled programme.
 */
export function sliceTranscriptToSeconds(text: string, endSecs: number): string {
  if (!text || endSecs <= 0) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARKER_RE);
    if (!m) continue;
    if (markerSeconds(m) >= endSecs) return lines.slice(0, i).join("\n");
  }
  return text;
}
