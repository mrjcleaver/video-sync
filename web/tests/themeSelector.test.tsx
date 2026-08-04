import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import ThemeSelector, { THEME_STORAGE_KEY } from "../src/components/ThemeSelector";
import ThemeRuntime from "../src/components/ThemeRuntime";

describe("ThemeSelector", () => {
  let systemPrefersDark = false;
  let systemListeners: Set<() => void>;
  let storedPreferences: Map<string, string>;

  beforeEach(() => {
    systemPrefersDark = false;
    systemListeners = new Set();
    storedPreferences = new Map();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storedPreferences.get(key) ?? null,
        setItem: (key: string, value: string) => storedPreferences.set(key, value),
        removeItem: (key: string) => storedPreferences.delete(key),
        clear: () => storedPreferences.clear(),
      },
    });
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePreference;

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        get matches() {
          return systemPrefersDark;
        },
        media: "(prefers-color-scheme: dark)",
        onchange: null,
        addEventListener: (_event: string, listener: () => void) => systemListeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) => systemListeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  function renderThemeControls() {
    return render(
      <>
        <ThemeRuntime />
        <ThemeSelector />
      </>,
    );
  }

  it("exposes a visible label and restores a saved preference", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderThemeControls();

    const selector = screen.getByLabelText("Theme") as HTMLSelectElement;
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    await waitFor(() => expect(selector.value).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.themePreference).toBe("light");
  });

  it("persists an explicit theme selection", async () => {
    renderThemeControls();
    const selector = screen.getByLabelText("Theme") as HTMLSelectElement;
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

    fireEvent.change(selector, { target: { value: "dark" } });

    expect(selector.value).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("dark");
  });

  it("tracks system changes at the layout level without a selector", async () => {
    document.documentElement.dataset.themePreference = "system";
    render(<ThemeRuntime />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

    systemPrefersDark = true;
    systemListeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.theme).toBe("dark");

    document.documentElement.dataset.themePreference = "light";
    document.documentElement.dataset.theme = "light";
    systemPrefersDark = false;
    systemListeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("hydrates with the server value hidden until a saved preference is restored", async () => {
    const serverMarkup = renderToString(<ThemeSelector />);
    expect(serverMarkup).toContain('data-ready="false"');
    document.body.innerHTML = `<div id="root">${serverMarkup}</div>`;
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.themePreference = "light";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const container = document.getElementById("root");
    if (!container) throw new Error("Missing hydration test root");
    const root = hydrateRoot(container, <ThemeSelector />);

    await waitFor(() => {
      expect(screen.getByLabelText("Theme")).toHaveProperty("value", "light");
      expect(container.querySelector(".theme-control")?.getAttribute("data-ready")).toBe("true");
    });
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/hydration|hydrated/i);

    await act(async () => root.unmount());
    consoleError.mockRestore();
  });

  it("applies a selection even when persistence is unavailable", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => { throw new Error("storage disabled"); },
        setItem: () => { throw new Error("storage disabled"); },
      },
    });
    renderThemeControls();
    const selector = screen.getByLabelText("Theme") as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe("system"));

    fireEvent.change(selector, { target: { value: "dark" } });

    expect(selector.value).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("dark");
  });
});
