"use client";

import { useEffect } from "react";
import {
  applyThemePreference,
  isThemePreference,
  readThemePreference,
} from "./theme";

export default function ThemeRuntime() {
  useEffect(() => {
    const rootPreference = document.documentElement.dataset.themePreference;
    applyThemePreference(
      isThemePreference(rootPreference) ? rootPreference : readThemePreference(),
    );

    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      if (document.documentElement.dataset.themePreference === "system") {
        applyThemePreference("system");
      }
    };

    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, []);

  return null;
}
