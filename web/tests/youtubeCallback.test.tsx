import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  router: { push: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
  useRouter: () => navigation.router,
}));

import YouTubeCallback from "../src/app/youtube-callback/page";

describe("YouTube callback", () => {
  let storedValues: Map<string, string>;

  beforeEach(() => {
    navigation.params = new URLSearchParams();
    navigation.router.push.mockReset();
    storedValues = new Map();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storedValues.get(key) ?? null,
        setItem: (key: string, value: string) => storedValues.set(key, value),
        removeItem: (key: string) => storedValues.delete(key),
        clear: () => storedValues.clear(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses a main landmark, heading, and alert for authorization errors", () => {
    navigation.params = new URLSearchParams("error=access_denied");

    render(<YouTubeCallback />);

    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "YouTube authorization" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Authorization denied: access_denied");
  });

  it("announces routine progress as a polite status", () => {
    document.body.innerHTML = renderToString(<YouTubeCallback />);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Completing YouTube authorization...");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});
