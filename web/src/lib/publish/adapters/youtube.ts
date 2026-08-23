/**
 * ADR-077 §3 — YouTube destination adapter.
 *
 * Extracted from VideoCard's publishToYouTube. The SSE reader and its
 * diagnostics are the substantive part: /api/youtube/upload streams
 * `progress` / `complete` / `error` frames over a single persistent
 * connection, and a stream that closes without `complete` is the
 * signature of the server process dying mid-flight — most often Cloud Run
 * OOM-killing the container during an ffmpeg trim, since the source MP4
 * and the trimmed output both live in a RAM-backed /tmp.
 *
 * That diagnostic path had no test coverage while it lived inline.
 */

import type { DestinationAdapter, PushRequest, PushResult } from "../types";

/** Parsed SSE frame. Exported for the parser test. */
interface StreamFrame {
  event: string;
  data: Record<string, string>;
}

/** Split an SSE text chunk into complete frames, returning any trailing
 *  partial line for the next read. */
export function parseSseChunk(
  buffer: string,
): { frames: StreamFrame[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const frames: StreamFrame[] = [];
  let event = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      event = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      try {
        frames.push({ event, data: JSON.parse(line.slice(6)) as Record<string, string> });
      } catch {
        // A frame we can't parse is not worth failing the upload over;
        // the terminal `complete` / `error` frames are what matter.
      }
      event = "";
    }
  }
  return { frames, rest };
}

/** Build the "stream died" message, including the OOM hint when the last
 *  phase says we were mid-trim. Exported so the wording is testable. */
export function streamEndedMessage(lastPhase: string): string {
  const trimmed = /^Trimming /i.test(lastPhase);
  const hint = trimmed
    ? " Likely Cloud Run OOM during ffmpeg trim — the recording is too large for the 4 GiB tmpfs + working set. Try publishing with trim=0 (no trim) or ask Ops to bump Cloud Run memory."
    : " Server-side process exited before completing — check Cloud Run logs (filter component=\"ext:youtube-upload\") around this time.";
  return `Upload stream ended without a result. Last phase: "${lastPhase}".${hint}`;
}

export const youtubeAdapter: DestinationAdapter = {
  platform: "YouTube",

  async push(req: PushRequest): Promise<PushResult> {
    const yt = req.creds.youtube;
    if (!yt?.refreshToken || !yt.clientId || !yt.clientSecret) {
      throw new Error("YouTube not authorized — connect it in Config first.");
    }

    const body: Record<string, unknown> = {
      refreshToken: yt.refreshToken,
      clientId: yt.clientId,
      clientSecret: yt.clientSecret,
      title: req.attrs.title,
      description: req.attrs.description,
      tags: req.attrs.tags,
      downloadUrl: req.sourceUrl,
      // YouTube is the one platform whose push applies the declared
      // visibility (see appliesDeclaredVisibility).
      privacyStatus: req.attrs.visibility,
      recordedAt: req.record.recorded_at || undefined,
      ...(req.attrs.trimStartSeconds && req.attrs.trimStartSeconds > 0
        ? { trimStartSeconds: req.attrs.trimStartSeconds }
        : {}),
      ...req.creds.source,
    };

    const res = await fetch("/api/youtube/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let errMsg = `Upload failed (${res.status})`;
      try {
        const d = await res.json() as { error?: string };
        errMsg = d.error ?? errMsg;
      } catch { /* non-JSON error body */ }
      throw new Error(errMsg);
    }
    if (!res.body) throw new Error("No response stream from upload endpoint");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastPhase = "(none)";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.event === "progress" && frame.data.phase) {
          lastPhase = frame.data.phase;
          req.onPhase?.(frame.data.phase);
        } else if (frame.event === "complete") {
          return {
            external_id: frame.data.videoId,
            external_url: frame.data.videoUrl,
          };
        } else if (frame.event === "error") {
          throw new Error(frame.data.message ?? "Upload failed");
        }
      }
    }

    throw new Error(streamEndedMessage(lastPhase));
  },
};
