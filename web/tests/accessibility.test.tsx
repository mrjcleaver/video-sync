import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import HelpTip from "@/components/HelpTip";
import ImportPanel from "@/components/ImportPanel";
import { TranscriptLozenge } from "@/components/TranscriptLozenge";

vi.mock("@/components/ZoomImport", () => ({ default: () => <div>Zoom import</div> }));
vi.mock("@/components/FirefliesImport", () => ({ default: () => <div>Fireflies import</div> }));
vi.mock("@/components/KalturaImport", () => ({ default: () => <div>Kaltura import</div> }));
vi.mock("@/components/YouTubeLiveImport", () => ({ default: () => <div>YouTube Live import</div> }));
vi.mock("@/components/URLImport", () => ({ default: () => <div>URL import form</div> }));
vi.mock("@/components/IndexForm", () => ({ default: () => <div>Manual import form</div> }));

afterEach(() => {
  cleanup();
});

describe("shared accessibility behavior", () => {
  it("exposes help text through an expanded disclosure", () => {
    render(<HelpTip>Keyboard help</HelpTip>);

    const button = screen.getByRole("button", { name: "Help" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(screen.queryByText("Keyboard help")).toBeNull();

    fireEvent.click(button);

    const content = screen.getByText("Keyboard help");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(content.id);
    expect(document.getElementById(content.id)).toBe(content);

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(document.getElementById(content.id)).toBeNull();
  });

  it("reports import selection and labels the shared date range", () => {
    render(<ImportPanel onImported={vi.fn()} onEvent={vi.fn()} />);

    expect(screen.getByRole("group", { name: "Import method" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Meetings" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("From").getAttribute("type")).toBe("date");
    expect(screen.getByLabelText("To").getAttribute("type")).toBe("date");

    fireEvent.click(screen.getByRole("button", { name: "URL" }));

    expect(screen.getByRole("button", { name: "URL" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("URL import form")).toBeTruthy();
  });

  it("uses a native button for the Kaltura transcript action", () => {
    render(
      <TranscriptLozenge
        recordId="record-1"
        sourcePlatform="Kaltura"
        sourceId="entry-1"
        transcriptText={null}
      />,
    );

    const action = screen.getByRole("button", { name: "Fetch transcript" });
    expect(action.getAttribute("type")).toBe("button");
    expect(action.hasAttribute("disabled")).toBe(false);
  });
});
