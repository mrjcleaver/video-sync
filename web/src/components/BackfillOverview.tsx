"use client";

import { useState } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import {
  type BackfillProfile,
  type MonthSummary,
  type CalendarSlot,
  buildCalendarOverview,
  statusColor,
  DAY_NAMES,
} from "../lib/backfill";
import { resolveExternalUrl } from "../lib/urlResolver";

interface Props {
  videos: VideoRecordJSON[];
  profile: BackfillProfile;
}

const LINK_STYLE: React.CSSProperties = {
  fontSize: "0.68rem",
  padding: "1px 6px",
  borderRadius: 10,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

export default function BackfillOverview({ videos, profile }: Props) {
  const summaries = buildCalendarOverview(videos, profile);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [targetOnly, setTargetOnly] = useState(false);

  const totals = summaries.reduce(
    (acc, s) => ({
      target: acc.target + s.target_days,
      published: acc.published + s.published,
      approved: acc.approved + s.approved,
      backlog: acc.backlog + s.in_backlog,
      failed: acc.failed + s.failed,
      gaps: acc.gaps + s.gaps,
    }),
    { target: 0, published: 0, approved: 0, backlog: 0, failed: 0, gaps: 0 },
  );

  const pct = totals.target > 0 ? Math.round((totals.published / totals.target) * 100) : 0;
  const daysRemaining = totals.target - totals.published;
  const estDays = profile.max_uploads_per_day > 0
    ? Math.ceil(daysRemaining / profile.max_uploads_per_day)
    : null;

  return (
    <div>
      {/* Summary bar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12, fontSize: "0.78rem", alignItems: "center" }}>
        <span style={{ fontWeight: 600 }}>{pct}% published</span>
        <span style={{ color: "var(--green)" }}>{totals.published} published</span>
        <span style={{ color: "#a78bfa" }}>{totals.approved} approved</span>
        <span style={{ color: "#fbbf24" }}>{totals.backlog} in backlog</span>
        <span style={{ color: "var(--red)" }}>{totals.failed} failed</span>
        <span style={{ color: "var(--text-muted)" }}>{totals.gaps} gaps</span>
        {estDays != null && (
          <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
            ~{estDays} days to clear at {profile.max_uploads_per_day}/day
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div style={{ height: 6, borderRadius: 3, background: "var(--border)", marginBottom: 14, overflow: "hidden" }}>
        <div style={{ height: "100%", borderRadius: 3, background: "var(--green)", width: `${pct}%`, transition: "width 0.3s" }} />
      </div>

      {/* Target-only toggle */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={targetOnly} onChange={e => setTargetOnly(e.target.checked)} />
          Target days only
        </label>
      </div>

      {/* Month rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {summaries.map((s) => {
          const key = `${s.year}-${s.month}`;
          const isExpanded = expanded === key;
          const barTotal = s.target_days || 1;
          const pubW = (s.published / barTotal) * 100;
          const appW = (s.approved / barTotal) * 100;
          const failW = (s.failed / barTotal) * 100;
          const backW = (s.in_backlog / barTotal) * 100;

          return (
            <div key={key}>
              <div
                onClick={() => setExpanded(isExpanded ? null : key)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "72px 1fr 120px 20px",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 8px",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: "0.75rem",
                }}
              >
                <span style={{ fontWeight: 600 }}>{s.label}</span>

                {/* Stacked bar */}
                <div style={{ height: 12, borderRadius: 3, background: "var(--bg)", overflow: "hidden", display: "flex" }}>
                  {s.published > 0 && <div style={{ width: `${pubW}%`, background: "var(--green)", height: "100%" }} />}
                  {s.approved > 0 && <div style={{ width: `${appW}%`, background: "#a78bfa", height: "100%" }} />}
                  {s.failed > 0 && <div style={{ width: `${failW}%`, background: "var(--red)", height: "100%" }} />}
                  {s.in_backlog > 0 && <div style={{ width: `${backW}%`, background: "#fbbf24", height: "100%" }} />}
                </div>

                <span style={{ color: "var(--text-muted)", textAlign: "right", fontSize: "0.7rem" }}>
                  {s.published}/{s.target_days} · {s.gaps} gap{s.gaps !== 1 ? "s" : ""}
                </span>

                <span style={{ color: "var(--text-muted)", textAlign: "center" }}>{isExpanded ? "▲" : "▼"}</span>
              </div>

              {/* Expanded: vertical date list with links */}
              {isExpanded && (
                <DateList slots={s.slots} targetOnly={targetOnly} />
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ marginTop: 10, fontSize: "0.7rem", color: "var(--text-muted)", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span><span style={{ color: "var(--green)" }}>■</span> Published</span>
        <span><span style={{ color: "#a78bfa" }}>■</span> Approved</span>
        <span><span style={{ color: "#fbbf24" }}>■</span> Backlog</span>
        <span><span style={{ color: "var(--red)" }}>■</span> Failed</span>
        <span><span style={{ color: "var(--border)" }}>○</span> Gap</span>
      </div>
    </div>
  );
}

/** Format a date string as "Thu 15" */
function shortDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DAY_NAMES[dt.getDay()]} ${d}`;
}

/** Vertical date list with status, title, and clickable origin/destination links. */
function DateList({ slots, targetOnly }: { slots: CalendarSlot[]; targetOnly: boolean }) {
  const visible = targetOnly ? slots.filter(s => s.is_target) : slots;

  // When not in target-only mode, insert week separators
  // Show week-start (Mon) dates as section headers
  const rows: { type: "week"; label: string }[] | { type: "slot"; slot: CalendarSlot }[] = [];
  let lastWeekLabel = "";

  for (const slot of visible) {
    if (!targetOnly) {
      // Show week header on Mondays or first visible day of a new week
      const [y, m, d] = slot.date.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      const weekDay = dt.getDay();
      // Calculate Monday of this week
      const mon = new Date(dt);
      mon.setDate(mon.getDate() - ((weekDay + 6) % 7));
      const weekLabel = `Week of ${DAY_NAMES[1]} ${mon.getDate()} ${mon.toLocaleString("en-US", { month: "short" })}`;
      if (weekLabel !== lastWeekLabel) {
        (rows as { type: string; label?: string; slot?: CalendarSlot }[]).push({ type: "week", label: weekLabel });
        lastWeekLabel = weekLabel;
      }
    }
    (rows as { type: string; slot?: CalendarSlot }[]).push({ type: "slot", slot });
  }

  return (
    <div style={{ padding: "6px 0 6px 8px", borderLeft: "2px solid var(--border)", marginLeft: 36, marginTop: 4, marginBottom: 4 }}>
      {rows.map((row, i) => {
        if (row.type === "week") {
          return (
            <div key={`w-${i}`} style={{ fontSize: "0.65rem", color: "var(--text-muted)", padding: "6px 0 2px", fontWeight: 600, letterSpacing: "0.03em" }}>
              {(row as { label: string }).label}
            </div>
          );
        }

        const slot = (row as { slot: CalendarSlot }).slot;
        const v = slot.video;
        const color = v ? statusColor(v.status) : slot.is_target ? "var(--border)" : "transparent";
        const originHref = v ? resolveExternalUrl(v.origin_url) : null;
        const ytHref = v?.youtube_url ?? null;

        return (
          <div
            key={slot.date}
            style={{
              display: "grid",
              gridTemplateColumns: "52px 10px 1fr auto auto",
              alignItems: "center",
              gap: 6,
              padding: "3px 4px",
              fontSize: "0.75rem",
              borderRadius: 4,
              background: slot.is_target && !v ? "rgba(128,128,128,0.04)" : "transparent",
            }}
          >
            {/* Date */}
            <span style={{ fontFamily: "monospace", fontSize: "0.7rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              {shortDate(slot.date)}
            </span>

            {/* Status dot */}
            <span style={{ display: "flex", justifyContent: "center" }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: v ? color : "transparent",
                border: slot.is_target && !v ? "1.5px solid var(--border)" : "none",
                display: "inline-block",
              }} />
            </span>

            {/* Title or gap */}
            {v ? (
              <span style={{
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: v.status === "Published" ? "var(--text)" : "var(--text-muted)",
              }}>
                {v.title}
              </span>
            ) : (
              <span style={{ color: "var(--text-muted)", fontStyle: "italic", fontSize: "0.7rem" }}>
                {slot.is_target ? "— no source —" : ""}
              </span>
            )}

            {/* Origin link */}
            {originHref ? (
              <a
                href={originHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                style={{
                  ...LINK_STYLE,
                  background: "rgba(56,189,248,0.1)",
                  color: "#38bdf8",
                  border: "1px solid rgba(56,189,248,0.25)",
                }}
              >
                {v!.source_platform}
              </a>
            ) : (
              <span style={{ width: 48 }} />
            )}

            {/* YouTube link */}
            {ytHref ? (
              <a
                href={ytHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                style={{
                  ...LINK_STYLE,
                  background: "rgba(248,113,113,0.1)",
                  color: "#f87171",
                  border: "1px solid rgba(248,113,113,0.25)",
                }}
              >
                YouTube
              </a>
            ) : (
              <span style={{ width: 56 }} />
            )}
          </div>
        );
      })}

      {visible.length === 0 && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontStyle: "italic", padding: 4 }}>
          No dates in this month.
        </div>
      )}
    </div>
  );
}
