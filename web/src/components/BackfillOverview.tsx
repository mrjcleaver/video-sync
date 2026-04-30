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
import { getDisplayTitle } from "../lib/processingRules";
import { getPrivacy, setPrivacy, normalisePrivacy, type PrivacyStatus } from "../lib/youtubePrivacyCache";

/** Extract YouTube video ID from a watch URL or short URL. */
function extractYouTubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  const watch = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (watch) return watch[1];
  const short = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (short) return short[1];
  return null;
}

// YouTube lozenge: privacy-aware label. Always prefixed "YT:" so it's
// obviously YouTube vs. other destination platforms.
const PRIVACY_COLOR: Record<PrivacyStatus, { bg: string; fg: string; border: string; label: string }> = {
  public:   { bg: "rgba(34,197,94,0.12)",  fg: "#22c55e", border: "rgba(34,197,94,0.3)",  label: "YT: Public" },
  unlisted: { bg: "rgba(250,204,21,0.12)", fg: "#facc15", border: "rgba(250,204,21,0.3)", label: "YT: Unlisted" },
  private:  { bg: "rgba(248,113,113,0.12)",fg: "#f87171", border: "rgba(248,113,113,0.3)",label: "YT: Private" },
  unknown:  { bg: "rgba(148,163,184,0.12)",fg: "#94a3b8", border: "rgba(148,163,184,0.3)",label: "YouTube" },
};

// Kaltura lozenge — single style; we don't track per-entry privacy.
const KALTURA_STYLE = {
  bg: "rgba(168,85,247,0.12)",
  fg: "#a855f7",
  border: "rgba(168,85,247,0.3)",
};

// Drive lozenge — opens the Drive folder for this record's artifacts.
const DRIVE_STYLE = {
  bg: "rgba(56,189,248,0.06)",
  fg: "#7dd3fc",
  border: "rgba(56,189,248,0.2)",
};

interface Props {
  videos: VideoRecordJSON[];
  profile: BackfillProfile;
  onNavigateToVideo?: (id: string, intent?: "publish") => void;
}

function LegendBar({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 14, height: 4, background: color, borderRadius: 2, display: "inline-block" }} />
      {label}
    </span>
  );
}

