/**
 * Tests for the ADR-049/050 directional rules encoded in
 * `resolveYouTubeCanonical`. The full `ingestYouTubeSourceRow` flow
 * requires WASM + fetch + videoStore wiring — covered by integration
 * during the C1-A panel and C3 publish-path wiring. These unit tests
 * lock in the upstream-resolution logic so the rules don't drift.
 */

import { describe, it, expect } from "vitest";
import { resolveYouTubeCanonical, findMissingYouTubeRows } from "../src/lib/youtubeIngest";
import type { VideoRecordJSON, UpstreamLinkJSON, PlatformLocationJSON } from "../src/lib/wasm";

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
    recorded_at: "2026-06-07T00:00:00Z",
    indexed_at: "2026-06-07T00:00:00Z",
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
    relation: "SameEvent",
    linked_by: "Auto",
    linked_at: "2026-06-07T00:00:00Z",
    ...overrides,
  };
}

describe("resolveYouTubeCanonical — ADR-049/050 directional rules", () => {
  it("host=Zoom → canonical is the Zoom record itself (BroadcastedFrom)", () => {
    const zoom = makeRecord({ source_platform: "Zoom", source_id: "zoom-abc" });
    const result = resolveYouTubeCanonical(zoom, [zoom]);
    expect(result).not.toBeNull();
    expect(result!.canonical.id).toBe(zoom.id);
  });

  for (const platform of ["Streamyard", "OBS", "Wirecast"]) {
    it(`host=${platform} → canonical is the host (meeting source)`, () => {
      const host = makeRecord({ source_platform: platform, source_id: `${platform.toLowerCase()}-stub` });
      const result = resolveYouTubeCanonical(host, [host]);
      expect(result).not.toBeNull();
      expect(result!.canonical.id).toBe(host.id);
    });
  }

  it("host=Fireflies with TranscribedFrom→Zoom present → skips middleman, canonical is Zoom", () => {
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-abc",
    });
    const fireflies = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-xyz",
      upstream_links: [
        makeLink({
          relation: "TranscribedFrom",
          platform: "Zoom",
          external_id: "zoom-abc",
          video_id: "zoom-uuid",
        }),
      ],
    });
    const result = resolveYouTubeCanonical(fireflies, [zoom, fireflies]);
    expect(result).not.toBeNull();
    expect(result!.canonical.id).toBe(zoom.id);
  });

  it("host=Fireflies with TranscribedFrom→Zoom but Zoom not in catalog → fallback to Fireflies (ADR-050)", () => {
    const fireflies = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-xyz",
      upstream_links: [
        makeLink({
          relation: "TranscribedFrom",
          platform: "Zoom",
          external_id: "zoom-missing-from-catalog",
          video_id: null,
        }),
      ],
    });
    const result = resolveYouTubeCanonical(fireflies, [fireflies]);
    expect(result).not.toBeNull();
    expect(result!.canonical.id).toBe(fireflies.id);
  });

  it("host=Fireflies standalone (no TranscribedFrom) → fallback to Fireflies-as-canonical", () => {
    const fireflies = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-standalone",
      upstream_links: [],
    });
    const result = resolveYouTubeCanonical(fireflies, [fireflies]);
    expect(result).not.toBeNull();
    expect(result!.canonical.id).toBe(fireflies.id);
  });

  it("host=Fireflies with TranscribedFrom→Zoom resolves via video_id even when (platform, external_id) drifted", () => {
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-renamed",
    });
    const fireflies = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-xyz",
      upstream_links: [
        makeLink({
          relation: "TranscribedFrom",
          platform: "Zoom",
          external_id: "zoom-stale-id",  // mismatched with current source_id
          video_id: "zoom-uuid",          // but the record id matches
        }),
      ],
    });
    const result = resolveYouTubeCanonical(fireflies, [zoom, fireflies]);
    expect(result).not.toBeNull();
    expect(result!.canonical.id).toBe(zoom.id);
  });

  it("host=Loom → no auto-link (returns null)", () => {
    const loom = makeRecord({ source_platform: "Loom", source_id: "loom-stub" });
    const result = resolveYouTubeCanonical(loom, [loom]);
    expect(result).toBeNull();
  });

  it("host=Kaltura → no auto-link (returns null)", () => {
    const kaltura = makeRecord({ source_platform: "Kaltura", source_id: "kaltura-stub" });
    const result = resolveYouTubeCanonical(kaltura, [kaltura]);
    expect(result).toBeNull();
  });

  it("host=YouTube (re-publish) → no auto-link (returns null)", () => {
    const youtube = makeRecord({ source_platform: "YouTube", source_id: "youtube-stub" });
    const result = resolveYouTubeCanonical(youtube, [youtube]);
    expect(result).toBeNull();
  });

  it("host=Fireflies with a SameEvent link (not TranscribedFrom) → still fallback to Fireflies", () => {
    // SameEvent doesn't count as the "TranscribedFrom skip-middleman"
    // trigger — only the directional TranscribedFrom does.
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-abc",
    });
    const fireflies = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-xyz",
      upstream_links: [
        makeLink({
          relation: "SameEvent",
          platform: "Zoom",
          external_id: "zoom-abc",
          video_id: "zoom-uuid",
        }),
      ],
    });
    const result = resolveYouTubeCanonical(fireflies, [zoom, fireflies]);
    expect(result).not.toBeNull();
    expect(result!.canonical.id).toBe(fireflies.id);
  });
});

