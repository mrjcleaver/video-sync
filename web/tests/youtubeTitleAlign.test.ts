/**
 * Tests for ADR-055 YouTube title-alignment resolver.
 */

import { describe, it, expect } from "vitest";
import {
  resolveAlignedTitle,
  titleContainsDate,
  formatDMMMYYYY,
  type SeriesRegistryEntry,
} from "../src/lib/youtubeTitleAlign";
import type { VideoRecordJSON, UpstreamLinkJSON } from "../src/lib/wasm";

function makeRecord(overrides: Partial<VideoRecordJSON>): VideoRecordJSON {
  return {
    id: "rec-" + Math.random().toString(36).slice(2, 10),
    source_id: "youtube-stub",
    source_platform: "YouTube",
    title: "AI Hackerspace Live",
    description: null,
    duration_seconds: 0,
    participants: [],
    download_url: "youtube://stub",
    thumbnail_url: null,
    tags: [],
    recorded_at: "2026-02-06T18:00:00Z",
    indexed_at: "2026-02-06T19:00:00Z",
    status: "Discovered",
    locations: [],
    upstream_links: [],
    rejected_links: [],
    metadata_extra: null,
    destination_id: null,
    destination_url: null,
    notes: [],
    ...overrides,
  } as unknown as VideoRecordJSON;
}

function makeLink(overrides: Partial<UpstreamLinkJSON>): UpstreamLinkJSON {
  return {
    video_id: null,
    platform: "Zoom",
    external_id: "zoom-stub",
    account_hint: null,
    relation: "BroadcastedFrom",
    linked_by: "Auto",
    linked_at: "2026-02-06T18:00:00Z",
    ...overrides,
  };
}

describe("titleContainsDate", () => {
  it("detects 'D MMM YYYY' form (the ADR-014 default)", () => {
    expect(titleContainsDate("AI Hackerspace Live - 6 Feb 2026")).toBe(true);
    expect(titleContainsDate("Agentics Live Vibe - Coding - 19 Feb 2026")).toBe(true);
    expect(titleContainsDate("Session (16 Jun 2026)")).toBe(true);
  });

  it("detects ISO form", () => {
    expect(titleContainsDate("2026-02-06 recap")).toBe(true);
  });

  it("returns false for undated generic titles", () => {
    expect(titleContainsDate("AI Hackerspace Live")).toBe(false);
    expect(titleContainsDate("Livestream")).toBe(false);
    expect(titleContainsDate("")).toBe(false);
    expect(titleContainsDate("Meetup #2")).toBe(false);
  });

  it("rejects false positives (bare year, day count, three-digit runs)", () => {
    expect(titleContainsDate("Year 2026 review")).toBe(false);
    expect(titleContainsDate("Session 42")).toBe(false);
  });
});

describe("formatDMMMYYYY", () => {
  it("produces 'D MMM YYYY' matching ADR-014", () => {
    expect(formatDMMMYYYY("2026-02-06T18:00:00Z")).toBe("6 Feb 2026");
    expect(formatDMMMYYYY("2026-06-19T12:00:00Z")).toBe("19 Jun 2026");
    expect(formatDMMMYYYY("2026-12-01T00:00:00Z")).toBe("1 Dec 2026");
  });

  it("returns empty string on unparseable input", () => {
    expect(formatDMMMYYYY("not a date")).toBe("");
    expect(formatDMMMYYYY("")).toBe("");
  });
});

describe("resolveAlignedTitle — ADR-056 widened scope covers all platforms", () => {
  const registry: SeriesRegistryEntry[] = [
    { series_name: "AI Hackerspace Live", pattern: "^AI Hackerspace Live" },
  ];

  it("Zoom-source records are now eligible (Strategy 2)", () => {
    const r = makeRecord({ source_platform: "Zoom", title: "AI Hackerspace Live", recorded_at: "2026-02-06T18:00:00Z" });
    const result = resolveAlignedTitle(r, [r], registry);
    expect(result?.new_title).toBe("AI Hackerspace Live - 6 Feb 2026");
    expect(result?.matched_series).toBe("AI Hackerspace Live");
  });

  it("Fireflies-source records are now eligible (Strategy 2)", () => {
    const r = makeRecord({ source_platform: "Fireflies", title: "AI Hackerspace Live", recorded_at: "2026-02-06T18:00:00Z" });
    expect(resolveAlignedTitle(r, [r], registry)?.new_title).toBe("AI Hackerspace Live - 6 Feb 2026");
  });

  it("Kaltura-source records are now eligible (Strategy 2)", () => {
    const r = makeRecord({ source_platform: "Kaltura", title: "AI Hackerspace Live", recorded_at: "2026-02-06T18:00:00Z" });
    expect(resolveAlignedTitle(r, [r], registry)?.new_title).toBe("AI Hackerspace Live - 6 Feb 2026");
  });
});