function scrollToVideo(id: string) {
  const el = document.getElementById(`video-card-${id}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.style.outline = "2px solid var(--primary, #6366f1)";
    setTimeout(() => { el.style.outline = ""; }, 2000);
  }
}

const LINK_STYLE: React.CSSProperties = {
  fontSize: "0.68rem",
  padding: "1px 6px",
  borderRadius: 10,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

export default function BackfillOverview({ videos, profile, onNavigateToVideo }: Props) {
  const [privacyTick, setPrivacyTick] = useState(0);
  const [fillingPrivacy, setFillingPrivacy] = useState(false);
  const [fillStatus, setFillStatus] = useState<string>("");
  // privacyTick forces re-render when cache is updated
  void privacyTick;
  const summaries = buildCalendarOverview(videos, profile);
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());
  const [targetOnly, setTargetOnly] = useState(true);

  // Filter chips — when any are active, only rows matching ALL active
  // filters render. Chip categories:
  //   src:Zoom / src:Fireflies / src:Loom        — by source platform
  //   yt:public / yt:unlisted / yt:private       — by YouTube privacy
  //   yt:none                                    — not yet on YouTube
  //   kaltura                                    — has a Kaltura destination
  //   drive                                      — has any Drive artifact
  const [filters, setFilters] = useState<Set<string>>(new Set());
  function toggleFilter(id: string) {
    setFilters(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearFilters() { setFilters(new Set()); }
  function expandAll() { setExpandedSet(new Set(summaries.map(s => `${s.year}-${s.month}`))); }
  function closeAll() { setExpandedSet(new Set()); }

  // Collect all YouTube IDs from visible summaries that don't yet have cached privacy
  function collectUnknownYouTubeIds(): string[] {
    const ids = new Set<string>();
    for (const s of summaries) {
      for (const slot of s.slots) {
        const url = slot.video?.youtube_url;
        const id = extractYouTubeId(url);
        if (id && !getPrivacy(id)) ids.add(id);
      }
    }
    return [...ids];
  }

  async function fillPrivacy() {
    const ids = collectUnknownYouTubeIds();
    if (ids.length === 0) {
      setFillStatus("All known videos already have privacy cached.");
      setTimeout(() => setFillStatus(""), 3000);
      return;
    }

    let ytCreds: { refreshToken?: string; clientId?: string; clientSecret?: string } = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      const conn = raw ? JSON.parse(raw) : {};
      ytCreds = conn["YouTube"]?.credentials ?? {};
    } catch { /* ignore */ }

    if (!ytCreds.refreshToken || !ytCreds.clientId || !ytCreds.clientSecret) {
      setFillStatus("YouTube not authorised. Configure in Connections.");
      setTimeout(() => setFillStatus(""), 4000);
      return;
    }

    setFillingPrivacy(true);
    setFillStatus(`Checking ${ids.length} video${ids.length === 1 ? "" : "s"}…`);

    try {
      const res = await fetch("/api/youtube/privacy-batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-youtube-refresh-token": ytCreds.refreshToken,
          "x-youtube-client-id": ytCreds.clientId,
          "x-youtube-client-secret": ytCreds.clientSecret,
        },
        body: JSON.stringify({ videoIds: ids }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Fill failed (${res.status})`);
      }
      const data = await res.json() as { privacy: Record<string, string>; missing: string[] };
      let count = 0;
      for (const [id, p] of Object.entries(data.privacy)) {
        setPrivacy(id, normalisePrivacy(p));
        count++;
      }
      // Mark any videos YouTube didn't return as "unknown" so we don't keep retrying them
      for (const id of data.missing ?? []) {
        setPrivacy(id, "unknown");
      }
      setPrivacyTick(t => t + 1);
      const msg = data.missing?.length
        ? `Filled ${count} · ${data.missing.length} not found on YouTube`
        : `Filled ${count} privacy entries`;
      setFillStatus(msg);
      setTimeout(() => setFillStatus(""), 5000);
    } catch (err) {
      setFillStatus(`Error: ${String(err).slice(0, 120)}`);
      setTimeout(() => setFillStatus(""), 6000);
    } finally {
      setFillingPrivacy(false);
    }
  }

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

      {/* Toolbar: fill privacy + target-only toggle */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginBottom: 8 }}>
        {fillStatus && (
          <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontStyle: "italic" }}>
            {fillStatus}
          </span>
        )}
        <button
          className="btn btn-sm"
          style={{ fontSize: "0.7rem" }}
          onClick={fillPrivacy}
          disabled={fillingPrivacy}
          title="Check YouTube for privacy status of all published videos in this view (batched, 1 quota unit per 50 videos)"
        >
          {fillingPrivacy ? "Checking…" : "Fill privacy"}
        </button>
        <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={targetOnly} onChange={e => setTargetOnly(e.target.checked)} />
          Target days only
        </label>
        <button className="btn btn-sm" style={{ fontSize: "0.7rem" }} onClick={expandAll} title="Expand every month">
          Expand all
        </button>
        <button className="btn btn-sm" style={{ fontSize: "0.7rem" }} onClick={closeAll} title="Collapse every month" disabled={expandedSet.size === 0}>
          Close all
        </button>
      </div>

      {/* Month rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {summaries.map((s) => {
          const key = `${s.year}-${s.month}`;
          const isExpanded = expandedSet.has(key);
          const barTotal = s.target_days || 1;
          const pubW = (s.published / barTotal) * 100;
          const appW = (s.approved / barTotal) * 100;
          const failW = (s.failed / barTotal) * 100;
          const backW = (s.in_backlog / barTotal) * 100;

          return (
            <div key={key}>
              <div
                onClick={() => setExpandedSet(prev => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })}
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
                <DateList slots={s.slots} targetOnly={targetOnly} videos={videos} onNavigateToVideo={onNavigateToVideo} filters={filters} />
              )}
            </div>
          );
        })}
      </div>

      {/* Legend / filter chips — click any chip to filter the expanded
          rows. Multiple chips combine with AND. Status swatches (the
          stacked bars) are non-interactive; everything else filters. */}
      <div style={{ marginTop: 10, fontSize: "0.7rem", color: "var(--text-muted)", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontWeight: 600 }}>Status:</span>
        <LegendBar color="var(--green)" label="Published" />
        <LegendBar color="#a78bfa" label="Approved" />
        <LegendBar color="#fbbf24" label="Backlog" />
        <LegendBar color="var(--red)" label="Failed" />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", border: "1.5px solid var(--border)", display: "inline-block" }} />
          Gap
        </span>

        <span style={{ marginLeft: 10, fontWeight: 600 }}>Source:</span>
        <FilterChip id="src:Fireflies" label="Fireflies" filters={filters} onToggle={toggleFilter} bg="rgba(245,158,11,0.12)" fg="#f59e0b" border="rgba(245,158,11,0.3)" />
        <FilterChip id="src:Zoom" label="Zoom" filters={filters} onToggle={toggleFilter} bg="rgba(56,189,248,0.12)" fg="#38bdf8" border="rgba(56,189,248,0.3)" />
        <FilterChip id="src:Kaltura" label="Kaltura" filters={filters} onToggle={toggleFilter} bg={KALTURA_STYLE.bg} fg={KALTURA_STYLE.fg} border={KALTURA_STYLE.border} />

        <span style={{ marginLeft: 10, fontWeight: 600 }}>YouTube:</span>
        {(["public","unlisted","private","unknown"] as const).map(p => {
          const c = PRIVACY_COLOR[p];
          return (
            <FilterChip
              key={p}
              id={`yt:${p}`}
              label={c.label}
              filters={filters}
              onToggle={toggleFilter}
              bg={c.bg}
              fg={c.fg}
              border={c.border}
            />
          );
        })}
        <FilterChip id="yt:none" label="No YT" filters={filters} onToggle={toggleFilter} bg="rgba(148,163,184,0.06)" fg="#94a3b8" border="rgba(148,163,184,0.2)" />

        <span style={{ marginLeft: 10, fontWeight: 600 }}>Other:</span>
        <FilterChip id="kaltura" label="Kaltura" filters={filters} onToggle={toggleFilter} bg={KALTURA_STYLE.bg} fg={KALTURA_STYLE.fg} border={KALTURA_STYLE.border} />
        <FilterChip id="drive" label="Drive" filters={filters} onToggle={toggleFilter} bg={DRIVE_STYLE.bg} fg={DRIVE_STYLE.fg} border={DRIVE_STYLE.border} />

        {filters.size > 0 && (
          <button className="btn btn-sm" style={{ fontSize: "0.7rem", marginLeft: 6 }} onClick={clearFilters} title="Clear all filters">
            Clear filters ({filters.size})
          </button>
        )}
      </div>
    </div>
  );
}

