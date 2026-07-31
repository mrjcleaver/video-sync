/**
 * Shared clip actions used by both `/shorts` (ShortsPanel) and the
 * inline nested-clip actions on a parent VideoCard. Extracted from
 * ShortsPanel so the two call-sites don't drift; the state-machine
 * transitions + SSE parsing + CTA autopost + preflight all live
 * here in one place.
 */

import { videoStore } from "./store";
import type { VideoRecordJSON } from "./wasm";
import { actorCommand } from "./useCurrentActor";
import type { ActorState } from "./useCurrentActor";

export interface ShortsActionCtx {
  actorState: ActorState;
  onEvent: (msg: string, ctx?: { video_id?: string }) => void;
  onMutated: () => void;
  onPublishError?: (clipId: string, err: string | null) => void;
  onPublishingStart?: (clipId: string) => void;
  onPublishingEnd?: () => void;
}

export function approveShort(clip: VideoRecordJSON, ctx: ShortsActionCtx): void {
  videoStore.mutate(clip.id, (r) => r.approve(actorCommand(ctx.actorState)));
  ctx.onEvent(`ShortApproved: "${clip.title}"`, { video_id: clip.id });
  ctx.onMutated();
}

export function rejectShort(clip: VideoRecordJSON, ctx: ShortsActionCtx): void {
  videoStore.mutate(clip.id, (r) => r.abandon(actorCommand(ctx.actorState)));
  ctx.onEvent(`ShortRejected: "${clip.title}"`, { video_id: clip.id });
  ctx.onMutated();
}

/**
 * The full publish pipeline. Preflight → state transitions → SSE
 * upload → destination location + mark_published → CTA autopost.
 * Never throws; any error is captured via onPublishError.
 */