describe("resolveAlignedTitle — already-dated titles are left alone", () => {
  it("skips when title already has 'D MMM YYYY'", () => {
    const r = makeRecord({ title: "AI Hackerspace Live - 6 Feb 2026" });
    const registry: SeriesRegistryEntry[] = [{ series_name: "AI Hackerspace Live", pattern: "^AI Hackerspace Live" }];
    expect(resolveAlignedTitle(r, [r], registry)).toBeNull();
  });
});

describe("resolveAlignedTitle — Strategy 1 (paired canonical)", () => {
  it("inherits the paired canonical's dated title verbatim", () => {
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-A",
      title: "Agentics Live Vibe - Coding - 19 Feb 2026",
    });
    const yt = makeRecord({
      title: "Agentics Live Vibe - Coding",
      upstream_links: [makeLink({ platform: "Zoom", external_id: "zoom-A", video_id: "zoom-uuid" })],
      recorded_at: "2026-02-19T18:00:00Z",
    });
    const result = resolveAlignedTitle(yt, [yt, zoom], []);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("paired_canonical");
    expect(result!.new_title).toBe("Agentics Live Vibe - Coding - 19 Feb 2026");
    expect(result!.canonical_id).toBe("zoom-uuid");
    expect(result!.original_title).toBe("Agentics Live Vibe - Coding");
  });

  it("falls through when the paired canonical is itself undated", () => {
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-A",
      title: "Agentics Live Vibe - Coding",  // undated
    });
    const yt = makeRecord({
      title: "Agentics Live Vibe - Coding",
      upstream_links: [makeLink({ platform: "Zoom", external_id: "zoom-A", video_id: "zoom-uuid" })],
    });
    // No registry either — no strategy fires.
    expect(resolveAlignedTitle(yt, [yt, zoom], [])).toBeNull();
  });

  it("resolves canonical by (platform, external_id) when link.video_id is missing", () => {
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-A",
      title: "AI Hackerspace Live - 6 Feb 2026",
    });
    const yt = makeRecord({
      title: "AI Hackerspace Live",
      upstream_links: [makeLink({ platform: "Zoom", external_id: "zoom-A", video_id: null })],
    });
    const result = resolveAlignedTitle(yt, [yt, zoom], []);
    expect(result?.new_title).toBe("AI Hackerspace Live - 6 Feb 2026");
    expect(result?.canonical_id).toBe("zoom-uuid");
  });

  it("returns null if pair-inherited title matches current (no-op)", () => {
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-A",
      title: "AI Hackerspace Live - 6 Feb 2026",
    });
    const yt = makeRecord({
      title: "AI Hackerspace Live - 6 Feb 2026",  // matches canonical already
      upstream_links: [makeLink({ platform: "Zoom", external_id: "zoom-A", video_id: "zoom-uuid" })],
    });
    // Already-dated gate catches this first.
    expect(resolveAlignedTitle(yt, [yt, zoom], [])).toBeNull();
  });
});

describe("resolveAlignedTitle — Strategy 2 (series registry)", () => {
  const registry: SeriesRegistryEntry[] = [
    { series_name: "AI Hackerspace Live", pattern: "^AI Hackerspace Live" },
    { series_name: "Agentics Live Vibe - Coding", pattern: "^Agentics Live Vibe\\s*-?\\s*Coding" },
    { series_name: "Friday Hackerspace Live Events", pattern: "^Friday Hackerspace" },
  ];

  it("constructs `{series} - {D MMM YYYY}` on match", () => {
    const yt = makeRecord({
      title: "AI Hackerspace Live",
      recorded_at: "2026-02-06T18:00:00Z",
    });
    const result = resolveAlignedTitle(yt, [yt], registry);
    expect(result?.source).toBe("series_registry");
    expect(result?.new_title).toBe("AI Hackerspace Live - 6 Feb 2026");
    expect(result?.matched_series).toBe("AI Hackerspace Live");
  });

  it("matches when title has trailing context beyond the series prefix", () => {
    const yt = makeRecord({
      title: "AI Hackerspace Live: special guest Alice",  // still matches ^AI Hackerspace Live
      recorded_at: "2026-06-19T12:00:00Z",
    });
    const result = resolveAlignedTitle(yt, [yt], registry);
    expect(result?.new_title).toBe("AI Hackerspace Live - 19 Jun 2026");
  });

  it("prefers the longest matching series_name when multiple patterns fire", () => {
    const yt = makeRecord({
      title: "Agentics Live Vibe - Coding",
      recorded_at: "2026-06-19T12:00:00Z",
    });
    const overlapping: SeriesRegistryEntry[] = [
      { series_name: "Agentics", pattern: "^Agentics" },
      { series_name: "Agentics Live Vibe - Coding", pattern: "^Agentics Live" },
    ];
    const result = resolveAlignedTitle(yt, [yt], overlapping);
    expect(result?.matched_series).toBe("Agentics Live Vibe - Coding");
  });

  it("returns null when no pattern matches", () => {
    const yt = makeRecord({ title: "Some ad-hoc broadcast" });
    expect(resolveAlignedTitle(yt, [yt], registry)).toBeNull();
  });

  it("skips malformed regex entries and continues to the next", () => {
    const badFirst: SeriesRegistryEntry[] = [
      { series_name: "First", pattern: "([unclosed" },
      { series_name: "AI Hackerspace Live", pattern: "^AI Hackerspace Live" },
    ];
    const yt = makeRecord({ title: "AI Hackerspace Live", recorded_at: "2026-02-06T18:00:00Z" });
    const result = resolveAlignedTitle(yt, [yt], badFirst);
    expect(result?.matched_series).toBe("AI Hackerspace Live");
  });
});

