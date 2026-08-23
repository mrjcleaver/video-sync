/**
 * ADR-077 §3 — the consolidated ADR-022 provenance footer.
 *
 * Two behaviours matter beyond "it concatenates": the cap is
 * per-platform (Kaltura was inheriting YouTube's 5000), and truncation
 * reserves room for the footer rather than cutting through it (the old
 * `${body}${footer}`.slice(0, 5000) silently dropped provenance on long
 * descriptions, which also broke ADR-044's footer-fallback match).
 */

import { describe, it, expect } from "vitest";
import {
  buildProvenanceFooter,
  recordProvenanceParts,
  withProvenanceFooter,
  DESCRIPTION_LIMITS,
} from "../src/lib/publish/provenanceFooter";
import type { VideoRecordJSON } from "../src/lib/wasm";

function record(over: Partial<VideoRecordJSON> = {}): VideoRecordJSON {
  return {
    id: "rec-abc", source_id: "zoom-123", source_platform: "Zoom",
    title: "Session", upstream_links: [], ...over,
  } as VideoRecordJSON;
}

describe("buildProvenanceFooter", () => {
  it("renders the ADR-022 shape", () => {
    expect(buildProvenanceFooter(["catalog:x", "source:Zoom:1"]))
      .toBe("\n\n---\nvideo-sync | catalog:x | source:Zoom:1");
  });

  it("drops empty parts so callers can pass conditionals inline", () => {
    expect(buildProvenanceFooter(["catalog:x", null, undefined, ""]))
      .toBe("\n\n---\nvideo-sync | catalog:x");
  });

  it("returns nothing when there is nothing to stamp", () => {
    // A bare separator with no provenance would be noise on the platform.
    expect(buildProvenanceFooter([])).toBe("");
    expect(buildProvenanceFooter([null, ""])).toBe("");
  });
});

describe("recordProvenanceParts", () => {
  it("carries the record id and its source", () => {
    expect(recordProvenanceParts(record()))
      .toEqual(["catalog:rec-abc", "source:Zoom:zoom-123"]);
  });

  it("includes every upstream link", () => {
    const parts = recordProvenanceParts(record({
      upstream_links: [
        { platform: "Fireflies", external_id: "ff-1" },
        { platform: "YouTube", external_id: "yt-1" },
      ] as never,
    }));
    expect(parts).toContain("upstream:Fireflies:ff-1");
    expect(parts).toContain("upstream:YouTube:yt-1");
  });
});

describe("withProvenanceFooter — per-platform caps", () => {
  const parts = ["catalog:rec-abc", "source:Zoom:zoom-123"];

  it("appends without trimming when the text fits", () => {
    const out = withProvenanceFooter("Short description", parts, "YouTube");
    expect(out.startsWith("Short description")).toBe(true);
    expect(out).toContain("catalog:rec-abc");
  });

  it("keeps the footer intact when the body must be trimmed", () => {
    const body = "x".repeat(6000);
    const out = withProvenanceFooter(body, parts, "YouTube");
    expect(out.length).toBe(DESCRIPTION_LIMITS.YouTube);
    // The regression this consolidation fixes: the footer used to be the
    // part that got cut, leaving no provenance on exactly the records
    // where it's hardest to reconstruct.
    expect(out.endsWith(buildProvenanceFooter(parts))).toBe(true);
    expect(out).toContain("catalog:rec-abc");
  });

  it("does not cap Kaltura, which has no 5000-character limit", () => {
    const body = "x".repeat(6000);
    const out = withProvenanceFooter(body, parts, "Kaltura");
    expect(out.length).toBeGreaterThan(6000);
    expect(out.startsWith(body)).toBe(true);
  });

  it("does not cap Drive", () => {
    const body = "x".repeat(6000);
    expect(withProvenanceFooter(body, parts, "GoogleDrive").length).toBeGreaterThan(6000);
  });

  it("treats a null body as empty", () => {
    expect(withProvenanceFooter(null, parts, "YouTube"))
      .toBe(buildProvenanceFooter(parts));
  });

  it("prefers a truncated footer over a body with none", () => {
    // Pathological: a record with enough upstream links that the footer
    // alone busts the limit. A partial footer is still traceable.
    const manyParts = Array.from({ length: 400 }, (_, i) => `upstream:YouTube:video-id-${i}`);
    const out = withProvenanceFooter("body text", manyParts, "YouTube");
    expect(out.length).toBe(DESCRIPTION_LIMITS.YouTube);
    expect(out).not.toContain("body text");
    expect(out.startsWith("\n\n---\nvideo-sync | ")).toBe(true);
  });

  it("emits no footer separator when there are no parts", () => {
    expect(withProvenanceFooter("Just the body", [], "YouTube")).toBe("Just the body");
  });
});
