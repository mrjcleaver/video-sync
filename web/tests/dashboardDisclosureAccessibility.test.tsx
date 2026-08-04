import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/store", () => ({
  bootStore: vi.fn().mockResolvedValue(undefined),
  videoStore: {
    getAll: () => [],
    mutate: vi.fn(),
    subscribe: () => () => {},
  },
}));
vi.mock("@/lib/rules", () => ({
  loadExclusions: () => [],
  syncExclusionsFromServer: vi.fn().mockResolvedValue(undefined),
  syncRulesFromServer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/backfill", () => ({
  syncProfilesFromServer: vi.fn().mockResolvedValue(undefined),
  syncQueueFromServer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/processingRules", () => ({
  syncPostProcessingRulesFromServer: vi.fn().mockResolvedValue(undefined),
  syncProcessingRulesFromServer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({ clientLog: vi.fn() }));
vi.mock("@/lib/useRuleRunner", () => ({
  useRuleRunner: () => ({ isRunning: false, lastRun: null, matchCount: 0, runNow: vi.fn() }),
}));
vi.mock("@/lib/useMemoryHealth", () => ({ useMemoryHealth: vi.fn() }));
vi.mock("@/lib/useCurrentActor", () => ({
  actorCommand: (_state: unknown, extra?: Record<string, unknown>) => extra ?? {},
  useCurrentActor: () => ({ actor: { user_id: "test", role: "admin" }, loading: false, error: null }),
}));
vi.mock("@/lib/broadcastPairs", () => ({
  buildBroadcastPairs: () => ({ destinationRecordIds: new Set(), upstreamToDestinations: new Map() }),
}));

vi.mock("@/components/ImportPanel", () => ({ default: () => <div /> }));
vi.mock("@/components/ConnectionsPanel", () => ({
  default: ({ open }: { open: boolean }) => open ? <section id="connections-panel" /> : null,
}));
vi.mock("@/components/SummaryPromptPanel", () => ({
  SUMMARY_PROMPT_PANEL_ID: "summary-prompt-panel",
  default: ({ open }: { open: boolean }) => open ? <div id="summary-prompt-panel" /> : null,
}));
vi.mock("@/components/CatchUpPanel", () => ({
  default: ({ open }: { open: boolean }) => open ? <div id="catch-up-panel" /> : null,
}));
vi.mock("@/components/RulesPanel", () => ({ default: () => <div /> }));
vi.mock("@/components/ProcessingRulesPanel", () => ({ default: () => <div /> }));
vi.mock("@/components/PostProcessingRulesPanel", () => ({ default: () => <div /> }));
vi.mock("@/components/BackfillPanel", () => ({ default: () => <div /> }));
vi.mock("@/components/SyncStatusPanel", () => ({ default: () => <div /> }));
vi.mock("@/components/VideoCard", () => ({ default: () => <div /> }));
vi.mock("@/components/ProvenanceGraph", () => ({ default: () => <div /> }));
vi.mock("@/components/EventLog", () => ({ default: () => <section id="event-log" /> }));
vi.mock("@/components/ErrorBoundary", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ShortsPanel", () => ({ default: () => <div /> }));

import Dashboard from "@/app/page";

afterEach(() => cleanup());

function expectRenderedControlsToResolve(container: HTMLElement) {
  for (const control of container.querySelectorAll<HTMLElement>("[aria-controls]")) {
    for (const id of control.getAttribute("aria-controls")!.split(/\s+/).filter(Boolean)) {
      expect(document.getElementById(id)).toBeTruthy();
    }
  }
}

describe("dashboard disclosure relationships", () => {
  it.each([
    ["Connections", "connections-panel"],
    ["View Logs", "event-log"],
    ["Summary prompt", "summary-prompt-panel"],
    ["Catch up", "catch-up-panel"],
  ])("only points %s at content while it is mounted", async (name, targetId) => {
    const { container } = render(<Dashboard />);
    const toggle = await screen.findByRole("button", { name });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    expect(document.getElementById(targetId)).toBeNull();
    expectRenderedControlsToResolve(container);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(targetId);
    expect(document.getElementById(targetId)).toBeTruthy();
    expectRenderedControlsToResolve(container);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    expect(document.getElementById(targetId)).toBeNull();
  });
});
