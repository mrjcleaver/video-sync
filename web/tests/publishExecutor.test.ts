/**
 * ADR-077 §3 — the executor and the destination adapters.
 *
 * The behaviours worth pinning:
 *   - a failing destination does not abort its peers (ADR-075's
 *     "each row shows its own result state")
 *   - destinations are pushed in declaration order, one at a time
 *   - `Other` is skipped rather than reported as success or failure
 *   - the YouTube SSE parser handles frames split across reads, and its
 *     stream-died diagnostic names the OOM case
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executePublish, adapterFor, type DestinationResult } from "../src/lib/publish/execute";
import { parseSseChunk, streamEndedMessage, youtubeAdapter } from "../src/lib/publish/adapters/youtube";
import { kalturaAdapter } from "../src/lib/publish/adapters/kaltura";
import { driveAdapter, extractDriveFolderId } from "../src/lib/publish/adapters/drive";
import type { DestinationSpec } from "../src/lib/youtubeTitleAlign";
import type { VideoRecordJSON } from "../src/lib/wasm";
import type { PublishCredentials } from "../src/lib/publish/types";

const YT: DestinationSpec = { platform: "YouTube", visibility: "public" };
const KAL: DestinationSpec = { platform: "Kaltura", visibility: "members" };
const DRIVE: DestinationSpec = { platform: "GoogleDrive", folder_id: "folder-abcdefghijklmnopqrst", share_scope: "inherit" };
const OTHER: DestinationSpec = { platform: "Other", label: "Vimeo", config: {} };

const record = { id: "rec-1", source_id: "zoom-1", source_platform: "Zoom", title: "T", recorded_at: null } as VideoRecordJSON;

const creds: PublishCredentials = {
  source: { zoomAccountId: "acct" },
  youtube: { refreshToken: "rt", clientId: "ci", clientSecret: "cs" },
  kaltura: { partnerId: "123", adminSecret: "sec" },
};

function baseRequest(destinations: DestinationSpec[]) {
  return {
    record,
    destinations,
    attrsFor: () => ({ title: "T", description: "D", tags: [], visibility: "public" }),
    sourceUrlFor: () => "zoom://rec-1",
    creds,
  };
}

/** Minimal SSE Response for the YouTube adapter. */
function sseResponse(chunks: string[], ok = true, status = 200): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok,
    status,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
      }),
    },
    json: async () => ({}),
  } as unknown as Response;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("adapterFor", () => {
  it("resolves the three platforms with push endpoints", () => {
    expect(adapterFor("YouTube")).toBe(youtubeAdapter);
    expect(adapterFor("Kaltura")).toBe(kalturaAdapter);
    expect(adapterFor("GoogleDrive")).toBe(driveAdapter);
  });

  it("has no adapter for Other, by design", () => {
    expect(adapterFor("Other")).toBeNull();
  });
});

describe("executePublish", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("pushes every destination and reports one outcome each", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(['event: complete\ndata: {"videoId":"yt-1","videoUrl":"https://youtu.be/yt-1"}\n\n']))
      .mockResolvedValueOnce(jsonResponse({ entryId: "kal-1", playerUrl: "https://kal/1" }));
    vi.stubGlobal("fetch", fetchMock);

    const seen: DestinationResult[] = [];
    const report = await executePublish({
      ...baseRequest([YT, KAL]),
      onOutcome: r => { seen.push(r); },
    });

    expect(report.pushed).toBe(2);
    expect(report.allPushed).toBe(true);
    expect(seen.map(r => r.spec.platform)).toEqual(["YouTube", "Kaltura"]);
    expect(seen[0].external_id).toBe("yt-1");
    expect(seen[1].external_id).toBe("kal-1");
  });

  it("keeps going when one destination fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "kaltura 503" }, false, 503))
      .mockResolvedValueOnce(jsonResponse({ drive_file_id: "d-1", web_view_link: "https://drive/1" }));
    vi.stubGlobal("fetch", fetchMock);

    const report = await executePublish(baseRequest([KAL, DRIVE]));

    expect(report.failed).toBe(1);
    expect(report.pushed).toBe(1);
    // ADR-077 §Decisions-resolved #1 — one landing is enough to publish.
    expect(report.anyPushed).toBe(true);
    expect(report.allPushed).toBe(false);
    expect(report.results[0]).toMatchObject({ status: "failed", error: "kaltura 503" });
    expect(report.results[1]).toMatchObject({ status: "pushed", external_id: "d-1" });
  });

  it("pushes in declaration order, not concurrently", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      order.push(String(url));
      if (String(url).includes("kaltura")) return jsonResponse({ entryId: "k" });
      return jsonResponse({ drive_file_id: "d" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await executePublish(baseRequest([KAL, DRIVE]));
    expect(order[0]).toContain("kaltura");
    expect(order[1]).toContain("drive");
  });

  it("skips a manual Other target instead of failing it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const report = await executePublish(baseRequest([OTHER]));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.anyPushed).toBe(false);
    expect(report.results[0].skipReason).toMatch(/manual target/);
  });

  it("reports nothing pushed as allPushed=false, not a vacuous true", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const report = await executePublish(baseRequest([OTHER]));
    expect(report.allPushed).toBe(false);
  });

  it("awaits onOutcome before starting the next destination", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async () => { events.push("push"); return jsonResponse({ entryId: "k" }); });
    vi.stubGlobal("fetch", fetchMock);

    await executePublish({
      ...baseRequest([KAL, KAL]),
      onOutcome: async () => {
        await Promise.resolve();
        events.push("recorded");
      },
    });

    // Recording an outcome must land before the next push, so a mid-run
    // failure can't leave the store behind the network.
    expect(events).toEqual(["push", "recorded", "push", "recorded"]);
  });
});

