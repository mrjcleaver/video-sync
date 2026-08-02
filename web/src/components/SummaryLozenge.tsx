"use client";

/**
 * ADR-046 — the 📄 M:NN L:NN T:NN C:NN summary lozenge.
 *
 * Used in both BackfillOverview (compact row) and VideoCard (meta row)
 * so the rendering rules can't drift. The current prompt version is
 * fetched once per session via getCurrentPromptVersion() and shared
 * across all mounted lozenges via a module-level cache.
 */

import { useEffect, useState } from "react";
import type { SummaryCountsJSON } from "../lib/wasm";
import { getCurrentPromptVersion } from "../lib/summaryPromptClient";

const STYLE = {
  bg: "rgba(168,247,209,0.10)",
  fg: "#86efac",
  border: "rgba(134,239,172,0.35)",
};
const ABSENT_STYLE = {
  bg: "rgba(148,163,184,0.05)",
  fg: "#94a3b8",
  border: "rgba(148,163,184,0.18)",
};

const BASE: React.CSSProperties = {
  fontSize: "0.7rem",
  padding: "1px 6px",
  borderRadius: 10,
  textDecoration: "none",
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
  display: "inline-block",
};

interface Props {
  docId: string | null | undefined;
  promptVersion: number | null | undefined;
  locked: boolean;
  counts: SummaryCountsJSON | null | undefined;
  /** When the lozenge sits inside a clickable parent row, stop the open
   *  link from triggering the parent navigation. */
  stopRowClick?: boolean;
  /** Visual variant. `compact` is the Overview row style; `card` is the
   *  card meta row (identical so far, kept for future divergence). */
  variant?: "compact" | "card";
}

export function SummaryLozenge({ docId, promptVersion, locked, counts, stopRowClick = true }: Props) {
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCurrentPromptVersion().then(v => { if (!cancelled) setCurrentVersion(v); });
    return () => { cancelled = true; };
  }, []);

  if (!docId || !counts) {
    return (
      <span
        title="No Show Notes yet — click 📄 Show Notes on the card to generate them"
        style={{
          ...BASE,
          background: ABSENT_STYLE.bg,
          color: ABSENT_STYLE.fg,
          border: `1px solid ${ABSENT_STYLE.border}`,
          opacity: 0.6,
        }}
      >
        📄 —
      </span>
    );
  }

  const stale = currentVersion != null && promptVersion != null && promptVersion < currentVersion;
  const prefix = locked ? "🔒 " : "";
  const label = `${prefix}📄 M:${counts.m} L:${counts.l} T:${counts.t} C:${counts.c}`;
  const tooltipParts = [
    `Show Notes prompt v${promptVersion ?? "?"}`,
    locked ? "🔒 locked — bulk-regen skips this record" : null,
    stale ? `current prompt is v${currentVersion} — regenerate available` : null,
  ].filter(Boolean) as string[];

  return (
    <a
      href={`https://docs.google.com/document/d/${encodeURIComponent(docId)}/edit`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stopRowClick ? e => e.stopPropagation() : undefined}
      title={tooltipParts.join(" · ")}
      style={{
        ...BASE,
        background: STYLE.bg,
        color: STYLE.fg,
        border: `1px solid ${STYLE.border}`,
        opacity: stale ? 0.55 : 1,
      }}
    >
      {label}
    </a>
  );
}
