"use client";

import { useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "video-sync-theme";

export type ThemePreference = "system" | "light" | "dark";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function getSystemTheme(): Exclude<ThemePreference, "system"> {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyThemePreference(preference: ThemePreference) {
  const resolvedTheme = preference === "system" ? getSystemTheme() : preference;
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
}

function readThemePreference(): ThemePreference {
  try {
    const storedPreference = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(storedPreference) ? storedPreference : "system";
  } catch {
    return "system";
  }
}

export default function ThemeSelector() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const storedPreference = readThemePreference();
    setPreference(storedPreference);
    applyThemePreference(storedPreference);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    applyThemePreference(preference);
    if (preference !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => applyThemePreference("system");
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, [mounted, preference]);

  const updatePreference = (nextPreference: ThemePreference) => {
    setPreference(nextPreference);
    applyThemePreference(nextPreference);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
    } catch {
      // The selected theme still applies for this page when storage is unavailable.
    }
  };

  return (
    <div className="theme-control">
      <label htmlFor="theme-preference">Theme</label>
      <select
        id="theme-preference"
        value={preference}
        onChange={(event) => updatePreference(event.target.value as ThemePreference)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  );
}
