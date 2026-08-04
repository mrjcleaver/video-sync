import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { VideoRecordJSON } from "../src/lib/wasm";

const storeHarness = vi.hoisted(() => ({
  videos: [] as VideoRecordJSON[],
  listeners: new Set<() => void>(),
}));

const markPublished = (id: string, payload: string) => {
  const command = JSON.parse(payload) as {
    destination_id: string;
    destination_url: string;
    destination_platform?: string;
  };
  storeHarness.videos = storeHarness.videos.map((video) => video.id === id
    ? {
        ...video,
        status: "Published",
        published_at: "2026-08-04T14:00:00.000Z",
        destination_id: command.destination_id,
        destination_url: command.destination_url,
        locations: [...video.locations, {
          platform: command.destination_platform ?? "YouTube",
          external_id: command.destination_id,
          external_url: command.destination_url,
          role: "Destination",
          ordinal: video.locations.length,
          synced_at: "2026-08-04T14:00:00.000Z",
          status: null,
        }],
      }
    : video);
};

const videoStoreMock = vi.hoisted(() => ({
  getAll: vi.fn(() => storeHarness.videos),
  subscribe: vi.fn((listener: () => void) => {
    storeHarness.listeners.add(listener);
    return () => storeHarness.listeners.delete(listener);
  }),
  mutate: vi.fn((id: string, operation: (record: { mark_published: (payload: string) => string }) => unknown) => {
    operation({ mark_published: (payload: string) => {
      markPublished(id, payload);
      return "[]";
    } });
    return "[]";
  }),
  remove: vi.fn((id: string) => {
    storeHarness.videos = storeHarness.videos.filter((video) => video.id !== id);
  }),
}));

vi.mock("../src/lib/store", () => ({
  bootStore: vi.fn(async () => {}),
  videoStore: videoStoreMock,
}));

vi.mock("../src/lib/useCurrentActor", () => ({
  useCurrentActor: () => ({
    actor: { user_id: "test-user", role: "Admin", email: "test@example.com" },
    loading: false,
    error: null,
  }),
  actorCommand: (_state: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ actor: { user_id: "test-user", role: "Admin" }, ...extra }),
}));

vi.mock("../src/lib/useRuleRunner", () => ({
  useRuleRunner: () => ({ isRunning: false, lastRun: null, matchCount: 0, runNow: vi.fn() }),
}));
vi.mock("../src/lib/useMemoryHealth", () => ({ useMemoryHealth: vi.fn() }));
vi.mock("../src/lib/logger", () => ({ clientLog: vi.fn(), loadClientLog: () => [] }));

vi.mock("../src/lib/rules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rules")>();
  return {
    ...actual,
    syncRulesFromServer: vi.fn(async () => {}),
    syncExclusionsFromServer: vi.fn(async () => {}),
  };
});
vi.mock("../src/lib/backfill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backfill")>();
  return {
    ...actual,
    syncProfilesFromServer: vi.fn(async () => {}),
    syncQueueFromServer: vi.fn(async () => {}),
  };
});
vi.mock("../src/lib/processingRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/processingRules")>();
  return {
    ...actual,
    syncProcessingRulesFromServer: vi.fn(async () => {}),
    syncPostProcessingRulesFromServer: vi.fn(async () => {}),
  };
});

vi.mock("../src/components/ImportPanel", () => ({ default: () => null }));
vi.mock("../src/components/ConnectionsPanel", () => ({ default: () => null }));
vi.mock("../src/components/SummaryPromptPanel", () => ({ default: () => null }));
vi.mock("../src/components/CatchUpPanel", () => ({ default: () => null }));
vi.mock("../src/components/RulesPanel", () => ({ default: () => null }));
vi.mock("../src/components/ProcessingRulesPanel", () => ({ default: () => null }));
vi.mock("../src/components/PostProcessingRulesPanel", () => ({ default: () => null }));
vi.mock("../src/components/BackfillPanel", () => ({ default: () => null }));
vi.mock("../src/components/SyncStatusPanel", () => ({ default: () => null }));
vi.mock("../src/components/ProvenanceGraph", () => ({ default: () => null }));
vi.mock("../src/components/EventLog", () => ({ default: () => null }));
vi.mock("../src/components/ShortsPanel", () => ({ default: () => null }));