export async function publishShort(clip: VideoRecordJSON, ctx: ShortsActionCtx): Promise<void> {
  const cmd = (extra?: Record<string, unknown>) => actorCommand(ctx.actorState, extra);
  ctx.onPublishError?.(clip.id, null);

  let connections: Record<string, { credentials?: Record<string, string> }> = {};
  try {
    const raw = localStorage.getItem("video-sync:connections");
    if (raw) connections = JSON.parse(raw);
  } catch { /* ignore */ }

  const ytCreds = connections["YouTube"]?.credentials;
  if (!ytCreds?.refreshToken || !ytCreds?.clientId || !ytCreds?.clientSecret) {
    ctx.onPublishError?.(clip.id, "YouTube not authorized");
    return;
  }

  const extra = clip.metadata_extra ?? {};
  const parentYtId = extra.parent_youtube_id as string | undefined;

  const parentBlock = parentYtId
    ? `▶ Watch the full recording:\nhttps://youtu.be/${parentYtId}\n\n`
    : "";
  const footerParts = [
    `catalog:${clip.id}`,
    `source:OpusClip:${clip.source_id}`,
    clip.metadata_extra?.parent_source_id ? `parent:${clip.metadata_extra.parent_source_id}` : null,
  ].filter(Boolean);
  const provenanceFooter = `\n\n---\nvideo-sync | ${footerParts.join(" | ")}`;
  const description = `${parentBlock}${provenanceFooter}`.slice(0, 5000);
  const shortTitle = clip.title.includes("#Shorts") ? clip.title : `${clip.title} #Shorts`;

  ctx.onPublishingStart?.(clip.id);
  try {
    // Preflight — reconcile if the short is already on YouTube.
    const existingDest = (clip.locations ?? []).find(
      (l) => l.platform === "YouTube" && l.role === "Destination" && l.external_id,
    );
    let reconciledVideoId: string | null = null;
    let reconciledVideoUrl: string | null = null;
    if (existingDest) {
      try {
        const chkRes = await fetch(
          `/api/youtube/status?videoId=${encodeURIComponent(existingDest.external_id)}`,
          {
            headers: {
              "x-youtube-refresh-token": ytCreds.refreshToken,
              "x-youtube-client-id": ytCreds.clientId,
              "x-youtube-client-secret": ytCreds.clientSecret,
            },
          },
        );
        if (chkRes.ok) {
          reconciledVideoId = existingDest.external_id;
          reconciledVideoUrl = existingDest.external_url
            ?? `https://www.youtube.com/watch?v=${existingDest.external_id}`;
          ctx.onEvent(
            `ShortAlreadyOnYouTube: "${clip.title}" — reconciling without re-upload (YouTube/${existingDest.external_id})`,
            { video_id: clip.id },
          );
        }
      } catch { /* fall through to a fresh upload */ }
    }

    // Failed/ToRetry needs to walk back through Approved.
    if (clip.status === "Failed" || clip.status === "ToRetry") {
      videoStore.mutate(clip.id, (r) => r.approve(cmd()));
    }

    videoStore.mutate(clip.id, (r) => r.request_publish(cmd()));
    ctx.onMutated();

    if (reconciledVideoId && reconciledVideoUrl) {
      videoStore.mutate(clip.id, (r) =>
        r.mark_published(JSON.stringify({
          destination_id: reconciledVideoId!,
          destination_url: reconciledVideoUrl!,
        })),
      );
      ctx.onEvent(
        `ShortReconciled: "${clip.title}" → YouTube/${reconciledVideoId}`,
        { video_id: clip.id },
      );
      ctx.onMutated();
      return;
    }

    const body: Record<string, unknown> = {
      refreshToken: ytCreds.refreshToken,
      clientId: ytCreds.clientId,
      clientSecret: ytCreds.clientSecret,
      title: shortTitle,
      description,
      tags: [...(clip.tags ?? []), "Shorts"],
      downloadUrl: clip.download_url,
      privacyStatus: "public",
    };

    const res = await fetch("/api/youtube/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let errMsg = `Upload failed (${res.status})`;
      try { const d = await res.json(); errMsg = d.error ?? errMsg; } catch { /* ignore */ }
      throw new Error(errMsg);
    }
    if (!res.body) throw new Error("No response stream from upload endpoint");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";
    let result: { videoId: string; videoUrl: string } | null = null;
    let lastPhase = "(none)";
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const payload = JSON.parse(line.slice(6)) as Record<string, string>;
          if (eventType === "progress" && payload.phase) {
            lastPhase = payload.phase;
          } else if (eventType === "complete") {
            result = { videoId: payload.videoId, videoUrl: payload.videoUrl };
            break outer;
          } else if (eventType === "error") {
            throw new Error(payload.message ?? "Upload failed");
          }
          eventType = "";
        }
      }
    }
    if (!result) throw new Error(`Upload stream ended without complete event (last phase: ${lastPhase})`);

    videoStore.mutate(clip.id, (r) => {
      r.add_location(cmd({ platform: "YouTube",
        external_id: result!.videoId,
        external_url: result!.videoUrl,
        role: "Destination" }));
      return r.mark_published(JSON.stringify({
        destination_id: result!.videoId,
        destination_url: result!.videoUrl,
      }));
    });

    ctx.onEvent(`ShortPublished: "${clip.title}" → YouTube/${result.videoId}`, { video_id: clip.id });
    ctx.onMutated();

    // ADR-029 CTA autopost.
    if (parentYtId) {
      const ctaText = `▶ Watch the full recording: https://youtu.be/${parentYtId}`;
      try {
        const cRes = await fetch("/api/youtube/post-comment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: result.videoId,
            text: ctaText,
            refreshToken: ytCreds.refreshToken,
            clientId: ytCreds.clientId,
            clientSecret: ytCreds.clientSecret,
          }),
        });
        if (cRes.ok) {
          ctx.onEvent(`ShortCtaCommentPosted: "${clip.title}" — pin it in YouTube Studio to lock at top`, { video_id: clip.id });
        } else {
          const cData = await cRes.json().catch(() => ({} as { error?: string; missingScope?: boolean }));
          ctx.onEvent(`ShortCtaCommentSkipped: "${clip.title}" — ${cData.error ?? `HTTP ${cRes.status}`}`, { video_id: clip.id });
        }
      } catch (err) {
        ctx.onEvent(`ShortCtaCommentSkipped: "${clip.title}" — ${err instanceof Error ? err.message : String(err)}`, { video_id: clip.id });
      }
    }
  } catch (err) {
    videoStore.mutate(clip.id, (r) =>
      r.mark_failed(JSON.stringify({ error_message: String(err) })),
    );
    ctx.onPublishError?.(clip.id, String(err));
    ctx.onMutated();
  } finally {
    ctx.onPublishingEnd?.();
  }
}
