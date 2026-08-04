import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ProcessingRulesPanel from "../src/components/ProcessingRulesPanel";
import PostProcessingRulesPanel from "../src/components/PostProcessingRulesPanel";
import SummaryPromptPanel, { SUMMARY_PROMPT_PANEL_ID } from "../src/components/SummaryPromptPanel";
import SyncStatusPanel from "../src/components/SyncStatusPanel";

const mocks = vi.hoisted(() => ({
  processingRules: [] as Array<Record<string, unknown>>,
  postRules: [] as Array<Record<string, unknown>>,
  saveProcessingRules: vi.fn(),
  savePostProcessingRules: vi.fn(),
}));

vi.mock("../src/lib/processingRules", () => ({
  loadProcessingRules: () => mocks.processingRules,
  saveProcessingRules: mocks.saveProcessingRules,
  loadPostProcessingRules: () => mocks.postRules,
  savePostProcessingRules: mocks.savePostProcessingRules,
  applyProcessingRules: () => ({
    title: "Preview title",
    description: "",
    tags: [],
    privacy_status: "unlisted",
    trim_start_seconds: 0,
  }),
  renderTemplate: () => "Preview title",
  requestLlmSummary: vi.fn(),
}));

vi.mock("../src/lib/store", () => ({
  videoStore: {
    getAll: () => [],
    mutate: vi.fn(),
  },
}));

vi.mock("../src/lib/backfill", () => ({
  loadProfiles: () => [],
}));

vi.mock("../src/components/BackfillOverview", () => ({
  default: () => <div>Overview content</div>,
}));

vi.mock("../src/components/BackfillCalendar", () => ({
  default: () => <div>Calendar content</div>,
}));

vi.mock("../src/lib/useCurrentActor", () => ({
  useCurrentActor: () => ({ actor: { role: "Admin" } }),
  actorCommand: vi.fn(),
}));

vi.mock("../src/lib/summaryPromptClient", () => ({
  invalidateCurrentPromptVersion: vi.fn(),
}));

vi.mock("../src/lib/llmCost", () => ({
  estimatePerRecordCost: () => 0,
  estimateBatchCost: () => 0,
  formatUsd: () => "<$0.01",
  isKnownModel: () => true,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  mocks.processingRules = [];
  mocks.postRules = [];
  mocks.saveProcessingRules.mockClear();
  mocks.savePostProcessingRules.mockClear();
});

describe("rule editor accessibility", () => {
  it("associates processing-rule labels and exposes toggle state", () => {
    render(<ProcessingRulesPanel expanded />);

    const disclosure = screen.getByRole("button", { name: "Processing rules" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure.hasAttribute("aria-controls")).toBe(true);
    expect(screen.getByLabelText("Preview video")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Priority")).toBeTruthy();
    expect(screen.getByLabelText("Title pattern (regex)")).toBeTruthy();
    expect(screen.getByLabelText("Privacy status")).toBeTruthy();

    const zoom = screen.getByRole("button", { name: "Zoom" });
    expect(zoom.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(zoom);
    expect(zoom.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(screen.getByRole("alert").textContent).toBe("Enter a rule name.");
  });

  it("requires an inline confirmation before deleting a post-processing rule", () => {
    mocks.postRules = [{
      id: "post-1",
      name: "Notify producer",
      enabled: true,
      trigger: "success",
      action: { type: "webhook", url: "https://example.test/hook" },
    }];

    render(<PostProcessingRulesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Post-processing rules/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("group", { name: "Confirm deletion of Notify producer" })).toBeTruthy();
    expect(mocks.savePostProcessingRules).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(mocks.savePostProcessingRules).toHaveBeenCalledWith([]);
    expect(screen.getByRole("status").textContent).toBe("Notify producer deleted.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add rule" }));
  });

  it("requires an inline confirmation before deleting a processing rule", () => {
    mocks.processingRules = [{
      id: "proc-1",
      name: "Normalize title",
      enabled: true,
      priority: 10,
      criteria: {},
      transforms: { title: { mode: "template", value: "{{title}}" } },
    }];

    render(<ProcessingRulesPanel expanded />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("group", { name: "Confirm deletion of Normalize title" })).toBeTruthy();
    expect(mocks.saveProcessingRules).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(mocks.saveProcessingRules).toHaveBeenCalledWith([]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add rule" }));
  });

  it("associates post-processing fields with their visible labels", () => {
    render(<PostProcessingRulesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Post-processing rules" }));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Trigger")).toBeTruthy();
    expect(screen.getByLabelText("Type")).toBeTruthy();
    expect(screen.getByLabelText("Webhook URL")).toBeTruthy();
  });

  it("describes only the invalid post-processing field", () => {
    render(<PostProcessingRulesPanel />);
    const disclosure = screen.getByRole("button", { name: "Post-processing rules" });
    expect(disclosure.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(disclosure);
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    const name = screen.getByLabelText("Name");
    const webhookUrl = screen.getByLabelText("Webhook URL");
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    expect(name.getAttribute("aria-describedby")).toBeTruthy();
    expect(webhookUrl.hasAttribute("aria-describedby")).toBe(false);

    fireEvent.change(name, { target: { value: "Notify producer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    expect(name.hasAttribute("aria-describedby")).toBe(false);
    expect(webhookUrl.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Enter a webhook URL.");
  });
});

describe("panel accessibility", () => {
  it("names the Sync Status profile and exposes the selected tab", () => {
    render(<SyncStatusPanel videos={[]} />);

    expect(screen.getByLabelText("Profile")).toBeTruthy();
    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    const calendarTab = screen.getByRole("tab", { name: "Calendar" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(overviewTab.hasAttribute("aria-controls")).toBe(true);
    expect(calendarTab.hasAttribute("aria-controls")).toBe(false);
    expect(screen.getByRole("tabpanel").textContent).toContain("Overview content");

    fireEvent.click(calendarTab);
    expect(calendarTab.getAttribute("aria-selected")).toBe("true");
    expect(calendarTab.hasAttribute("aria-controls")).toBe(true);
    expect(overviewTab.hasAttribute("aria-controls")).toBe(false);
    expect(screen.getByRole("tabpanel").textContent).toContain("Calendar content");
  });

  it("associates the summary prompt fields with their visible labels", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        text: "Summarize the transcript.",
        model: "google/gemini-2.5-pro",
        updated_at: "2026-05-27T00:00:00.000Z",
        updated_by: "system",
      }),
    }));

    const onClose = vi.fn();
    render(<SummaryPromptPanel open videos={[]} onClose={onClose} />);

    expect(await screen.findByRole("dialog", { name: "Summary prompt (ADR-046)" })).toBeTruthy();
    expect(screen.getByRole("dialog").id).toBe(SUMMARY_PROMPT_PANEL_ID);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByLabelText("Prompt text")).toBeTruthy();
    expect(screen.getByLabelText("Model (OpenRouter slug)")).toBeTruthy();
    expect(screen.getByLabelText(/Cost cap/)).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
