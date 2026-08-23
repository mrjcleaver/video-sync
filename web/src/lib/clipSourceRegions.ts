/**
 * ADR-062 — turn a summary Doc's markdown into a set of merged,
 * sorted (start, end) regions for the stitched-source clip
 * pipeline. Pure functions; the actual ffmpeg extract + concat +
 * upload lives in a server route that composes this with the
 * source video.
 *
 * Regions are seconds relative to the source recording's t=0.
 */

/** A [start, end] window in source-video seconds. */
export interface Region {
  start_sec: number;
  end_sec: number;
  /** Human-readable origin tag — "main_show", "M:0" (Key Moment
   *  index 0), "C:2" (Chat-Sparked index 2), etc. Used in the
   *  manifest sidecar so a clip's stitched offset can be
   *  attributed to a specific summary section. */
  origin: string;
}

export interface RegionSet {
  regions: Region[];
  /** Total stitched duration (sum of merged region widths) in
   *  seconds. This is what Opus will bill against. */
  total_stitched_sec: number;
  /** For UX: the shape of the input, useful for the modal preview
   *  ("3 highlights merged with main show → 4 regions"). */
  extracted_highlights: number;
  merged_from: number;
}

export interface ExtractorOpts {
  /** Section codes to extract from. Default ["M", "C"]. */
  sections?: ReadonlyArray<"M" | "L" | "T" | "C">;
  /** Seconds of padding before each highlight. Default 30. */
  radius_before_sec?: number;
  /** Seconds of padding after each highlight. Default 90. */
  radius_after_sec?: number;
  /** Include the main-show window as a region? Default true. */
  include_main_show?: boolean;
  /** Main-show window (source-seconds). Absent ⇒ no main-show
   *  region even if include_main_show is true. */
  main_show_start_sec?: number;
  main_show_end_sec?: number;
  /** Merge adjacent regions closer than this gap. Default 5s. */
  merge_gap_sec?: number;
  /** Total source duration for clamping. */
  source_duration_sec: number;
}

const SECTION_HEADINGS: Record<"M" | "L" | "T" | "C", RegExp[]> = {
  M: [/key\s*moment/i],
  L: [/key\s*learning/i],
  T: [/key\s*takeaway/i],
  C: [/chat[\-\s]?sparked/i],
};

/**
 * Extract [HH:MM:SS] markers from a Summary Doc markdown, scoped
 * to the requested sections. Sections are identified by their h2
 * / h3 heading text ("Key Moments", "Chat-Sparked", etc.).
 * Returns raw seconds (no padding applied).
 */
export function extractHighlightTimestamps(
  markdown: string,
  sections: ReadonlyArray<"M" | "L" | "T" | "C"> = ["M", "C"],
): Array<{ section: "M" | "L" | "T" | "C"; index: number; second: number }> {
  const out: Array<{ section: "M" | "L" | "T" | "C"; index: number; second: number }> = [];
  const wantSection = new Set(sections);

  let current: "M" | "L" | "T" | "C" | null = null;
  let sectionCount: Record<"M" | "L" | "T" | "C", number> = { M: 0, L: 0, T: 0, C: 0 };
  const markerRe = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;

  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    if (heading) {
      current = null;
      for (const code of ["M", "L", "T", "C"] as const) {
        if (SECTION_HEADINGS[code].some(re => re.test(heading[1]))) {
          current = code;
          sectionCount[code] = 0;
          break;
        }
      }
      continue;
    }
    if (!current || !wantSection.has(current)) continue;
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(line)) !== null) {
      const secs = m[3] !== undefined
        ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        : Number(m[1]) * 60 + Number(m[2]);
      out.push({ section: current, index: sectionCount[current]++, second: secs });
    }
    markerRe.lastIndex = 0;
  }

  return out;
}

/**
 * Compute the final merged region set: main-show window (if
 * enabled) + highlight windows (each expanded by radius), merged
 * where they overlap or are within merge_gap_sec of each other,
 * sorted by start-time. All regions clamped to
 * [0, source_duration_sec].
 */
export function buildRegions(markdown: string, opts: ExtractorOpts): RegionSet {
  const sections = opts.sections ?? ["M", "C"];
  const radiusBefore = Math.max(0, opts.radius_before_sec ?? 30);
  const radiusAfter = Math.max(0, opts.radius_after_sec ?? 90);
  const includeMain = opts.include_main_show ?? true;
  const gap = Math.max(0, opts.merge_gap_sec ?? 5);
  const duration = Math.max(0, opts.source_duration_sec);

  const raw: Region[] = [];
  if (includeMain
      && typeof opts.main_show_start_sec === "number"
      && typeof opts.main_show_end_sec === "number"
      && opts.main_show_end_sec > opts.main_show_start_sec) {
    raw.push({
      start_sec: Math.max(0, opts.main_show_start_sec),
      end_sec: Math.min(duration, opts.main_show_end_sec),
      origin: "main_show",
    });
  }

  const highlights = extractHighlightTimestamps(markdown, sections);
  for (const h of highlights) {
    const start = Math.max(0, h.second - radiusBefore);
    const end = Math.min(duration, h.second + radiusAfter);
    if (end > start) {
      raw.push({ start_sec: start, end_sec: end, origin: `${h.section}:${h.index}` });
    }
  }

  raw.sort((a, b) => a.start_sec - b.start_sec);

  const merged: Region[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start_sec <= last.end_sec + gap) {
      // Extend the previous region; keep the origin as a concat so
      // the manifest can attribute which sections a stitched span
      // was built from.
      last.end_sec = Math.max(last.end_sec, r.end_sec);
      last.origin = `${last.origin}+${r.origin}`;
    } else {
      merged.push({ ...r });
    }
  }

  const total = merged.reduce((n, r) => n + (r.end_sec - r.start_sec), 0);
  return {
    regions: merged,
    total_stitched_sec: total,
    extracted_highlights: highlights.length,
    merged_from: raw.length,
  };
}
