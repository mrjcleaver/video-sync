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

    expect(screen.getByRole("tablist", { name: "Import method" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Meetings", selected: true })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Date range" })).toBeTruthy();
    expect(screen.getByLabelText("From").getAttribute("type")).toBe("date");
    expect(screen.getByLabelText("To").getAttribute("type")).toBe("date");
  });

  it("exposes the selected import tab after switching modes", () => {
    render(<ImportPanel onImported={vi.fn()} onEvent={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "URL" }));

    expect(screen.getByRole("tab", { name: "URL", selected: true })).toBeTruthy();
    expect(screen.getByRole("tabpanel", { name: "URL" }).textContent).toContain("URL source");
  });

  it("moves between import tabs with arrow keys", () => {
    render(<ImportPanel onImported={vi.fn()} onEvent={vi.fn()} />);

    const meetingsTab = screen.getByRole("tab", { name: "Meetings" });
    meetingsTab.focus();
    fireEvent.keyDown(meetingsTab, { key: "ArrowRight" });

    const urlTab = screen.getByRole("tab", { name: "URL", selected: true });
    expect(document.activeElement).toBe(urlTab);
  });
});
