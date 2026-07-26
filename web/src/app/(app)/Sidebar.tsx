"use client";

/**
 * ADR-057 Option A — left-nav sidebar with count badges (grafts
 * Option C's signal onto Option A's shape per ADR-057).
 *
 * Nav order matches operator attention:
 *   /catalog     — the daily driver (review + curate). Badge = backlog.
 *   /overview    — Overview + Calendar tabs. First place operators
 *                  look; promoted to top-level after ADR-057 initial
 *                  ship. No natural badge (it IS the count view).
 *   /provenance  — the graph view (adjacent to /catalog).
 *   /import      — Import panels. Badge = pending backfill queue.
 *   /maintain    — Catch-Up + maintenance cards. Badge = sum of
 *                  work across the four scanners.
 *   /shorts      — Opus Clip clips.
 *   /config      — Setup + rules.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { useApp } from "./AppContext";
import { findMissingYouTubeRows } from "../../lib/youtubeIngest";
import { findRecordsNeedingSummaryBadge } from "../../lib/summaryBadgeBackfill";
import { findRecordsNeedingTitleAlignment } from "../../lib/youtubeTitleAlignBackfill";

const NAV = [
  { path: "/catalog",    label: "Catalog",    icon: "📚", badge: "catalog" as const },
  { path: "/overview",   label: "Overview",   icon: "📅", badge: null       as const },
  { path: "/provenance", label: "Provenance", icon: "🔗", badge: null       as const },
  { path: "/import",     label: "Import",     icon: "⬇️", badge: "import"  as const },
  { path: "/maintain",   label: "Maintain",   icon: "🧰", badge: "maintain" as const },
  { path: "/shorts",     label: "Shorts",     icon: "✂️", badge: null       as const },
  { path: "/config",     label: "Config",     icon: "⚙️", badge: null       as const },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const {
    videos, currentPromptVersion, seriesRegistry,
    backfillReadySize,
  } = useApp();

  // Catalog backlog — records the operator needs to look at.
  const catalogBadge = useMemo(() => {
    let n = 0;
    for (const v of videos) {
      if (v.status === "Discovered" || v.status === "InScope") n++;
    }
    return n;
  }, [videos]);

  // Import — records ready to publish from the backfill queue.
  // Rendered only when > 0 so an idle queue doesn't accumulate visual noise.
  const importBadge = backfillReadySize;

  // Maintain — sum of work across the three scanners we can cheaply
  // pre-flight from the client. Broadcast-pair migration doesn't
  // have a scanner (it walks and reclassifies inline) so it's not
  // counted; the operator sees the actual figure when they open
  // the card.
  const maintainBadge = useMemo(() => {
    const missingYT = findMissingYouTubeRows(videos).length;
    const summariesNeeded = findRecordsNeedingSummaryBadge(videos, currentPromptVersion).length;
    const titlesNeeded = findRecordsNeedingTitleAlignment(videos, seriesRegistry).length;
    return missingYT + summariesNeeded + titlesNeeded;
  }, [videos, currentPromptVersion, seriesRegistry]);

  function badgeFor(kind: "catalog" | "import" | "maintain" | null): number | null {
    if (kind === "catalog") return catalogBadge > 0 ? catalogBadge : null;
    if (kind === "import") return importBadge > 0 ? importBadge : null;
    if (kind === "maintain") return maintainBadge > 0 ? maintainBadge : null;
    return null;
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
        const isActive = pathname === item.path || (pathname === "/" && item.path === "/overview");
        const count = badgeFor(item.badge);
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
            {count != null && (
              <span
                style={{
                  fontSize: "0.7rem",
                  padding: "1px 6px",
                  borderRadius: 8,
                  background: "rgba(99,102,241,0.22)",
                  color: "var(--text)",
                  fontWeight: 600,
                }}
                title={
                  item.badge === "catalog" ? `${count} record${count === 1 ? "" : "s"} to review (Discovered + InScope)`
                  : item.badge === "import" ? `${count} record${count === 1 ? "" : "s"} ready in the backfill queue`
                  : item.badge === "maintain" ? `${count} maintenance task${count === 1 ? "" : "s"} eligible (YouTube rows + summary badges + title alignment)`
                  : ""
                }
              >
                {count}
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
