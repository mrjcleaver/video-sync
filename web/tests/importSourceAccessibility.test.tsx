import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/wasm", () => ({
  WasmVideoRecord: class {
    id() { return "record-1"; }
  },
}));
vi.mock("../src/lib/store", () => ({
  videoStore: {
    add: vi.fn(),
    getAll: vi.fn(() => []),
    setTranscript: vi.fn(),
  },
}));
vi.mock("../src/lib/rules", () => ({ isExcluded: vi.fn(() => false) }));
vi.mock("../src/lib/provenanceLinker", () => ({ applyAutoLinks: vi.fn(() => 0) }));

import FirefliesImport from "../src/components/FirefliesImport";
import YouTubeImport from "../src/components/YouTubeImport";
import YouTubeLiveImport from "../src/components/YouTubeLiveImport";

const successResponse = {
  ok: true,
  status: 200,
  json: vi.fn(async () => ({
    transcripts: [{
      source_id: "fireflies-1",
      source_platform: "Fireflies",
      title: "Accessibility planning review",
      recorded_at: "2026-08-03T10:30:00Z",
      duration_seconds: 3180,
      participants: ["Adam", "Mira"],
      description: "Review the import workflow",
      transcript_text: "Sample transcript",
      download_url: "https://example.test/fireflies-1",
      tags: ["planning"],
    }],
  })),
};

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
}

describe("import source form accessibility", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders persistent Fireflies filter labels and pressed day state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => successResponse));
    render(
      <FirefliesImport
        onImported={vi.fn()}
        onEvent={vi.fn()}
        dateFrom="2026-07-01"
        dateTo="2026-08-01"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fetch from Fireflies" }));

    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect((screen.getByLabelText("Minimum minutes") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Maximum minutes") as HTMLInputElement).value).toBe("");
    const monday = screen.getByRole("button", { name: "Mon", pressed: false });
    fireEvent.click(monday);
    expect(screen.getByRole("button", { name: "Mon", pressed: true })).toBeTruthy();
  });

  it("announces fetch failures and associates them with the action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "Fireflies access denied." }),
    })));
    render(
      <FirefliesImport
        onImported={vi.fn()}
        onEvent={vi.fn()}
        dateFrom="2026-07-01"
        dateTo="2026-08-01"
      />,
    );

    const fetchButton = screen.getByRole("button", { name: "Fetch from Fireflies" });
    fireEvent.click(fetchButton);

    expect((await screen.findByRole("alert")).textContent).toContain("Fireflies access denied.");
    await waitFor(() => expect(fetchButton.getAttribute("aria-describedby")).toBe("fireflies-import-message"));
  });

  it("labels standalone dates and reports missing YouTube authorization", async () => {
    render(<YouTubeLiveImport onImported={vi.fn()} onEvent={vi.fn()} />);

    expect(screen.getByLabelText("From").getAttribute("type")).toBe("date");
    expect(screen.getByLabelText("To").getAttribute("type")).toBe("date");
    fireEvent.click(screen.getByRole("button", { name: "Fetch from YouTube" }));

    expect((await screen.findByRole("alert")).textContent).toContain("YouTube not authorised");
  });

  it("labels the YouTube URL control and links parsing errors to it", async () => {
    render(<YouTubeImport onImported={vi.fn()} onEvent={vi.fn()} />);

    const input = screen.getByLabelText("YouTube URL or video ID");
    fireEvent.change(input, { target: { value: "invalid" } });
    fireEvent.blur(input);

    expect((await screen.findByRole("alert")).textContent).toContain("Could not parse a YouTube video ID");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("youtube-import-message");
  });
});
