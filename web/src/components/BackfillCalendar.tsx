"use client";

import { useState } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import {
  type BackfillProfile,
  buildCalendarMonth,
  statusColor,
  DAY_NAMES,
  MONTH_NAMES,
} from "../lib/backfill";

interface Props {
  videos: VideoRecordJSON[];
  profile: BackfillProfile;
}

export default function BackfillCalendar({ videos, profile }: Props) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed

  const slots = buildCalendarMonth(videos, profile, year, month);

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();
    if (isCurrentMonth) return; // don't show future months
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  }

  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();

  // Build a grid: pad start of month to correct weekday
  const firstDow = new Date(year, month, 1).getDay();
  const grid: (typeof slots[0] | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...slots,
  ];
  // Pad end to full rows
  while (grid.length % 7 !== 0) grid.push(null);

  const published = slots.filter(s => s.video?.status === "Published").length;
  const queued = slots.filter(s => s.video && s.video.status !== "Published").length;
  const gaps = slots.filter(s => s.is_target && !s.video).length;

  return (
    <div className="backfill-calendar">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button className="btn btn-sm" onClick={prevMonth}>‹</button>
        <span style={{ fontWeight: 600 }}>{MONTH_NAMES[month]} {year}</span>
        <button className="btn btn-sm" onClick={nextMonth} disabled={isCurrentMonth}>›</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 10, fontSize: "0.75rem", color: "var(--text-muted)" }}>
        <span style={{ color: "var(--green)" }}>● {published} published</span>
        <span style={{ color: "#fbbf24" }}>● {queued} in backlog</span>
        <span style={{ color: "var(--text-muted)" }}>○ {gaps} gaps</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {DAY_NAMES.map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: "0.65rem", color: "var(--text-muted)", padding: "2px 0", fontWeight: 600 }}>
            {d}
          </div>
        ))}
        {grid.map((slot, i) => {
          if (!slot) {
            return <div key={`empty-${i}`} />;
          }
          const color = slot.video ? statusColor(slot.video.status) : slot.is_target ? "var(--border)" : "transparent";
          const bg = slot.is_target
            ? slot.video ? "var(--bg-card)" : "var(--bg)"
            : "transparent";
          return (
            <div
              key={slot.date}
              title={slot.video ? `${slot.video.title}\n${slot.video.status}` : slot.is_target ? "No source found" : ""}
              style={{
                padding: "4px 2px",
                borderRadius: 4,
                background: bg,
                border: slot.is_target ? `1px solid ${color}` : "1px solid transparent",
                cursor: slot.video ? "pointer" : "default",
                minHeight: 36,
              }}
            >
              <div style={{ fontSize: "0.6rem", color: "var(--text-muted)", textAlign: "center" }}>
                {new Date(slot.date + "T00:00:00").getDate()}
              </div>
              {slot.video && (
                <div style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: color, margin: "2px auto 0",
                }} />
              )}
              {slot.is_target && !slot.video && (
                <div style={{
                  width: 4, height: 4, borderRadius: "50%",
                  background: "var(--border)", margin: "4px auto 0",
                }} />
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 10, fontSize: "0.7rem", color: "var(--text-muted)", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span><span style={{ color: "var(--green)" }}>●</span> Published</span>
        <span><span style={{ color: "#a78bfa" }}>●</span> Approved</span>
        <span><span style={{ color: "#fbbf24" }}>●</span> InScope</span>
        <span><span style={{ color: "var(--red)" }}>●</span> Failed</span>
        <span><span style={{ color: "var(--border)" }}>●</span> Gap</span>
      </div>
    </div>
  );
}
