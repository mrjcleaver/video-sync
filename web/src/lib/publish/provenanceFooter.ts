/**
 * ADR-022 provenance footer, in one place — ADR-077 §3.
 *
 * The footer stamps a published video's own description with its catalog
 * origin, so the copy on the platform can be traced back without the
 * local store. ADR-044's Kaltura presence sweep also falls back to
 * matching on it when an operator clears the entry's referenceId.
 *
 * This was duplicated verbatim in three places (the YouTube and Kaltura
 * handlers in VideoCard, plus shortsPublish), and all three applied
 * YouTube's 5000-character cap — including Kaltura, which has no
 * equivalent limit. Consolidating fixes two things:
 *
 *  1. The cap is per-platform, from DESCRIPTION_LIMITS below. Kaltura and
 *     Drive get the full text.
 *  2. Truncation reserves room for the footer instead of cutting through
 *     it. The old `${body}${footer}`.slice(0, 5000) dropped the footer
 *     entirely on any description long enough to need trimming — exactly
 *     the records where provenance is hardest to reconstruct by hand, and
 *     it silently broke ADR-044's footer fallback for them.
 */

import type { DestinationSpec } from "../youtubeTitleAlign";
import type { VideoRecordJSON } from "../wasm";

/**
 * Description length each destination platform accepts. `null` means no
 * limit worth enforcing client-side.
 *
 * YouTube's documented maximum is 5000 characters; the LLM description
 * prompt targets 4800 to leave headroom (see descriptionConfig), so this
 * cap is a backstop for hand-edited copy rather than the normal path.
 */
export const DESCRIPTION_LIMITS: Record<DestinationSpec["platform"], number | null> = {
  YouTube: 5000,
  Kaltura: null,
  GoogleDrive: null,
  Other: null,
};

const FOOTER_PREFIX = "\n\n---\nvideo-sync | ";

/** Render the footer from its parts. Empty parts → empty string, so a
 *  caller with nothing to stamp doesn't emit a bare separator. */
export function buildProvenanceFooter(parts: Array<string | null | undefined>): string {
  const kept = parts.filter((p): p is string => !!p && p.length > 0);
  if (kept.length === 0) return "";
  return `${FOOTER_PREFIX}${kept.join(" | ")}`;
}

/** The standard parts for a catalog record: its id, its source, and every
 *  upstream link the provenance graph knows about (ADR-019). */
export function recordProvenanceParts(record: VideoRecordJSON): string[] {
  const parts = [
    `catalog:${record.id}`,
    `source:${record.source_platform}:${record.source_id}`,
  ];
  for (const link of record.upstream_links ?? []) {
    parts.push(`upstream:${link.platform}:${link.external_id}`);
  }
  return parts;
}

/**
 * Append the footer to a description, trimming the BODY if the platform
 * has a limit and the two together exceed it. The footer is never cut.
 *
 * If the footer alone is longer than the limit — pathological, but a
 * record with dozens of upstream links could get there — the footer is
 * truncated and the body dropped, because a partial footer is still
 * traceable whereas a body with no footer is not.
 */
export function withProvenanceFooter(
  body: string | null | undefined,
  parts: Array<string | null | undefined>,
  platform: DestinationSpec["platform"],
): string {
  const footer = buildProvenanceFooter(parts);
  const text = body ?? "";
  const limit = DESCRIPTION_LIMITS[platform];
  if (limit === null) return `${text}${footer}`;
  if (footer.length >= limit) return footer.slice(0, limit);
  const room = limit - footer.length;
  return `${text.slice(0, room)}${footer}`;
}