function makeLocation(overrides: Partial<PlatformLocationJSON>): PlatformLocationJSON {
  return {
    platform: "YouTube",
    external_id: "vJKe77EUCBY",
    external_url: "https://www.youtube.com/watch?v=vJKe77EUCBY",
    role: "Destination",
    ordinal: 0,
    synced_at: "2026-06-07T00:00:00Z",
    status: null,
    ...overrides,
  };
}

describe("findMissingYouTubeRows — C1-A work-list", () => {
  it("returns Destination YouTube locations with no matching source row", () => {
    const fireflies = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-xyz",
      locations: [makeLocation({ external_id: "vJKe77EUCBY" })],
    });
    const result = findMissingYouTubeRows([fireflies]);
    expect(result).toHaveLength(1);
    expect(result[0].youtubeVideoId).toBe("vJKe77EUCBY");
    expect(result[0].host.id).toBe(fireflies.id);
  });

  it("excludes pairs that are already complete (YT row exists AND has the expected BroadcastedFrom link)", () => {
    const fireflies = makeRecord({
      id: "fireflies-uuid",
      source_platform: "Fireflies",
      source_id: "fireflies-xyz",
      locations: [makeLocation({ external_id: "vJKe77EUCBY" })],
    });
    const youtube = makeRecord({
      source_platform: "YouTube",
      source_id: "youtube-vJKe77EUCBY",
      upstream_links: [
        makeLink({
          relation: "BroadcastedFrom",
          platform: "Fireflies",
          external_id: "fireflies-xyz",
          video_id: "fireflies-uuid",
        }),
      ],
    });
    const result = findMissingYouTubeRows([fireflies, youtube]);
    expect(result).toHaveLength(0);
  });

  it("INCLUDES partial pairs needing link repair (YT row exists but missing BroadcastedFrom link)", () => {
    // The exact scenario from the 2026-06-07 partial-run incident:
    // ingest succeeded, link write failed → orphan row in catalog.
    const fireflies = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-xyz",
      locations: [makeLocation({ external_id: "vJKe77EUCBY" })],
    });
    const youtube = makeRecord({
      source_platform: "YouTube",
      source_id: "youtube-vJKe77EUCBY",
      upstream_links: [],  // <-- missing!
    });
    const result = findMissingYouTubeRows([fireflies, youtube]);
    expect(result).toHaveLength(1);
    expect(result[0].youtubeVideoId).toBe("vJKe77EUCBY");
  });

  it("excludes pairs where the host doesn't qualify for auto-link (e.g. host=Loom, no canonical)", () => {
    // Loom hosts return null from resolveYouTubeCanonical, so the
    // YT row is correctly "standalone" and there's nothing to repair.
    const loom = makeRecord({
      source_platform: "Loom",
      source_id: "loom-stub",
      locations: [makeLocation({ external_id: "vJKe77EUCBY" })],
    });
    const youtube = makeRecord({
      source_platform: "YouTube",
      source_id: "youtube-vJKe77EUCBY",
      upstream_links: [],
    });
    expect(findMissingYouTubeRows([loom, youtube])).toHaveLength(0);
  });

  it("tolerates a `youtube-` prefixed external_id (operator-entered) and matches via the bare id", () => {
    const host = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-stub",
      locations: [makeLocation({ external_id: "youtube-vJKe77EUCBY" })],
    });
    const youtubeComplete = makeRecord({
      source_platform: "YouTube",
      source_id: "youtube-vJKe77EUCBY",
      upstream_links: [
        makeLink({
          relation: "BroadcastedFrom",
          platform: "Zoom",
          external_id: "zoom-stub",
          video_id: "zoom-uuid",
        }),
      ],
    });
    expect(findMissingYouTubeRows([host, youtubeComplete])).toHaveLength(0);
    expect(findMissingYouTubeRows([host])).toEqual([
      expect.objectContaining({ youtubeVideoId: "vJKe77EUCBY" }),
    ]);
  });

  it("dedupes by (youtubeVideoId, host.id) but keeps the same id seen across different hosts", () => {
    const hostA = makeRecord({
      id: "host-a",
      source_platform: "Fireflies",
      source_id: "fireflies-a",
      locations: [makeLocation({ external_id: "hJhlPPxbcG4" })],
    });
    const hostB = makeRecord({
      id: "host-b",
      source_platform: "Fireflies",
      source_id: "fireflies-b",
      locations: [makeLocation({ external_id: "hJhlPPxbcG4" })],
    });
    const result = findMissingYouTubeRows([hostA, hostB]);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((r) => r.host.id))).toEqual(new Set(["host-a", "host-b"]));
  });

  it("ignores Origin / Intermediate YouTube locations (only Destinations count as a publish target)", () => {
    const fireflies = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-xyz",
      locations: [
        makeLocation({ external_id: "vJKe77EUCBY", role: "Origin" }),
        makeLocation({ external_id: "ANotheRid_X", role: "Intermediate" }),
      ],
    });
    expect(findMissingYouTubeRows([fireflies])).toHaveLength(0);
  });

  it("skips malformed external_ids (not 11-char YouTube format)", () => {
    const host = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-xyz",
      locations: [
        makeLocation({ external_id: "not_a_youtube_id" }),
        makeLocation({ external_id: "" }),
      ],
    });
    expect(findMissingYouTubeRows([host])).toHaveLength(0);
  });
});