describe("resolveAlignedTitle — Strategy 1 widened relations (ADR-056)", () => {
  it("Fireflies with TranscribedFrom → Zoom inherits Zoom's dated title", () => {
    // The most common ADR-056 case: Fireflies transcript-bot capture
    // paired with a Zoom recording that already carries the date.
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-A",
      title: "AI Hackerspace Live - 6 Feb 2026",
    });
    const fireflies = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-A",
      title: "AI Hackerspace Live",
      upstream_links: [makeLink({
        relation: "TranscribedFrom",
        platform: "Zoom",
        external_id: "zoom-A",
        video_id: "zoom-uuid",
      })],
    });
    const result = resolveAlignedTitle(fireflies, [fireflies, zoom], []);
    expect(result?.source).toBe("paired_canonical");
    expect(result?.new_title).toBe("AI Hackerspace Live - 6 Feb 2026");
    expect(result?.canonical_id).toBe("zoom-uuid");
  });

  it("Zoom with SameEvent → Fireflies (with dated title) inherits Fireflies' title", () => {
    // The reverse direction — if the Fireflies side happens to be
    // the one with the date, the Zoom side borrows it.
    const fireflies = makeRecord({
      id: "ff-uuid",
      source_platform: "Fireflies",
      source_id: "fireflies-A",
      title: "Agentics Live Vibe - Coding - 21 May 2026",
    });
    const zoom = makeRecord({
      source_platform: "Zoom",
      source_id: "zoom-A",
      title: "Agentics Live Vibe - Coding",
      upstream_links: [makeLink({
        relation: "SameEvent",
        platform: "Fireflies",
        external_id: "fireflies-A",
        video_id: "ff-uuid",
      })],
    });
    const result = resolveAlignedTitle(zoom, [zoom, fireflies], []);
    expect(result?.source).toBe("paired_canonical");
    expect(result?.new_title).toBe("Agentics Live Vibe - Coding - 21 May 2026");
    expect(result?.canonical_id).toBe("ff-uuid");
  });

  it("still ignores ClipOf donors (partial context, unsafe)", () => {
    const clip = makeRecord({
      id: "clip-uuid",
      source_platform: "YouTube",
      title: "AI Hackerspace Live - Highlight - 6 Feb 2026",  // dated, but partial
    });
    const source = makeRecord({
      source_platform: "Zoom",
      title: "AI Hackerspace Live",
      upstream_links: [makeLink({
        relation: "ClipOf",
        platform: "YouTube",
        external_id: clip.source_id,
        video_id: "clip-uuid",
      })],
    });
    // Clip donor is filtered out. No other strategy fires → null.
    expect(resolveAlignedTitle(source, [source, clip], [])).toBeNull();
  });

  it("still ignores ScreenRecordingOf donors", () => {
    const screenRec = makeRecord({
      id: "loom-uuid",
      source_platform: "Loom",
      title: "AI Hackerspace Live - 6 Feb 2026",
    });
    const source = makeRecord({
      source_platform: "Zoom",
      title: "AI Hackerspace Live",
      upstream_links: [makeLink({
        relation: "ScreenRecordingOf",
        platform: "Loom",
        external_id: screenRec.source_id,
        video_id: "loom-uuid",
      })],
    });
    expect(resolveAlignedTitle(source, [source, screenRec], [])).toBeNull();
  });
});

describe("resolveAlignedTitle — strategy priority", () => {
  it("prefers paired-canonical when both strategies would fire", () => {
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-A",
      title: "AI Hackerspace Live - 5 Feb 2026",  // canonical says the 5th
    });
    const yt = makeRecord({
      title: "AI Hackerspace Live",
      upstream_links: [makeLink({ platform: "Zoom", external_id: "zoom-A", video_id: "zoom-uuid" })],
      recorded_at: "2026-02-06T18:00:00Z",  // registry would generate the 6th
    });
    const registry: SeriesRegistryEntry[] = [
      { series_name: "AI Hackerspace Live", pattern: "^AI Hackerspace Live" },
    ];
    const result = resolveAlignedTitle(yt, [yt, zoom], registry);
    // Canonical wins.
    expect(result?.source).toBe("paired_canonical");
    expect(result?.new_title).toBe("AI Hackerspace Live - 5 Feb 2026");
  });
});
