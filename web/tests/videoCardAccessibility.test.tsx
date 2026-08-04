import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { VideoRecordJSON } from "../src/lib/wasm";
import VideoCard from "../src/components/VideoCard";
import { videoStore } from "../src/lib/store";

vi.mock("../src/lib/useCurrentActor", () => ({
  useCurrentActor: () => ({
    actor: { user_id: "test-user", role: "Admin", email: "test@example.com" },
    loading: false,
    error: null,
  }),
  actorCommand: (_state: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ actor: { user_id: "test-user", role: "Admin" }, ...extra }),
}));

const baseVideo: VideoRecordJSON = {
  id: "video-a11y",
  source_id: "zoom-123",
  source_platform: "Zoom",
  title: "Accessible action review",
  description: null,
  created_at: "2026-08-04T12:00:00.000Z",
  duration_seconds: 1800,
  participants: ["Ada Lovelace"],
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
  recorded_at: null,
  published_at: null,
  destination_id: null,
  destination_url: null,
  locations: [{
    platform: "Zoom",
    external_id: "zoom-123",
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

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("VideoCard accessibility", () => {
  it("labels location, recovery, and note inputs and restores focus after cancelling deletion", async () => {
    render(<VideoCard video={baseVideo} onMutated={vi.fn()} onEvent={vi.fn()} />);

    const participantToggle = screen.getByRole("button", { name: /1 participant/ });
    expect(participantToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(participantToggle);
    expect(participantToggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(participantToggle.getAttribute("aria-controls")!)).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy catalog ID video-a11y" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add location" }));
    expect(screen.getByLabelText("Platform")).toBeTruthy();
    expect(screen.getByLabelText("External ID")).toBeTruthy();
    expect(screen.getByLabelText("URL (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Role")).toBeTruthy();
    for (const control of document.querySelectorAll<HTMLElement>("[aria-controls]")) {
      expect(document.getElementById(control.getAttribute("aria-controls")!)).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("button", { name: "Recover from YouTube" }));
    expect(screen.getByLabelText("Or paste a watch URL, Studio URL, or 11-character ID")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "+ Note" }));
    expect(screen.getByLabelText("Note")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const deleteAlert = screen.getByRole("alert");
    expect(deleteAlert.textContent).toContain("This cannot be undone");
    expect(within(deleteAlert).getByRole("button", { name: "Delete video" })).toBeTruthy();
    fireEvent.click(within(deleteAlert).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Delete video" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" })));
  });

  it("confirms location removal, restores focus on cancel, and announces success", async () => {
    const mutate = vi.spyOn(videoStore, "mutate").mockReturnValue("[]");
    render(<VideoCard video={baseVideo} onMutated={vi.fn()} onEvent={vi.fn()} />);

    const remove = screen.getByRole("button", { name: "Remove Zoom location zoom-123" });
    fireEvent.click(remove);
    const prompt = screen.getByRole("alert");
    expect(prompt.textContent).toContain("changes the catalog association");
    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(remove));

    fireEvent.click(remove);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Confirm removal" }));
    expect((await screen.findByRole("status")).textContent).toContain("Zoom location zoom-123 removed");
    mutate.mockRestore();
  });

  it("associates every publish preview label with its control", () => {
    render(
      <VideoCard
        video={{ ...baseVideo, status: "Publishing" }}
        onMutated={vi.fn()}
        onEvent={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    expect(screen.getByLabelText("Title")).toBeTruthy();
    expect(screen.getByLabelText("Description")).toBeTruthy();
    expect(screen.getByLabelText("Tags (comma-separated)")).toBeTruthy();
    expect(screen.getByLabelText("Privacy")).toBeTruthy();
    expect(screen.getByLabelText("Trim start (seconds)")).toBeTruthy();
  });

  it("announces transcript preparation and prevents duplicate Publish activation", async () => {
    localStorage.setItem("video-sync:processing-rules", JSON.stringify([{
      id: "llm-description",
      name: "Summarise transcript",
      enabled: true,
      priority: 1,
      criteria: {},
      transforms: { description: { mode: "transcript_llm" } },
    }]));
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <VideoCard
        video={{ ...baseVideo, status: "Publishing", transcript_text: "Transcript content. ".repeat(20) }}
        onMutated={vi.fn()}
        onEvent={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    const preparingButton = await screen.findByRole("button", { name: "Preparing…" });
    expect((preparingButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Summarising transcript");

    fireEvent.click(preparingButton);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("announces publishing progress and moves focus to the stable card heading", async () => {
    localStorage.setItem("video-sync:connections", JSON.stringify({
      YouTube: { credentials: { refreshToken: "refresh", clientId: "client", clientSecret: "secret" } },
    }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(
      <VideoCard
        video={{ ...baseVideo, status: "Publishing" }}
        onMutated={vi.fn()}
        onEvent={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    fireEvent.click(await screen.findByRole("button", { name: /^YouTube$/ }));
    expect((await screen.findByRole("status")).textContent).toContain("Uploading to YouTube");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3 })));
  });

  it("announces YouTube publishing failures", async () => {
    localStorage.setItem("video-sync:connections", JSON.stringify({
      YouTube: { credentials: { refreshToken: "refresh", clientId: "client", clientSecret: "secret" } },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "Upload exploded" }),
    })));
    const mutate = vi.spyOn(videoStore, "mutate").mockReturnValue("[]");

    render(
      <VideoCard
        video={{ ...baseVideo, status: "Publishing" }}
        onMutated={vi.fn()}
        onEvent={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    fireEvent.click(await screen.findByRole("button", { name: /^YouTube$/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("YouTube publishing failed: Upload exploded");
    mutate.mockRestore();
  });
});
