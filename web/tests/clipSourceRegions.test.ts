/**
 * ADR-062 — tests for the summary → clip-source region extractor.
 */

import { describe, it, expect } from "vitest";
import { buildRegions, extractHighlightTimestamps } from "../src/lib/clipSourceRegions";

const SUMMARY = `
# Session summary

## Key Moments

- [00:05:12] Opening remarks land the theme
- [00:12:30] Guest joins with a hot take on regulation

## Key Learnings

- [00:20:00] Framework: three-pillar design

## Chat-Sparked

- [01:47:15] Question about post-show tooling — great answer
`;

describe("extractHighlightTimestamps", () => {
  it("only pulls markers from requested sections", () => {
    const out = extractHighlightTimestamps(SUMMARY, ["M"]);
    expect(out.map(x => x.second)).toEqual([5 * 60 + 12, 12 * 60 + 30]);
  });

  it("supports the default M + C selection", () => {
    const out = extractHighlightTimestamps(SUMMARY, ["M", "C"]);
    expect(out.map(x => x.second).sort((a, b) => a - b))
      .toEqual([5 * 60 + 12, 12 * 60 + 30, 1 * 3600 + 47 * 60 + 15]);
  });

  it("attaches section + per-section index for manifest use", () => {
    const out = extractHighlightTimestamps(SUMMARY, ["M", "C"]);
    const mm = out.filter(x => x.section === "M");
    const cc = out.filter(x => x.section === "C");
    expect(mm[0].index).toBe(0);
    expect(mm[1].index).toBe(1);
    expect(cc[0].index).toBe(0);
  });
});

describe("buildRegions", () => {
  const baseOpts = {
    sections: ["M", "C"] as const,
    radius_before_sec: 30,
    radius_after_sec: 90,
    include_main_show: true,
    main_show_start_sec: 15 * 60,   // 15:00
    main_show_end_sec: 90 * 60,     // 1:30:00
    merge_gap_sec: 5,
    source_duration_sec: 5 * 60 * 60, // 5h
  };

  it("includes main show + each highlight expanded by radius", () => {
    const rs = buildRegions(SUMMARY, { ...baseOpts, sections: ["C"] });
    // Highlights: 01:47:15 → [01:46:45, 01:48:45]. Main show: [15:00, 1:30:00].
    expect(rs.regions.length).toBe(2);
    expect(rs.regions[0]).toMatchObject({
      start_sec: 900,
      end_sec: 5400,
      origin: "main_show",
    });
    expect(rs.regions[1]).toMatchObject({
      start_sec: 1 * 3600 + 46 * 60 + 45,
      end_sec: 1 * 3600 + 48 * 60 + 45,
      origin: "C:0",
    });
  });

  it("merges highlights that fall inside the main-show window", () => {
    // Key Moments at 5:12 (pre-window) and 12:30 (pre-window) with
    // radius produce [4:42, 6:42] + [12:00, 14:00]. Main show 15:00–1:30:00.
    // 12:30 highlight window ends at 14:00; main show starts at 15:00.
    // With merge_gap 5s, the 14:00 end and 15:00 start are 60s apart → NOT merged.
    // But 5:12 window (04:42, 06:42) is disjoint from 12:00,14:00 (>5min apart), so 3 regions total.
    const rs = buildRegions(SUMMARY, { ...baseOpts, sections: ["M"] });
    expect(rs.regions.length).toBe(3);
    expect(rs.regions[0].origin).toBe("M:0");
    expect(rs.regions[1].origin).toBe("M:1");
    expect(rs.regions[2].origin).toBe("main_show");
  });

  it("merges overlapping ranges into one region and concatenates origin tags", () => {
    const opts = { ...baseOpts, sections: ["M"] as const, radius_after_sec: 600 };
    // First highlight at 5:12 with 600s after → ends at 15:12.
    // Second at 12:30 with 600s after → ends at 22:30.
    // Main show 15:00–1:30:00.
    // First (~04:42, 15:12) overlaps second start (~12:00) and merges.
    // Merged (~04:42, 22:30) overlaps main_show (15:00, 1:30:00) and merges further.
    // Final: 1 region [04:42, 1:30:00].
    const rs = buildRegions(SUMMARY, opts);
    expect(rs.regions.length).toBe(1);
    expect(rs.regions[0].start_sec).toBe(4 * 60 + 42);
    expect(rs.regions[0].end_sec).toBe(90 * 60);
    expect(rs.regions[0].origin).toContain("M:0");
    expect(rs.regions[0].origin).toContain("main_show");
  });

  it("clamps regions to [0, source_duration_sec]", () => {
    const md = "## Key Moments\n- [00:00:10] near-zero\n- [04:59:50] near-end";
    const rs = buildRegions(md, {
      ...baseOpts,
      sections: ["M"],
      include_main_show: false,
      radius_before_sec: 300, // 5 min → would give a negative start
      radius_after_sec: 300,
    });
    expect(rs.regions[0].start_sec).toBe(0);
    expect(rs.regions[rs.regions.length - 1].end_sec).toBe(5 * 3600);
  });

  it("computes total_stitched_sec = sum of merged region widths", () => {
    const rs = buildRegions(SUMMARY, baseOpts);
    const expected = rs.regions.reduce((n, r) => n + (r.end_sec - r.start_sec), 0);
    expect(rs.total_stitched_sec).toBe(expected);
  });

  it("returns 0 regions when no summary + include_main_show=false", () => {
    const rs = buildRegions("no markers here", {
      ...baseOpts,
      include_main_show: false,
    });
    expect(rs.regions.length).toBe(0);
    expect(rs.total_stitched_sec).toBe(0);
  });
});
