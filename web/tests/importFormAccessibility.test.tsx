import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import IndexForm from "../src/components/IndexForm";
import URLImport from "../src/components/URLImport";

afterEach(() => {
  cleanup();
});

describe("import form accessibility", () => {
  it("gives every manual video field a persistent accessible label", () => {
    render(<IndexForm onIndexed={vi.fn()} onEvent={vi.fn()} />);

    const toggle = screen.getByRole("button", { name: "Manual entry" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Title *")).toBeTruthy();
    expect(screen.getByLabelText("Platform")).toBeTruthy();
    expect(screen.getByLabelText("Source ID")).toBeTruthy();
    expect(screen.getByLabelText("Duration (seconds)")).toBeTruthy();
    expect(screen.getByLabelText("Description")).toBeTruthy();
    expect(screen.getByLabelText("Download URL")).toBeTruthy();
    expect(screen.getByLabelText("Tags (comma-separated)")).toBeTruthy();
  });

  it("labels the URL input and associates its keyboard instructions", () => {
    render(<URLImport onImported={vi.fn()} onEvent={vi.fn()} />);

    const input = screen.getByLabelText("Video URLs");
    expect(input.getAttribute("aria-describedby")).toBe("url-import-help");
    expect(screen.getByText("One URL per line. Press Ctrl+Enter or Command+Enter to fetch.")).toBeTruthy();
  });
});
