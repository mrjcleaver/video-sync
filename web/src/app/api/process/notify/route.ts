/**
 * POST /api/process/notify
 * Fire post-processing actions: webhook HTTP POST or Gmail email.
 * Always returns 200 — callers are fire-and-forget.
 *
 * ADR-039: webhook payload now includes an `artifacts` block with Drive
 * URLs (folder + per-kind file references). Email body's transcript
 * excerpt replaced by a Drive folder link.
 *
 * `video.transcript_text` stays in the payload for one release cycle as
 * a deprecated field; consumers should switch to `artifacts.transcript`.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getMeta, buildWebhookArtifactBlock, type WebhookArtifactBlock } from "../../../../lib/driveArtifactStore";
import nodemailer from "nodemailer";

interface NotifyRequest {
  action:
    | { type: "webhook"; url: string }
    | { type: "email"; to: string; subject_template?: string };
  video: {
    id: string;
    title: string;
    source_platform: string;
    source_id: string;
    recorded_at?: string;
    description?: string | null;
    transcript_text?: string | null;
  };
  success: boolean;
  youtubeUrl?: string;
  error?: string;
}

function baseApiUrl(req: NextRequest): string {
  // Env var wins; fall back to inferring from the request host.
  const env = process.env.APP_BASE_URL;
  if (env) return env.replace(/\/$/, "");
  const host = req.headers.get("host");
  if (host) return `https://${host}`;
  return "https://video-sync.agentics.org";
}

async function resolveArtifacts(record_id: string, baseUrl: string): Promise<WebhookArtifactBlock | null> {
  try {
    const meta = await getMeta(record_id);
    if (!meta) return null;
    return buildWebhookArtifactBlock(meta, baseUrl);
  } catch (err) {
    serverLog("warn", "post-process:artifacts", "drive lookup failed", {
      record_id,
      error: String(err),
    });
    return null;
  }
}

async function handler(req: NextRequest) {
  let body: NotifyRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action, video, success, youtubeUrl, error } = body;
  const rid = req.headers.get("x-request-id") ?? "n/a";
  const baseUrl = baseApiUrl(req);

  // Resolve once; both webhook and email reuse it.
  const artifacts = await resolveArtifacts(video.id, baseUrl);

  if (action.type === "webhook") {
    const payload = {
      event: success ? "publish_success" : "publish_failure",
      video,
      youtubeUrl: youtubeUrl ?? null,
      ...(artifacts ? { artifacts } : {}),
      error: error ?? null,
      timestamp: new Date().toISOString(),
    };
    try {
      const res = await fetch(action.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      serverLog("info", "post-process:webhook", "fired", {
        url: action.url,
        status: res.status,
        has_artifacts: artifacts !== null,
        rid,
      });
    } catch (err) {
      serverLog("error", "post-process:webhook", "failed", {
        url: action.url,
        error: String(err),
        rid,
      });
    }
  } else if (action.type === "email") {
    const gmailFrom = process.env.GMAIL_FROM;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    if (!gmailFrom || !gmailPass) {
      serverLog("warn", "post-process:email", "no-credentials", { rid });
      return NextResponse.json({ ok: true, warning: "GMAIL_FROM / GMAIL_APP_PASSWORD not configured" });
    }

    const statusLabel = success ? "Published" : "Failed";
    const subject = action.subject_template
      ? action.subject_template
          .replace(/\{\{title\}\}/g, video.title)
          .replace(/\{\{status\}\}/g, statusLabel)
      : `Video ${statusLabel}: ${video.title}`;

    const lines = [
      `Video: ${video.title}`,
      `Status: ${statusLabel}`,
      youtubeUrl ? `YouTube URL: ${youtubeUrl}` : null,
      error ? `Error: ${error}` : null,
      `Source: ${video.source_platform} / ${video.source_id}`,
      video.recorded_at ? `Recorded: ${video.recorded_at}` : null,
      `Catalog ID: ${video.id}`,
      video.description ? `\nDescription:\n${video.description}` : null,
      artifacts?.folder.drive_web_url
        ? `\nDrive folder: ${artifacts.folder.drive_web_url}`
        : null,
    ].filter(Boolean);

    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailFrom, pass: gmailPass },
      });
      await transporter.sendMail({
        from: gmailFrom,
        to: action.to,
        subject,
        text: lines.join("\n"),
      });
      serverLog("info", "post-process:email", "sent", { to: action.to, subject, rid });
    } catch (err) {
      serverLog("error", "post-process:email", "failed", {
        to: action.to,
        error: String(err),
        rid,
      });
    }
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLogging("api:process/notify", handler);
