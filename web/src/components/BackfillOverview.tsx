"use client";

import { useState } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import {
  type BackfillProfile,
  type MonthSummary,
  buildCalendarOverview,
  statusColor,
  DAY_NAMES,
  MONTH_NAMES,
} from "../lib/backfill";

interface Props {
  videos: VideoRecordJSON[];
  profile: BackfillProfile;
}

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

              {/* Expanded: mini-month grid inline */}
              {isExpanded && (
                <div style={{ padding: "8px 8px 8px 80px" }}>
                  <MiniMonth slots={s.slots} year={s.year} month={s.month} targetOnly={targetOnly} />
                </div>
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

/** Compact inline month grid — used when a month row is expanded. */
function MiniMonth({ slots, year, month, targetOnly }: { slots: { date: string; is_target: boolean; video?: { title: string; status: string } }[]; year: number; month: number; targetOnly: boolean }) {
  const firstDow = new Date(year, month, 1).getDay();
  const grid: (typeof slots[0] | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...slots,
  ];
  while (grid.length % 7 !== 0) grid.push(null);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 24px)", gap: 1 }}>
      {DAY_NAMES.map(d => (
        <div key={d} style={{ textAlign: "center", fontSize: "0.55rem", color: "var(--text-muted)", fontWeight: 600 }}>{d.charAt(0)}</div>
      ))}
      {grid.map((slot, i) => {
        if (!slot) return <div key={`e-${i}`} style={{ width: 24, height: 20 }} />;
        const hidden = targetOnly && !slot.is_target;
        const color = slot.video ? statusColor(slot.video.status) : slot.is_target ? "var(--border)" : "transparent";
        return (
          <div
            key={slot.date}
            title={slot.video ? `${slot.video.title} (${slot.video.status})` : slot.is_target ? "Gap" : ""}
            style={{
              width: 24, height: 20,
              borderRadius: 3,
              border: slot.is_target ? `1px solid ${color}` : "1px solid transparent",
              background: slot.video && slot.is_target ? `${color}22` : "transparent",
              display: "flex", alignItems: "center", justifyContent: "center",
              visibility: hidden ? "hidden" : "visible",
            }}
          >
            {slot.video && (
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
            )}
            {slot.is_target && !slot.video && (
              <div style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--border)" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
