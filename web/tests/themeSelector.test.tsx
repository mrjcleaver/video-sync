import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ThemeSelector, { THEME_STORAGE_KEY } from "../src/components/ThemeSelector";

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

  afterEach(() => cleanup());

  it("exposes a visible label and restores a saved preference", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<ThemeSelector />);

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
    render(<ThemeSelector />);
    const selector = screen.getByLabelText("Theme") as HTMLSelectElement;
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

    fireEvent.change(selector, { target: { value: "dark" } });

    expect(selector.value).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("dark");
  });

  it("tracks system changes only while System is selected", async () => {
    render(<ThemeSelector />);
    const selector = screen.getByLabelText("Theme") as HTMLSelectElement;
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

    systemPrefersDark = true;
    systemListeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.change(selector, { target: { value: "light" } });
    systemPrefersDark = false;
    systemListeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
