import React from "react";
import { readFileSync } from "node:fs";
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
  it("keeps rule editors theme-safe and narrow-screen rows wrappable", () => {
    const css = readFileSync(`${process.cwd()}/src/app/globals.css`, "utf8");

    expect(css).toMatch(/\.rule-form\s*\{[^}]*border:\s*1px solid var\(--text-muted\)/s);
    expect(css).toMatch(/\.rule-item-name\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.rule-item-name\s*\{[^}]*flex-basis:/);
  });

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
    expect(panelToggle.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(panelToggle);
    expect(panelToggle.getAttribute("aria-controls")).toBe("ingestion-rules-content");
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

  it("identifies and focuses a blank ingestion-rule name", () => {
    render(
      <RulesPanel
        isRunnerRunning={false}
        lastRun={null}
        matchCount={0}
        onRunNow={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Ingestion rules/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const name = screen.getByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(name.getAttribute("required")).not.toBeNull();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("ingestion-rule-name-error");
    expect(screen.getByRole("alert").textContent).toBe("Enter a rule name.");
    expect(document.activeElement).toBe(name);
  });

  it("uses wrapping hooks for ingestion-rule rows", () => {
    localStorage.setItem("video-sync:rules", JSON.stringify([{
      id: "ingestion-1",
      name: "A very long ingestion rule name that must wrap at narrow widths",
      enabled: true,
      priority: 10,
      criteria: {},
      action: "mark_in_scope",
    }]));

    const { container } = render(
      <RulesPanel
        isRunnerRunning={false}
        lastRun={null}
        matchCount={0}
        onRunNow={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Ingestion rules/ }));

    expect(container.querySelector(".rule-item-row")).toBeTruthy();
    expect(container.querySelector(".rule-item-name")?.textContent).toContain("very long ingestion");
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
