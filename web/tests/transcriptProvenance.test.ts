/**
 * Tests for ADR-053 transcript provenance resolver.
 */

import { describe, it, expect } from "vitest";
import {
  resolveTranscriptForOperation,
  findTranscriptDonors,
} from "../src/lib/transcriptProvenance";
import type { VideoRecordJSON, UpstreamLinkJSON } from "../src/lib/wasm";

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
    transcript_text: undefined,
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
    linked_at: "2026-06-08T00:00:00Z",
    ...overrides,
  };
}

const LONG_TRANSCRIPT = "x".repeat(500);

describe("resolveTranscriptForOperation — own-transcript path", () => {
  it("returns own transcript with kind:'own' when present and long enough", () => {
    const r = makeRecord({ transcript_text: LONG_TRANSCRIPT });
    const result = resolveTranscriptForOperation(r, [r]);
    expect(result).not.toBeNull();
    expect(result!.source.kind).toBe("own");
    expect(result!.text.length).toBe(500);
  });

  it("falls back to borrowed when own transcript is too short", () => {
    const target = makeRecord({
      id: "target",
      source_platform: "Zoom",
      source_id: "zoom-A",
      transcript_text: "x".repeat(50),  // below 200
    });
    const donor = makeRecord({
      id: "donor",
      source_platform: "Fireflies",
      source_id: "fireflies-A",
      upstream_links: [makeLink({
        relation: "TranscribedFrom",
        platform: "Zoom",
        external_id: "zoom-A",
        video_id: "target",
      })],
      transcript_text: LONG_TRANSCRIPT,
    });
    const result = resolveTranscriptForOperation(target, [target, donor]);
    expect(result).not.toBeNull();
    expect(result!.source.kind).toBe("borrowed");
    expect(result!.source.donor_record_id).toBe("donor");
  });

  it("returns null when nobody has a transcript", () => {
    const r = makeRecord({});
    expect(resolveTranscriptForOperation(r, [r])).toBeNull();
  });
});

describe("findTranscriptDonors — direction + safe-relations rules", () => {
  it("walks INCOMING TranscribedFrom (Fireflies bot → Zoom target)", () => {
    // Real-world: Zoom record has no own transcript, but the paired
    // Fireflies bot record (TranscribedFrom → Zoom) does.
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-A",
    });
    const fireflies = makeRecord({
      id: "ff-uuid",
      source_platform: "Fireflies",
      source_id: "fireflies-A",
      upstream_links: [makeLink({
        relation: "TranscribedFrom",
        platform: "Zoom",
        external_id: "zoom-A",
        video_id: "zoom-uuid",
      })],
      transcript_text: LONG_TRANSCRIPT,
    });
    const donors = findTranscriptDonors(zoom, [zoom, fireflies]);
    expect(donors).toHaveLength(1);
    expect(donors[0].donor.id).toBe("ff-uuid");
    expect(donors[0].direction).toBe("incoming");
    expect(donors[0].relation).toBe("TranscribedFrom");
  });

  it("walks OUTGOING BroadcastedFrom (YouTube → Zoom)", () => {
    // YouTube broadcast record's upstream_link points at the meeting
    // source. If meeting source has the transcript, YouTube borrows it.
    const zoom = makeRecord({
      id: "zoom-uuid",
      source_platform: "Zoom",
      source_id: "zoom-A",
      transcript_text: LONG_TRANSCRIPT,
    });
    const youtube = makeRecord({
      source_platform: "YouTube",
      source_id: "youtube-X",
      upstream_links: [makeLink({
        relation: "BroadcastedFrom",
        platform: "Zoom",
        external_id: "zoom-A",
        video_id: "zoom-uuid",
      })],
    });
    const donors = findTranscriptDonors(youtube, [zoom, youtube]);
    expect(donors).toHaveLength(1);
    expect(donors[0].donor.id).toBe("zoom-uuid");
    expect(donors[0].direction).toBe("outgoing");
  });

  it("EXCLUDES ClipOf donors (partial transcript — unsafe)", () => {
    const target = makeRecord({ id: "target", source_id: "src-A" });
    const clip = makeRecord({
      source_platform: "Zoom",
      source_id: "zoom-clip",
      upstream_links: [makeLink({
        relation: "ClipOf",
        platform: "Zoom",
        external_id: "src-A",
        video_id: "target",
      })],
      transcript_text: LONG_TRANSCRIPT,
    });
    expect(findTranscriptDonors(target, [target, clip])).toHaveLength(0);
  });

  it("EXCLUDES ScreenRecordingOf (different audio surface)", () => {
    const target = makeRecord({ id: "target", source_id: "src-A" });
    const screenRec = makeRecord({
      source_platform: "Loom",
      source_id: "loom-S",
      upstream_links: [makeLink({
        relation: "ScreenRecordingOf",
        platform: "Zoom",
        external_id: "src-A",
        video_id: "target",
      })],
      transcript_text: LONG_TRANSCRIPT,
    });
    expect(findTranscriptDonors(target, [target, screenRec])).toHaveLength(0);
  });

  it("EXCLUDES self even if record has a transcript long enough", () => {
    const r = makeRecord({ transcript_text: LONG_TRANSCRIPT });
    // findTranscriptDonors returns "other records that can donate" —
    // not the record itself. Self is the "own" path.
    expect(findTranscriptDonors(r, [r])).toHaveLength(0);
  });

  it("EXCLUDES donors whose transcript is shorter than minLength", () => {
    const target = makeRecord({ id: "target", source_id: "src-A" });
    const donor = makeRecord({
      source_platform: "Fireflies",
      source_id: "fireflies-A",
      upstream_links: [makeLink({
        relation: "TranscribedFrom",
        platform: "Zoom",
        external_id: "src-A",
      })],
      transcript_text: "x".repeat(50),  // below 200
    });
    expect(findTranscriptDonors(target, [target, donor])).toHaveLength(0);
  });
});

