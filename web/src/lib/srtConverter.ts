/**
 * Convert SRT / WebVTT subtitle text into the `[HH:MM:SS] line` format
 * the ADR-046 summary prompt expects.
 *
 * Handles both:
 *   - SRT (commas in timestamps:    00:01:23,456 --> 00:01:28,000)
 *   - WebVTT (dots in timestamps:   00:01:23.456 --> 00:01:28.000)
 *
 * Discards cue numbers, blank separators, and "WEBVTT" headers.
 * Merges multi-line cue text into a single space-joined line per cue.
 */

const CUE_TIMESTAMP_RE = /^(\d{1,2}):(\d{2}):(\d{2})[.,]\d{1,3}\s+-->/;

function hhmmss(h: string, m: string, s: string): string {
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:${s.padStart(2, "0")}`;
}

export function captionsToTranscript(raw: string): string {
  // Strip BOM if present (common from Kaltura serve responses).
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const lines = raw.split(/\r?\n/);
  const out: string[] = [];

  let currentTime: string | null = null;
  let buffer: string[] = [];

  function flush() {
    if (currentTime && buffer.length > 0) {
      const text = buffer.join(" ").trim().replace(/\s+/g, " ");
      if (text) out.push(`[${currentTime}] ${text}`);
    }
    buffer = [];
    currentTime = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^WEBVTT/i.test(line)) continue;
    // Discard cue numbers (a bare integer on its own line, SRT style).
    if (/^\d+$/.test(line) && currentTime === null && buffer.length === 0) {
      continue;
    }
    const m = line.match(CUE_TIMESTAMP_RE);
    if (m) {
      flush();
      currentTime = hhmmss(m[1], m[2], m[3]);
      continue;
    }
    if (currentTime) {
      // Strip simple inline VTT tags (<v Speaker> …, <i> tags etc.)
      buffer.push(line.replace(/<[^>]+>/g, ""));
    }
  }
  flush();

  return out.join("\n");
}
