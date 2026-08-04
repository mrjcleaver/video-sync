import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { VideoRecordJSON } from "../src/lib/wasm";
import VideoCard from "../src/components/VideoCard";

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
afterEach(() => cleanup());

describe("VideoCard accessibility", () => {
  it("labels location, recovery, and note inputs and confirms deletion inline", () => {
    render(<VideoCard video={baseVideo} onMutated={vi.fn()} onEvent={vi.fn()} />);

    const participantToggle = screen.getByRole("button", { name: /1 participant/ });
    expect(participantToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(participantToggle);
    expect(participantToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy catalog ID video-a11y" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add location" }));
    expect(screen.getByLabelText("Platform")).toBeTruthy();
    expect(screen.getByLabelText("External ID")).toBeTruthy();
    expect(screen.getByLabelText("URL (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Role")).toBeTruthy();

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
});