describe("findTranscriptDonors — priority ordering", () => {
  it("Fireflies > Zoom > YouTube > Kaltura when multiple donors exist", () => {
    const target = makeRecord({ id: "target", source_id: "src-A" });
    const makePeer = (platform: string, len: number) =>
      makeRecord({
        source_platform: platform,
        source_id: `${platform.toLowerCase()}-X`,
        upstream_links: [makeLink({
          relation: "SameEvent",
          platform: target.source_platform,
          external_id: target.source_id,
        })],
        transcript_text: "x".repeat(len),
      });
    const kaltura = makePeer("Kaltura", 800);
    const youtube = makePeer("YouTube", 800);
    const zoom = makePeer("Zoom", 800);
    const fireflies = makePeer("Fireflies", 800);
    const donors = findTranscriptDonors(target, [target, kaltura, youtube, zoom, fireflies]);
    const order = donors.map((d) => d.donor.source_platform);
    expect(order).toEqual(["Fireflies", "Zoom", "YouTube", "Kaltura"]);
  });

  it("longer transcript wins tiebreak within same platform", () => {
    const target = makeRecord({ id: "target", source_id: "src-A" });
    const shortFF = makeRecord({
      id: "ff-short",
      source_platform: "Fireflies",
      source_id: "fireflies-1",
      upstream_links: [makeLink({
        relation: "TranscribedFrom",
        platform: target.source_platform,
        external_id: target.source_id,
      })],
      transcript_text: "x".repeat(300),
    });
    const longFF = makeRecord({
      id: "ff-long",
      source_platform: "Fireflies",
      source_id: "fireflies-2",
      upstream_links: [makeLink({
        relation: "TranscribedFrom",
        platform: target.source_platform,
        external_id: target.source_id,
      })],
      transcript_text: "x".repeat(1500),
    });
    const donors = findTranscriptDonors(target, [target, shortFF, longFF]);
    expect(donors).toHaveLength(2);
    expect(donors[0].donor.id).toBe("ff-long");
    expect(donors[1].donor.id).toBe("ff-short");
  });
});