function FilterChip({ id, label, filters, onToggle, bg, fg, border }: {
  id: string;
  label: string;
  filters: Set<string>;
  onToggle: (id: string) => void;
  bg: string;
  fg: string;
  border: string;
}) {
  const active = filters.has(id);
  return (
    <button
      type="button"
      onClick={() => onToggle(id)}
      style={{
        ...LINK_STYLE,
        background: active ? fg : bg,
        color: active ? "var(--bg-card, #fff)" : fg,
        border: `1px solid ${border}`,
        cursor: "pointer",
        opacity: filters.size > 0 && !active ? 0.55 : 1,
      }}
      title={active ? `Filter active — click to clear ${label}` : `Filter to ${label} only`}
    >
      {label}
    </button>
  );
}

/**
 * Filter slots by the active filter chip set. Empty filter set returns
 * the input unchanged. AND across categories, OR within a category:
 *   - sources (`src:Zoom`, `src:Fireflies`)              — OR within
 *   - YT privacy (`yt:public`/`yt:unlisted`/`yt:private`/
 *     `yt:unknown`/`yt:none`)                            — OR within
 *   - destination flags (`kaltura`, `drive`)             — singletons
 * Slots without a video are dropped when any filter is active (gaps
 * can't satisfy filters about a video).
 */
function applyFilters(slots: CalendarSlot[], videoMap: Map<string, VideoRecordJSON>, filters: Set<string>): CalendarSlot[] {
  if (filters.size === 0) return slots;

  const wantedSources = new Set<string>();
  const wantedYt = new Set<string>(); // values from yt:* including "none"
  let wantKaltura = false;
  let wantDrive = false;
  for (const f of filters) {
    if (f.startsWith("src:")) wantedSources.add(f.slice(4));
    else if (f.startsWith("yt:")) wantedYt.add(f.slice(3));
    else if (f === "kaltura") wantKaltura = true;
    else if (f === "drive") wantDrive = true;
  }

  return slots.filter(slot => {
    const v = slot.video;
    if (!v) return false; // gaps cannot satisfy any positive filter

    if (wantedSources.size > 0 && !wantedSources.has(v.source_platform)) return false;

    if (wantedYt.size > 0) {
      if (!v.youtube_url) {
        if (!wantedYt.has("none")) return false;
      } else {
        const ytId = extractYouTubeId(v.youtube_url);
        const privacy: PrivacyStatus = ytId ? (getPrivacy(ytId) ?? "unknown") : "unknown";
        if (!wantedYt.has(privacy)) return false;
      }
    }

    if (wantKaltura && !v.kaltura_url) return false;

    if (wantDrive) {
      // Best-effort: we can't synchronously check Drive presence. For now,
      // treat "Published" or "Approved" videos as having Drive artifacts
      // (this is true after migration; transcripts.json migration produced
      // a Drive folder for every record with a transcript). Refinement
      // would need a server endpoint that returns a record-id → has-folder
      // bitmap; defer that until the heuristic proves wrong.
      const fullV = videoMap.get(v.id);
      const hasTranscript = fullV?.transcript_text != null;
      if (!hasTranscript && v.status !== "Published") return false;
    }

    return true;
  });
}

