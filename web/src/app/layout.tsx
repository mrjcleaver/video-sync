import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import ThemeRuntime from "../components/ThemeRuntime";

export const metadata: Metadata = {
  title: "Video Sync — Curation Dashboard",
  description: "Video indexing & publishing bridge",
};

// ADR-070 — pre-paint theme sync. Reads the persisted preference (or
// system) BEFORE React hydrates so the first paint uses the correct
// palette. Falling back to a client component would flash the default
// (dark) theme for one frame on light-preference users.
const THEME_PRE_PAINT = `
  (function () {
    try {
      var stored = window.localStorage.getItem("video-sync-theme");
      var pref = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
      var resolved = pref;
      if (pref === "system") {
        resolved = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themePreference = pref;
    } catch (_) { /* leave default (dark) */ }
  })();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_PRE_PAINT }} />
      </head>
      <body>
        <ThemeRuntime />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
