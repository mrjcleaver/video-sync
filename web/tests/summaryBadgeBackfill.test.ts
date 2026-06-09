/**
 * Tests for ADR-052 summary badge backfill scanner.
 */

import { describe, it, expect } from "vitest";
import { findRecordsNeedingSummaryBadge } from "../src/lib/summaryBadgeBackfill";
import type { VideoRecordJSON } from "../src/lib/wasm";

const LONG = "x".repeat(500);

function makeRecord(overrides: Partial<VideoRecordJSON>): VideoRecordJSON {
  return {
    id: "rec-" + Math.random().toString(36).slice(2, 10),
    source_id: "stub-source",
    source_platform: "Zoom",
    title: "stub",
    description: null,
    duration_seconds: 0,
    participants: [],
    download_url: "stub://",
    thumbnail_url: null,
    tags: [],
    recorded_at: "2026-06-08T00:00:00Z",
    indexed_at: "2026-06-08T00:00:00Z",
    status: "Discovered",
    locations: [],
    upstream_links: [],
    rejected_links: [],
    metadata_extra: null,
    destination_id: null,
    destination_url: null,
    notes: [],
    transcript_text: LONG,
    summary_doc_id: null,
    summary_prompt_version: null,
    summary_locked: false,
    summary_counts: null,
    ...overrides,
  } as unknown as VideoRecordJSON;
}

describe("findRecordsNeedingSummaryBadge — eligibility filters", () => {
  it("INCLUDES records with no summary_doc_id (missing)", () => {
    const r = makeRecord({});
    const result = findRecordsNeedingSummaryBadge([r], 3);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("missing");
  });

  it("INCLUDES records whose prompt_version is below current (stale)", () => {
    const r = makeRecord({
      summary_doc_id: "doc-A",
      summary_prompt_version: 2,
    });
    const result = findRecordsNeedingSummaryBadge([r], 3);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("stale");
  });

  it("EXCLUDES records already at current prompt version", () => {
    const r = makeRecord({
      summary_doc_id: "doc-A",
      summary_prompt_version: 3,
    });
    expect(findRecordsNeedingSummaryBadge([r], 3)).toHaveLength(0);
  });

  it("EXCLUDES locked records by default", () => {
    const r = makeRecord({ summary_locked: true });
    expect(findRecordsNeedingSummaryBadge([r], 3)).toHaveLength(0);
  });

  it("INCLUDES locked records when includeLocked=true (override)", () => {
    const r = makeRecord({ summary_locked: true });
    const result = findRecordsNeedingSummaryBadge([r], 3, { includeLocked: true });
    expect(result).toHaveLength(1);
  });

  it("EXCLUDES Skipped records (operator-terminal state)", () => {
    const r = makeRecord({ status: "Skipped" });
    expect(findRecordsNeedingSummaryBadge([r], 3)).toHaveLength(0);
  });

  it("EXCLUDES Abandoned records (operator-terminal state)", () => {
    const r = makeRecord({ status: "Abandoned" });
    expect(findRecordsNeedingSummaryBadge([r], 3)).toHaveLength(0);
  });

  it("EXCLUDES records with no usable transcript (own or borrowed)", () => {
    const r = makeRecord({ transcript_text: undefined });
    expect(findRecordsNeedingSummaryBadge([r], 3)).toHaveLength(0);
  });
});

describe("findRecordsNeedingSummaryBadge — borrowed transcript flag (ADR-053)", () => {
  it("marks needsBorrowedTranscript=false when record has its own transcript", () => {
    const r = makeRecord({ transcript_text: LONG });
    const result = findRecordsNeedingSummaryBadge([r], 3);
    expect(result[0].needsBorrowedTranscript).toBe(false);
  });

  it("marks needsBorrowedTranscript=true when transcript comes from a paired donor", () => {
    const target = makeRecord({
      id: "target",
      source_platform: "Zoom",
      source_id: "zoom-A",
      transcript_text: undefined,  // no own transcript
    });
    const donor = makeRecord({
      id: "donor",
      source_platform: "Fireflies",
      source_id: "fireflies-A",
      transcript_text: LONG,
      upstream_links: [{
        video_id: "target",
        platform: "Zoom",
        external_id: "zoom-A",
        account_hint: null,
        relation: "TranscribedFrom",
        linked_by: "Auto",
        linked_at: "2026-06-08T00:00:00Z",
      }],
    });
    const result = findRecordsNeedingSummaryBadge([target, donor], 3);
    // Target picks up the borrowed transcript; donor itself has a
    // transcript so it's also a candidate (with own transcript).
    const targetEntry = result.find((c) => c.record.id === "target");
    expect(targetEntry).toBeDefined();
    expect(targetEntry!.needsBorrowedTranscript).toBe(true);
    const donorEntry = result.find((c) => c.record.id === "donor");
    expect(donorEntry).toBeDefined();
    expect(donorEntry!.needsBorrowedTranscript).toBe(false);
  });
});
