import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import BackfillPanel from "../src/components/BackfillPanel";
import ConfirmDialog from "../src/components/ConfirmDialog";
import RulesPanel from "../src/components/RulesPanel";

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
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("configuration form accessibility", () => {
  it("exposes ingestion rule fields and toggle state", () => {
    render(
      <RulesPanel
        isRunnerRunning={false}
        lastRun={null}
        matchCount={0}
        onRunNow={vi.fn()}
      />
    );

    const panelToggle = screen.getByRole("button", { name: /Ingestion rules/ });
    fireEvent.click(panelToggle);
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Priority (lower = first)")).toBeTruthy();
    expect(screen.getByLabelText("Action")).toBeTruthy();
    expect(screen.getByLabelText("Title pattern (regex)")).toBeTruthy();
    expect(screen.getByLabelText("Title exclude (regex)")).toBeTruthy();
    expect(screen.getByLabelText("Minimum duration (minutes)")).toBeTruthy();
    expect(screen.getByLabelText("Maximum duration (minutes)")).toBeTruthy();
    expect(screen.getByLabelText("Date from")).toBeTruthy();
    expect(screen.getByLabelText("Date to")).toBeTruthy();

    const thursday = screen.getByRole("button", { name: "Thu" });
    expect(thursday.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(thursday);
    expect(thursday.getAttribute("aria-pressed")).toBe("true");
  });

  it("groups and labels backfill profile settings", () => {
    render(
      <BackfillPanel
        videos={[]}
        onEvent={vi.fn()}
        onMutated={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));

    expect(screen.getByRole("group", { name: "Profile details" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Source and schedule" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Selection criteria" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Publishing limits" })).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Date from")).toBeTruthy();
    expect(screen.getByLabelText("Date to")).toBeTruthy();
    expect(screen.getByLabelText("Minimum duration (minutes)")).toBeTruthy();
    expect(screen.getByLabelText("Default privacy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Thu" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("confirmation dialog", () => {
  it("provides a named modal and supports cancellation", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete profile?"
        description="This permanently removes the selected profile."
        confirmLabel="Delete profile"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: "Delete profile?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
