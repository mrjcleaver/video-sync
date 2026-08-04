import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BackfillOverview from "@/components/BackfillOverview";
import BackfillPanel from "@/components/BackfillPanel";
import PostProcessingRulesPanel from "@/components/PostProcessingRulesPanel";
import ProcessingRulesPanel from "@/components/ProcessingRulesPanel";
import RulesPanel from "@/components/RulesPanel";
import VideoCard from "@/components/VideoCard";
import type { BackfillProfile } from "@/lib/backfill";
import type { VideoRecordJSON } from "@/lib/wasm";

vi.mock("@/lib/useCurrentActor", () => ({
  actorCommand: (_state: unknown, extra?: Record<string, unknown>) => extra ?? {},
  useCurrentActor: () => ({ actor: { user_id: "test", role: "admin" }, loading: false, error: null }),
}));

function expectRenderedControlsToResolve(container: HTMLElement) {
  for (const control of container.querySelectorAll<HTMLElement>("[aria-controls]")) {
    const ids = control.getAttribute("aria-controls")!.split(/\s+/).filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(document.getElementById(id)).toBeTruthy();
  }
}

const profile: BackfillProfile = {
  id: "profile-1",
  name: "Review profile",
  enabled: true,
  source_platforms: ["Zoom"],
  date_from: "2026-07-01",
  date_to: "2026-07-31",
  criteria: { days_of_week: [1] },
  default_privacy: "unlisted",
  max_uploads_per_day: 2,
  upload_window_start_hour: 2,
};

const video: VideoRecordJSON = {
  id: "video-1",
  source_id: "zoom-1",
  source_platform: "Zoom",
  title: "Disclosure test video",
  description: "Test description",
  created_at: "2026-07-06T10:00:00Z",
  duration_seconds: 1800,
  participants: ["Ada", "Grace"],
  transcript_text: null,
  download_url: "https://example.com/video",
  thumbnail_url: null,
  tags: [],
  notes: [],
  owners: [],
  moderators: [],
  status: "Approved",
  curated_by: null,
  curated_at: null,
  indexed_at: "2026-07-06T10:00:00Z",
  recorded_at: "2026-07-06T10:00:00Z",
  published_at: null,
  destination_id: null,
  destination_url: null,
  locations: [],
  upstream_links: [],
  rejected_links: [],
  metadata_extra: null,
};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("conditional disclosure relationships", () => {
  it.each([
    ["Ingestion Rules", () => <RulesPanel isRunnerRunning={false} lastRun={null} matchCount={0} onRunNow={vi.fn()} />],
    ["Processing Rules", () => <ProcessingRulesPanel />],
    ["Post-processing Rules", () => <PostProcessingRulesPanel />],
  ])("only points %s at mounted content", (name, build) => {
    const { container } = render(build());
    const toggle = screen.getByRole("button", { name: new RegExp(`^${name}`, "i") });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    expectRenderedControlsToResolve(container);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expectRenderedControlsToResolve(container);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    expectRenderedControlsToResolve(container);
  });

  it("only points calendar month controls at expanded month content", () => {
    const { container } = render(<BackfillOverview videos={[]} profile={profile} />);
    const month = screen.getByRole("button", { name: /Jul 2026/ });

    expect(month.getAttribute("aria-expanded")).toBe("false");
    expect(month.hasAttribute("aria-controls")).toBe(false);
    expectRenderedControlsToResolve(container);

    fireEvent.click(month);
    expect(month.getAttribute("aria-expanded")).toBe("true");
    expectRenderedControlsToResolve(container);

    fireEvent.click(month);
    expect(month.getAttribute("aria-expanded")).toBe("false");
    expect(month.hasAttribute("aria-controls")).toBe(false);
  });

  it("only points queue controls at expanded queue details", () => {
    localStorage.setItem("video-sync:backfill-profiles", JSON.stringify([profile]));
    localStorage.setItem("video-sync:backfill-queue", JSON.stringify([
      { video_id: video.id, profile_id: profile.id, queued_at: "2026-07-06T10:00:00Z", attempts: 0 },
    ]));

    const { container } = render(
      <BackfillPanel videos={[video]} onEvent={vi.fn()} onMutated={vi.fn()} />,
    );
    const toggle = screen.getByRole("button", { name: /Disclosure test video/ });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    expectRenderedControlsToResolve(container);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expectRenderedControlsToResolve(container);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
  });

  it("only points the participant control at mounted participant content", () => {
    const { container } = render(
      <VideoCard video={video} allVideos={[video]} onMutated={vi.fn()} onEvent={vi.fn()} />,
    );
    const toggle = screen.getByRole("button", { name: /2 participants/ });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    expectRenderedControlsToResolve(container);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expectRenderedControlsToResolve(container);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
  });
});
