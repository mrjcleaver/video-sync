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
import { findOrphanClips } from "../../lib/orphanClipsRepair";
import { findDuplicateClusters } from "../../lib/catalogDedupe";
import { useCurrentActor } from "../../lib/useCurrentActor";

const NAV = [
  { path: "/catalog",    label: "Catalog",    icon: "📚", badge: "catalog" as const, roles: ["Admin", "Publisher", "Viewer"] as const },
  { path: "/overview",   label: "Overview",   icon: "📅", badge: null       as const, roles: ["Admin", "Publisher", "Contributor", "Viewer"] as const },
  { path: "/provenance", label: "Provenance", icon: "🔗", badge: null       as const, roles: ["Admin", "Publisher", "Contributor", "Viewer"] as const },
  { path: "/contribute", label: "Contribute", icon: "🎁", badge: null       as const, roles: ["Admin", "Publisher", "Contributor"] as const },
  { path: "/import",     label: "Import",     icon: "⬇️", badge: "import"  as const, roles: ["Admin", "Publisher"] as const },
  { path: "/maintain",   label: "Maintain",   icon: "🧰", badge: "maintain" as const, roles: ["Admin", "Publisher"] as const },
  { path: "/shorts",     label: "Shorts",     icon: "✂️", badge: null       as const, roles: ["Admin", "Publisher"] as const },
  { path: "/config",     label: "Config",     icon: "⚙️", badge: null       as const, roles: ["Admin"] as const },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const {
    videos, currentPromptVersion, seriesRegistry,
    backfillReadySize,
  } = useApp();
  const actorState = useCurrentActor();
  const role = actorState.actor?.role ?? "Viewer";

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
    const orphanShorts = findOrphanClips(videos).length;
    // ADR-062 follow-up — dupe clusters count as maintenance work.
    const dupeExtras = findDuplicateClusters(videos).reduce((n, c) => n + c.losers.length, 0);
    return missingYT + summariesNeeded + titlesNeeded + orphanShorts + dupeExtras;
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
      <nav aria-label="Primary" style={{ display: "contents" }}>
      {NAV.filter((item) => (item.roles as readonly string[]).includes(role)).map((item) => {
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
      </nav>
      <div style={{ flex: 1 }} />

      {/* ADR-065 — role selector. Admin/Publisher can preview the app as
          a lower-role user by demoting themselves via X-View-As. Never
          elevates (server ignores elevation attempts). Hidden when the
          true role is already the lowest tier. */}
      {actorState.trueRole && actorState.trueRole !== "Viewer" && (
        <div
          style={{
            padding: "6px 10px", borderTop: "1px solid var(--border)",
            marginTop: 6, fontSize: "0.72rem", color: "var(--text-muted)",
          }}
        >
          <div style={{ marginBottom: 2 }}>
            <span aria-hidden style={{ marginRight: 6 }}>👁</span>
            View as
          </div>
          <select
            value={actorState.viewAsRole ?? actorState.trueRole}
            onChange={(e) => {
              const v = e.target.value;
              actorState.setViewAsRole(v === actorState.trueRole ? null : v as typeof actorState.trueRole);
            }}
            style={{
              width: "100%", fontSize: "0.75rem", padding: "3px 6px",
              background: "var(--bg)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 4,
            }}
            title="Preview the app as if you were a lower-role user. Reloads the page. Server ignores elevation attempts, so this can only demote."
          >
            {actorState.trueRole === "Admin" && <option value="Admin">Admin (you)</option>}
            {actorState.trueRole !== "Viewer" && actorState.trueRole !== "Contributor" && (
              <option value="Publisher">{actorState.trueRole === "Publisher" ? "Publisher (you)" : "Publisher"}</option>
            )}
            <option value="Contributor">Contributor</option>
            <option value="Viewer">Viewer</option>
          </select>
          {actorState.viewAsRole && actorState.viewAsRole !== actorState.trueRole && (
            <div style={{ marginTop: 3, color: "#f59e0b", fontSize: "0.68rem" }}>
              ⚠ Demoted view — click role &quot;{actorState.trueRole} (you)&quot; to restore.
            </div>
          )}
        </div>
      )}

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
      {/* ADR-066 — MCP connect hint. Uses NEXT_PUBLIC_MCP_PUBLIC_ORIGIN
          when set (the public no-IAP Cloud Run service that hosts
          the MCP RPC + OAuth token endpoints). Falls back to the
          current origin for single-service deploys. Hidden from
          Viewer + Contributor — they can't mint tokens and the
          endpoint gives them nothing they don't already see. */}
      {(role === "Admin" || role === "Publisher") && (
      <details style={{ padding: "6px 10px", fontSize: "0.72rem", color: "var(--text-muted)" }}>
        <summary style={{ cursor: "pointer", listStyle: "none" }}>
          <span aria-hidden style={{ width: 20, textAlign: "center", display: "inline-block" }}>🔌</span>
          Connect via MCP
        </summary>
        <div style={{ paddingTop: 6, fontSize: "0.68rem", lineHeight: 1.45 }}>
          <div style={{ marginBottom: 6 }}>
            Mint a token in <strong>Config → 🔌 MCP tokens</strong> (Admin only), then use it via <code>mcp-remote</code> below.
          </div>

          <div style={{ fontWeight: 600, marginTop: 2 }}>Recommended — config.json via mcp-remote</div>
          <pre style={{
            marginTop: 3, padding: 5, fontSize: "0.66rem",
            background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}>{`{
  "mcpServers": {
    "video-sync": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${(process.env.NEXT_PUBLIC_MCP_PUBLIC_ORIGIN ?? (typeof window !== "undefined" ? window.location.origin : ""))}/api/mcp",
        "--header",
        "Authorization: Bearer vsync_YOUR_TOKEN_HERE"
      ]
    }
  }
}`}</pre>

          <div style={{ fontWeight: 600, marginTop: 8 }}>Alt — Custom Connector UI (OAuth flow)</div>
          Settings → Connectors → <em>Add Custom Connector</em> → paste:
          <pre style={{
            marginTop: 3, padding: 5, fontSize: "0.66rem",
            background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}>{`${(process.env.NEXT_PUBLIC_MCP_PUBLIC_ORIGIN ?? (typeof window !== "undefined" ? window.location.origin : ""))}/api/mcp`}</pre>
          Claude Desktop will discover <code>/.well-known/oauth-authorization-server</code>, walk you through Approve, and store the token itself.
          <div style={{
            marginTop: 6, padding: 6,
            background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.35)",
            borderRadius: 3,
          }}>
            <strong style={{ color: "#f59e0b" }}>⚠ Requires IAP exception</strong>
            <div style={{ marginTop: 3 }}>
              The OAuth <code>/register</code> and <code>/token</code> endpoints need to be reachable from Claude Desktop without an IAP session. That&apos;s a GCP config task (URL-based IAP exemption or a separate Cloud Run service). Until that&apos;s done, the OAuth flow will 302 to Google Login and stall. The <code>mcp-remote</code> route above works today without any IAP changes.
            </div>
          </div>

          <div style={{ marginTop: 6 }}>
            The token&apos;s frozen role at mint time determines what results scope to.
          </div>
        </div>
      </details>
      )}
    </aside>
  );
}
