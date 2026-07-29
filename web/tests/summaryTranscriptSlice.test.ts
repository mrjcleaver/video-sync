/**
 * ADR-059 — tests for the transcript-slice helper that trims off
 * the pre-show window before summary generation sees the text.
 */

import { describe, it, expect } from "vitest";
import { sliceTranscriptFromSeconds } from "../src/lib/summaryGenerate";

describe("sliceTranscriptFromSeconds", () => {
  it("returns the text unchanged when startSecs is 0", () => {
    const text = "[00:00:10] alpha\n[00:00:20] beta";
    expect(sliceTranscriptFromSeconds(text, 0)).toBe(text);
  });

  it("returns the text unchanged when startSecs is negative", () => {
    const text = "[00:00:10] alpha";
    expect(sliceTranscriptFromSeconds(text, -5)).toBe(text);
  });

  it("drops lines whose HH:MM:SS marker is before the trim boundary", () => {
    const text = [
      "[00:00:15] warmup",
      "[00:05:00] more warmup",
      "[00:12:00] show starts",
      "[00:12:30] first topic",
    ].join("\n");
    const sliced = sliceTranscriptFromSeconds(text, 720); // 12 min
    expect(sliced).toBe("[00:12:00] show starts\n[00:12:30] first topic");
  });

  it("accepts MM:SS markers (no leading hour)", () => {
    const text = "[00:15] pre\n[08:00] warm\n[12:00] show\n[12:30] topic";
    const sliced = sliceTranscriptFromSeconds(text, 720);
    expect(sliced).toBe("[12:00] show\n[12:30] topic");
  });

  it("returns the original text when no line's marker meets the boundary", () => {
    // trim asks for 20min but the whole transcript is under 12min.
    const text = "[00:05:00] alpha\n[00:11:00] beta";
    expect(sliceTranscriptFromSeconds(text, 1200)).toBe(text);
  });

  it("returns the original text when no line has a marker at all", () => {
    const text = "no markers here\njust plain text\nsecond line";
    expect(sliceTranscriptFromSeconds(text, 60)).toBe(text);
  });

  it("keeps the first line whose marker matches exactly", () => {
    const text = "[00:00:30] pre\n[00:01:00] boundary\n[00:01:30] after";
    const sliced = sliceTranscriptFromSeconds(text, 60);
    expect(sliced.startsWith("[00:01:00] boundary")).toBe(true);
  });
});
