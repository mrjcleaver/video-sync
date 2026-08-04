"use client";

/**
 * Small badge showing whether a record has a transcript.
 *
 * - Present (≥200 chars): green `📝 Transcript ✓` with line count in tooltip.
 * - Missing on a Kaltura-sourced record: muted `📝 Fetch transcript`
 *   button — clicking pulls captions from Kaltura, converts to plain
 *   text with [HH:MM:SS] markers, and persists via videoStore.
 * - Missing on any other source: muted `📝 —` informational badge.
 *
 * Sits in the VideoCard meta row alongside Drive + Summary lozenges.
 */

import { useState } from "react";
import { videoStore } from "../lib/store";

const PRESENT_STYLE: React.CSSProperties = {
  background: "rgba(125,211,252,0.12)",
  color: "#7dd3fc",
  border: "1px solid rgba(125,211,252,0.35)",
};
const MISSING_STYLE: React.CSSProperties = {
  background: "rgba(148,163,184,0.05)",
  color: "#94a3b8",
  border: "1px solid rgba(148,163,184,0.18)",
};
const FETCHABLE_STYLE: React.CSSProperties = {
  background: "rgba(168,85,247,0.10)",
  color: "#c4b5fd",
  border: "1px solid rgba(168,85,247,0.35)",
  cursor: "pointer",
};

const BASE: React.CSSProperties = {
  fontSize: "0.7rem",
  padding: "1px 6px",
  borderRadius: 10,
  textDecoration: "none",
  whiteSpace: "nowrap",
  display: "inline-block",
};

interface Props {
  recordId: string;
  sourcePlatform: string;
  /** The video's external id on its source platform (Kaltura entry id when source = Kaltura). */
  sourceId: string;
  transcriptText: string | null | undefined;
  onEvent?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Called after a successful fetch + store update — parent should
   *  refresh its videos state so the new transcript_text propagates to
   *  every dependent prop (Summarise button gating, lozenge state,
   *  tooltip totals). Without this the store updates but the UI keeps
   *  showing the pre-fetch values. */
  onUpdated?: () => void;
}

export function TranscriptLozenge({ recordId, sourcePlatform, sourceId, transcriptText, onEvent, onUpdated }: Props) {
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const present = !!transcriptText && transcriptText.length >= 200;

  if (present) {
    const lineCount = (transcriptText as string).split("\n").length;
    return (
      <span
        title={`Transcript present: ${lineCount} line${lineCount === 1 ? "" : "s"}, ${transcriptText!.length} characters`}
        style={{ ...BASE, ...PRESENT_STYLE }}
      >
        Transcript available
      </span>
    );
  }

  // Missing — for Kaltura sources offer a one-click fetch from captions.
  const isKaltura = sourcePlatform === "Kaltura";

  async function fetchFromKaltura(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (fetching) return;
    setFetching(true);
    setError(null);
    onEvent?.(`Kaltura captions requested for ${sourceId}`, { video_id: recordId });
    try {
      const res = await fetch(`/api/kaltura/captions?entryId=${encodeURIComponent(sourceId)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const data = await res.json() as { text: string; language?: string; format?: string };
      if (!data.text) throw new Error("Kaltura returned empty caption text");
      videoStore.setTranscript(recordId, data.text);
      const lineCount = data.text.split("\n").length;
      onEvent?.(`Kaltura captions imported — ${lineCount} lines (${data.format ?? "?"}, ${data.language ?? "?"})`, { video_id: recordId });
      onUpdated?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onEvent?.(`Kaltura captions failed — ${msg}`, { video_id: recordId });
    } finally {
      setFetching(false);
    }
  }

  if (isKaltura) {
    return (
      <button
        type="button"
        onClick={fetchFromKaltura}
        disabled={fetching}
        title={error
          ? `Kaltura captions failed: ${error}. Click to retry.`
          : "No transcript. Fetch captions from Kaltura."}
        style={{ ...BASE, ...FETCHABLE_STYLE, opacity: fetching ? 0.6 : 1 }}
      >
        {fetching ? "Fetching transcript..." : (error ? "Retry transcript fetch" : "Fetch transcript")}
      </button>
    );
  }

  return (
    <span title="No transcript available for this record" style={{ ...BASE, ...MISSING_STYLE, opacity: 0.8 }}>
      No transcript
    </span>
  );
}
