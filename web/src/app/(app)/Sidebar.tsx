"use client";

/**
 * ADR-057 Option A — left-nav sidebar.
 *
 * Activity-based navigation:
 *   /catalog     — review + curate (daily driver)
 *   /provenance  — the graph view (adjacent to /catalog)
 *   /import      — bring content in (Import + Backfill + SyncStatus)
 *   /maintain    — Catch-Up maintenance cards (ADR-047 + siblings)
 *   /shorts      — Opus Clip-derived clips (ADR-029)
 *   /config      — Connections + Rules (all 3) + Summary Prompt
 *
 * Counts (record totals, review backlog) surfaced as chip badges next
 * to each nav item — grafts the Option C signal onto Option A's
 * shape, per ADR-057.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "./AppContext";

const NAV = [
  { path: "/catalog",    label: "Catalog",     icon: "📚" },
  { path: "/provenance", label: "Provenance",  icon: "🔗" },
  { path: "/import",     label: "Import",      icon: "⬇️" },
  { path: "/maintain",   label: "Maintain",    icon: "🧰" },
  { path: "/shorts",     label: "Shorts",      icon: "✂️" },
  { path: "/config",     label: "Config",      icon: "⚙️" },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { videos } = useApp();

  // Cheap counts — no network. `videos` already includes every catalog
  // record. Backlog = Discovered + InScope.
  const counts = { total: videos.length, backlog: 0 };
  for (const v of videos) {
    if (v.status === "Discovered" || v.status === "InScope") counts.backlog++;
  }

  return (
    <aside
      style={{
        width: 200,
        flex: "0 0 200px",
        borderRight: "1px solid var(--border)",
        padding: "12px 8px",
        background: "var(--bg-alt, var(--bg))",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        position: "sticky",
        top: 0,
        height: "100vh",
        overflowY: "auto",
      }}
    >
      <div style={{ padding: "4px 10px 12px", fontWeight: 700, fontSize: "1rem" }}>
        Video Sync
      </div>
      {NAV.map((item) => {
        const isActive = pathname === item.path || (pathname === "/" && item.path === "/catalog");
        // Only /catalog carries a badge (backlog count) — the other
        // activity pages don't have a canonical "N pending" until we
        // wire them (per ADR-057 Open Question, grafts from Option C).
        const badge = item.path === "/catalog" && counts.backlog > 0 ? counts.backlog : null;
        return (
          <Link
            key={item.path}
            href={item.path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 10px",
              borderRadius: 6,
              textDecoration: "none",
              fontSize: "0.9rem",
              color: isActive ? "var(--text)" : "var(--text-muted)",
              background: isActive ? "var(--bg-card, rgba(99,102,241,0.12))" : "transparent",
              fontWeight: isActive ? 600 : 500,
            }}
          >
            <span aria-hidden style={{ width: 20, textAlign: "center" }}>{item.icon}</span>
            <span style={{ flex: 1 }}>{item.label}</span>
            {badge != null && (
              <span
                style={{
                  fontSize: "0.7rem",
                  padding: "1px 6px",
                  borderRadius: 8,
                  background: "rgba(99,102,241,0.22)",
                  color: "var(--text)",
                  fontWeight: 600,
                }}
              >
                {badge}
              </span>
            )}
          </Link>
        );
      })}
      <div style={{ flex: 1 }} />
      <a
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 10px", borderRadius: 6, textDecoration: "none",
          fontSize: "0.78rem", color: "var(--text-muted)",
        }}
        href={`https://github.com/mrjcleaver/video-sync/issues/new?template=feedback.yml&title=${encodeURIComponent(`[feedback] ${process.env.NEXT_PUBLIC_BUILD_SHA ?? "unknown"}: `)}&build=${encodeURIComponent(process.env.NEXT_PUBLIC_BUILD_SHA ?? "unknown")}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span aria-hidden style={{ width: 20, textAlign: "center" }}>💬</span>
        Feedback
      </a>
      <a
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 10px", borderRadius: 6, textDecoration: "none",
          fontSize: "0.78rem", color: "var(--text-muted)",
        }}
        href="https://github.com/mrjcleaver/video-sync/wiki"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span aria-hidden style={{ width: 20, textAlign: "center" }}>❓</span>
        Help
      </a>
    </aside>
  );
}
