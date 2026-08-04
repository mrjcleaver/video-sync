"use client";

import { useEffect, useState } from "react";
import {
  applyThemePreference,
  readThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";

export { applyThemePreference, THEME_STORAGE_KEY } from "./theme";
export type { ThemePreference } from "./theme";

export default function ThemeSelector() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const storedPreference = readThemePreference();
    setPreference(storedPreference);
    applyThemePreference(storedPreference);
    setMounted(true);
  }, []);

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
    <div className="theme-control" data-ready={mounted ? "true" : "false"}>
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