describe("youtube adapter — SSE handling", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("parses frames and returns any trailing partial line", () => {
    const { frames, rest } = parseSseChunk('event: progress\ndata: {"phase":"Downloading"}\n\nevent: comp');
    expect(frames).toEqual([{ event: "progress", data: { phase: "Downloading" } }]);
    expect(rest).toBe("event: comp");
  });

  it("survives an unparseable data frame", () => {
    const { frames } = parseSseChunk("event: progress\ndata: {not json}\n\n");
    expect(frames).toEqual([]);
  });

  it("reassembles a frame split across two reads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'event: progress\ndata: {"phase":"Downloading"}\n\nevent: comp',
      'lete\ndata: {"videoId":"yt-9","videoUrl":"https://youtu.be/yt-9"}\n\n',
    ])));

    const phases: string[] = [];
    const result = await youtubeAdapter.push({
      record, spec: YT, attrs: { title: "T", description: "D", tags: [], visibility: "public" },
      sourceUrl: "zoom://1", creds, onPhase: p => phases.push(p),
    });

    expect(result.external_id).toBe("yt-9");
    expect(phases).toEqual(["Downloading"]);
  });

  it("throws the server's error frame", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'event: error\ndata: {"message":"quota exceeded"}\n\n',
    ])));
    await expect(youtubeAdapter.push({
      record, spec: YT, attrs: { title: "T", description: "D", tags: [] },
      sourceUrl: "zoom://1", creds,
    })).rejects.toThrow("quota exceeded");
  });

  it("names the OOM case when the stream dies mid-trim", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'event: progress\ndata: {"phase":"Trimming 42s from start"}\n\n',
    ])));
    await expect(youtubeAdapter.push({
      record, spec: YT, attrs: { title: "T", description: "D", tags: [] },
      sourceUrl: "zoom://1", creds,
    })).rejects.toThrow(/Cloud Run OOM during ffmpeg trim/);
  });

  it("points at the logs when the stream dies outside a trim", () => {
    expect(streamEndedMessage("Uploading to YouTube")).toMatch(/check Cloud Run logs/);
    expect(streamEndedMessage("Uploading to YouTube")).not.toMatch(/OOM/);
  });

  it("refuses to push without YouTube credentials", async () => {
    await expect(youtubeAdapter.push({
      record, spec: YT, attrs: { title: "T", description: "D", tags: [] },
      sourceUrl: "zoom://1", creds: { source: {} },
    })).rejects.toThrow(/not authorized/);
  });
});

describe("kaltura adapter", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("stamps the catalog id as referenceId and forwards category ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entryId: "k-1", playerUrl: "https://kal/1" }));
    vi.stubGlobal("fetch", fetchMock);

    await kalturaAdapter.push({
      record,
      spec: { platform: "Kaltura", visibility: "members", category_ids: ["12", "34"] },
      attrs: { title: "T", description: "D", tags: ["a"] },
      sourceUrl: "zoom://1", creds,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.referenceId).toBe("rec-1");   // ADR-044
    expect(body.categoryIds).toEqual([12, 34]);
    // The gap ADR-077 §5 closes: no access-control field is sent, so the
    // declared `members` never reaches the entry.
    expect(body).not.toHaveProperty("accessControlId");
    expect(body).not.toHaveProperty("visibility");
  });

  it("fails when the endpoint returns no entryId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    await expect(kalturaAdapter.push({
      record, spec: KAL, attrs: { title: "T", description: "D", tags: [] },
      sourceUrl: "zoom://1", creds,
    })).rejects.toThrow(/no entryId/);
  });
});

describe("drive adapter", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("normalises a folder URL to a bare id", () => {
    expect(extractDriveFolderId("https://drive.google.com/drive/folders/abcdefghijklmnopqrstuv"))
      .toBe("abcdefghijklmnopqrstuv");
    expect(extractDriveFolderId("abcdefghijklmnopqrstuv")).toBe("abcdefghijklmnopqrstuv");
  });

  it("does not send a share scope, which is why visibility stays unapplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      drive_file_id: "d-1", web_view_link: "https://drive/1", bytes: 1024,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await driveAdapter.push({
      record, spec: DRIVE, attrs: { title: "T", description: "D", tags: [] },
      sourceUrl: "zoom://1", creds,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty("share_scope");
    expect(out.bytes).toBe(1024);
  });

  it("refuses a destination with no folder configured", async () => {
    await expect(driveAdapter.push({
      record,
      spec: { platform: "GoogleDrive", folder_id: "", share_scope: "inherit" },
      attrs: { title: "T", description: "D", tags: [] },
      sourceUrl: "zoom://1", creds,
    })).rejects.toThrow(/no folder_id/);
  });
});
