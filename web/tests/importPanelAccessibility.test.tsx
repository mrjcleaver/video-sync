import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/ZoomImport", () => ({ default: () => <div>Zoom source</div> }));
vi.mock("../src/components/FirefliesImport", () => ({ default: () => <div>Fireflies source</div> }));
vi.mock("../src/components/KalturaImport", () => ({ default: () => <div>Kaltura source</div> }));
vi.mock("../src/components/YouTubeLiveImport", () => ({ default: () => <div>YouTube source</div> }));
vi.mock("../src/components/URLImport", () => ({ default: () => <div>URL source</div> }));
vi.mock("../src/components/IndexForm", () => ({ default: () => <div>Manual source</div> }));

import ImportPanel from "../src/components/ImportPanel";

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
}

describe("ImportPanel accessibility", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  it("labels the import mode and shared date range", () => {
    render(<ImportPanel onImported={vi.fn()} onEvent={vi.fn()} />);

    expect(screen.getByRole("group", { name: "Import method" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Meetings", pressed: true })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Date range" })).toBeTruthy();
    expect(screen.getByLabelText("From").getAttribute("type")).toBe("date");
    expect(screen.getByLabelText("To").getAttribute("type")).toBe("date");
  });

  it("exposes the selected import tab after switching modes", () => {
    render(<ImportPanel onImported={vi.fn()} onEvent={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "URL" }));

    expect(screen.getByRole("button", { name: "URL", pressed: true })).toBeTruthy();
    expect(screen.getByRole("region", { name: "URL" }).textContent).toContain("URL source");
  });

  it("only references the import panel that is present in the DOM", () => {
    render(<ImportPanel onImported={vi.fn()} onEvent={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Meetings" }).getAttribute("aria-controls")).toBe("import-panel-meetings");
    expect(screen.getByRole("button", { name: "URL" }).hasAttribute("aria-controls")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "URL" }));

    expect(screen.getByRole("button", { name: "Meetings" }).hasAttribute("aria-controls")).toBe(false);
    expect(screen.getByRole("button", { name: "URL" }).getAttribute("aria-controls")).toBe("import-panel-url");
  });

  it("moves between import tabs with arrow keys", () => {
    render(<ImportPanel onImported={vi.fn()} onEvent={vi.fn()} />);

    const meetingsTab = screen.getByRole("button", { name: "Meetings" });
    meetingsTab.focus();
    fireEvent.keyDown(meetingsTab, { key: "ArrowRight" });

    const urlTab = screen.getByRole("button", { name: "URL", pressed: true });
    expect(document.activeElement).toBe(urlTab);
  });
});
