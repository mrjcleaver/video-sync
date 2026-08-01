/**
 * ADR-062 follow-up — dedupe classifier tests. Verifies the
 * canonical-picking order matches the audit's stated preference:
 * status rank first, then more Destination locations, then more
 * upstream_links, then oldest indexed_at.
 */

import { describe, it, expect } from "vitest";
import { findDuplicateClusters } from "../src/lib/catalogDedupe";
import type { VideoRecordJSON } from "../src/lib/wasm";

function rec(overrides: Partial<VideoRecordJSON>): VideoRecordJSON {
  return {
    id: overrides.id ?? "id-x",
    source_platform: "Zoom",
    source_id: "zoom-x",
    title: "T",
    status: "Discovered",
    indexed_at: "2026-01-01T00:00:00Z",
    recorded_at: null,
    published_at: null,
    curated_at: null,
    duration_seconds: 0,
    description: null,
    download_url: "",
    participants: [],
    tags: [],
    locations: [],
    upstream_links: [],
    metadata_extra: null,
    summary_doc_id: null,
    summary_prompt_version: null,
    summary_locked: false,
    ...overrides,
  } as VideoRecordJSON;
}

describe("findDuplicateClusters", () => {
  it("returns nothing when there are no duplicates", () => {
    const rs = [
      rec({ id: "a", source_platform: "Zoom", source_id: "zoom-1" }),
      rec({ id: "b", source_platform: "Zoom", source_id: "zoom-2" }),
    ];
    expect(findDuplicateClusters(rs)).toEqual([]);
  });

  it("ignores OpusClip records — they share job-prefixed source_ids intentionally", () => {
    const rs = [
      rec({ id: "a", source_platform: "OpusClip" as VideoRecordJSON["source_platform"], source_id: "shorts-X-0" }),
      rec({ id: "b", source_platform: "OpusClip" as VideoRecordJSON["source_platform"], source_id: "shorts-X-0" }),
    ];
    expect(findDuplicateClusters(rs)).toEqual([]);
  });

  it("prefers Published > Failed for the canonical winner", () => {
    const rs = [
      rec({ id: "loser", source_id: "zoom-1", status: "Failed" }),
      rec({ id: "winner", source_id: "zoom-1", status: "Published" }),
    ];
    const [c] = findDuplicateClusters(rs);
    expect(c.winner.id).toBe("winner");
    expect(c.losers.map(l => l.id)).toEqual(["loser"]);
  });

  it("breaks status ties by Destination-location count", () => {
    const rs = [
      rec({
        id: "sparse", source_id: "zoom-1", status: "Published",
        locations: [{ platform: "Zoom", role: "Origin", external_id: "z", external_url: null, status: null, ordinal: 0, synced_at: "2026-01-01T00:00:00Z" }],
      }),
      rec({
        id: "richer", source_id: "zoom-1", status: "Published",
        locations: [
          { platform: "Zoom", role: "Origin", external_id: "z", external_url: null, status: null, ordinal: 0, synced_at: "2026-01-01T00:00:00Z" },
          { platform: "YouTube", role: "Destination", external_id: "y1", external_url: null, status: null, ordinal: 1, synced_at: "2026-01-01T00:00:00Z" },
          { platform: "Kaltura", role: "Destination", external_id: "k1", external_url: null, status: null, ordinal: 2, synced_at: "2026-01-01T00:00:00Z" },
        ],
      }),
    ];
    const [c] = findDuplicateClusters(rs);
    expect(c.winner.id).toBe("richer");
  });

  it("breaks further ties by upstream_links count", () => {
    const rs = [
      rec({ id: "no-links", source_id: "zoom-1", status: "Published" }),
      rec({
        id: "has-links", source_id: "zoom-1", status: "Published",
        upstream_links: [
          { platform: "Fireflies", relation: "SameEvent", external_id: "ff-1", video_id: null, linked_at: "2026-01-01T00:00:00Z", linked_by_actor_id: null, linked_by: "Auto", account_hint: null },
        ] as VideoRecordJSON["upstream_links"],
      }),
    ];
    const [c] = findDuplicateClusters(rs);
    expect(c.winner.id).toBe("has-links");
  });

  it("finally breaks ties by oldest indexed_at (first-created wins)", () => {
    const rs = [
      rec({ id: "newer", source_id: "zoom-1", status: "Published", indexed_at: "2026-05-01T00:00:00Z" }),
      rec({ id: "older", source_id: "zoom-1", status: "Published", indexed_at: "2026-04-01T00:00:00Z" }),
    ];
    const [c] = findDuplicateClusters(rs);
    expect(c.winner.id).toBe("older");
  });

  it("clusters across multiple platforms independently", () => {
    const rs = [
      rec({ id: "z1a", source_platform: "Zoom", source_id: "zoom-A", status: "Published" }),
      rec({ id: "z1b", source_platform: "Zoom", source_id: "zoom-A", status: "Failed" }),
      rec({ id: "f1a", source_platform: "Fireflies", source_id: "ff-1", status: "Published" }),
      rec({ id: "f1b", source_platform: "Fireflies", source_id: "ff-1", status: "Failed" }),
      rec({ id: "f1c", source_platform: "Fireflies", source_id: "ff-1", status: "Skipped" }),
    ];
    const clusters = findDuplicateClusters(rs);
    expect(clusters.length).toBe(2);
    const zoom = clusters.find(c => c.source_platform === "Zoom")!;
    const ff = clusters.find(c => c.source_platform === "Fireflies")!;
    expect(zoom.losers.length).toBe(1);
    expect(ff.losers.length).toBe(2);
    expect(ff.winner.id).toBe("f1a");
  });
});