/** Format a date string as "Thu 15" */
function shortDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DAY_NAMES[dt.getDay()]} ${d}`;
}

/** Vertical date list with status, title, and clickable origin/destination links. */
function DateList({ slots, targetOnly, videos, onNavigateToVideo, filters }: { slots: CalendarSlot[]; targetOnly: boolean; videos: VideoRecordJSON[]; onNavigateToVideo?: (id: string, intent?: "publish") => void; filters: Set<string> }) {
  const videoMap = new Map(videos.map(v => [v.id, v]));
  const visible = applyFilters(targetOnly ? slots.filter(s => s.is_target) : slots, videoMap, filters);

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
        const kalHref = v?.kaltura_url ?? null;
        const driveHref = v ? `/api/artifacts/${encodeURIComponent(v.id)}/folder` : null;

        return (
          <div
            key={slot.date}
            onClick={v ? () => (onNavigateToVideo ?? scrollToVideo)(v.id) : undefined}
            style={{
              display: "grid",
              gridTemplateColumns: "52px 10px 1fr auto auto auto auto",
              alignItems: "center",
              gap: 6,
              padding: "3px 4px",
              fontSize: "0.75rem",
              borderRadius: 4,
              background: slot.is_target && !v ? "rgba(128,128,128,0.04)" : "transparent",
              cursor: v ? "pointer" : "default",
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

            {/* Title or gap — apply processing rules for display */}
            {v ? (() => {
              const fullVideo = videoMap.get(v.id);
              const displayTitle = fullVideo ? getDisplayTitle(fullVideo) : v.title;
              const isTransformed = displayTitle !== v.title;
              return (
                <span
                  title={isTransformed ? `Original: ${v.title}` : undefined}
                  style={{
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    color: v.status === "Published" ? "var(--text)" : "var(--text-muted)",
                  }}
                >
                  {displayTitle}
                </span>
              );
            })() : (
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

            {/* YouTube lozenge (coloured by privacy status when known) */}
            {ytHref ? (() => {
              const ytId = extractYouTubeId(ytHref);
              const privacy: PrivacyStatus = ytId ? (getPrivacy(ytId) ?? "unknown") : "unknown";
              const p = PRIVACY_COLOR[privacy];
              return (
                <a
                  href={ytHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  title={privacy === "unknown" ? "Published to YouTube — privacy not yet checked" : `YouTube · ${privacy}`}
                  style={{
                    ...LINK_STYLE,
                    background: p.bg,
                    color: p.fg,
                    border: `1px solid ${p.border}`,
                  }}
                >
                  {p.label}
                </a>
              );
            })() : (
              <span style={{ width: 80 }} />
            )}

            {/* Kaltura lozenge */}
            {kalHref ? (
              <a
                href={kalHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                title="Published to Kaltura"
                style={{
                  ...LINK_STYLE,
                  background: KALTURA_STYLE.bg,
                  color: KALTURA_STYLE.fg,
                  border: `1px solid ${KALTURA_STYLE.border}`,
                }}
              >
                Kaltura
              </a>
            ) : (
              <span style={{ width: 56 }} />
            )}

            {/* Drive lozenge — folder of artifacts (transcript, summary, chat, ...) */}
            {driveHref ? (
              <a
                href={driveHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                title="Open the Drive folder containing transcript, description, summary, and chat artifacts"
                style={{
                  ...LINK_STYLE,
                  background: DRIVE_STYLE.bg,
                  color: DRIVE_STYLE.fg,
                  border: `1px solid ${DRIVE_STYLE.border}`,
                }}
              >
                Drive
              </a>
            ) : (
              <span style={{ width: 48 }} />
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