import Dashboard from "../src/app/page";

const baseVideo: VideoRecordJSON = {
  id: "video-base",
  source_id: "zoom-base",
  source_platform: "Zoom",
  title: "Base video",
  description: null,
  created_at: "2026-08-04T12:00:00.000Z",
  duration_seconds: 1800,
  participants: [],
  transcript_text: null,
  download_url: "https://example.com/video",
  thumbnail_url: null,
  tags: [],
  notes: [],
  owners: [],
  moderators: [],
  status: "Discovered",
  curated_by: null,
  curated_at: null,
  indexed_at: "2026-08-04T12:00:00.000Z",
  recorded_at: "2026-08-04T12:00:00.000Z",
  published_at: null,
  destination_id: null,
  destination_url: null,
  locations: [{
    platform: "Zoom",
    external_id: "zoom-base",
    external_url: "https://example.com/video",
    role: "Origin",
    ordinal: 0,
    synced_at: "2026-08-04T12:00:00.000Z",
    status: null,
  }],
  upstream_links: [],
  rejected_links: [],
  metadata_extra: null,
};

function makeVideo(id: string, title: string, recordedAt: string, status = "Discovered"): VideoRecordJSON {
  return {
    ...baseVideo,
    id,
    source_id: `zoom-${id}`,
    title,
    status,
    indexed_at: recordedAt,
    recorded_at: recordedAt,
    locations: [{ ...baseVideo.locations[0], external_id: `zoom-${id}` }],
  };
}

function youtubeUploadResponse() {
  const payload = 'event: complete\ndata: {"videoId":"abcdefghijk","videoUrl":"https://youtu.be/abcdefghijk"}\n\n';
  const bytes = Uint8Array.from(payload, (character) => character.charCodeAt(0));
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: vi.fn(async () => ({ done: false, value: bytes })) }) },
  };
}

beforeAll(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    },
  });
});

beforeEach(() => {
  localStorage.clear();
  storeHarness.videos = [];
  storeHarness.listeners.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard video action feedback", () => {
  it.each(["YouTube", "Kaltura"] as const)(
    "keeps %s publish completion announced and focused after the Active card unmounts",
    async (platform) => {
      storeHarness.videos = [makeVideo("publishing", "Publishing review", "2026-08-04T13:00:00.000Z", "Publishing")];
      if (platform === "YouTube") {
        localStorage.setItem("video-sync:connections", JSON.stringify({
          YouTube: { credentials: { refreshToken: "refresh", clientId: "client", clientSecret: "secret" } },
        }));
      }
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/youtube/upload") return youtubeUploadResponse();
        if (url === "/api/kaltura/upload") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ entryId: "kaltura-entry", playerUrl: "https://kaltura.example/entry" }),
          };
        }
        return { ok: false, status: 500, text: async () => "not available" };
      }));

      render(<Dashboard />);
      await screen.findByRole("heading", { name: "Publishing review" });
      fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
      fireEvent.click(await screen.findByRole("button", { name: platform }));

      await waitFor(() => {
        expect(screen.queryByRole("heading", { name: "Publishing review" })).toBeNull();
      });
      const message = '"Publishing review" was published to ' + platform + " successfully.";
      const status = screen.getByText(message).closest('[role="status"]') as HTMLElement;
      expect(status).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(status));
    },
  );

  it("moves deletion focus to the next card, then the previous card when no next card remains", async () => {
    storeHarness.videos = [
      makeVideo("first", "First video", "2026-08-04T15:00:00.000Z"),
      makeVideo("second", "Second video", "2026-08-04T14:00:00.000Z"),
      makeVideo("third", "Third video", "2026-08-04T13:00:00.000Z"),
    ];

    render(<Dashboard />);
    await screen.findByRole("heading", { name: "Second video" });

    const secondCard = screen.getByRole("heading", { name: "Second video" }).closest(".video-card") as HTMLElement;
    fireEvent.click(within(secondCard).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(secondCard).getByRole("button", { name: "Delete video" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Third video" })));

    const thirdCard = screen.getByRole("heading", { name: "Third video" }).closest(".video-card") as HTMLElement;
    fireEvent.click(within(thirdCard).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(thirdCard).getByRole("button", { name: "Delete video" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "First video" })));
  });
});
