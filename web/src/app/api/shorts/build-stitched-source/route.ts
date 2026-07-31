/**
 * ADR-062 slice 2 — build a stitched clip source and hand Opus
 * back a fetchable URL.
 *
 * Body:
 *   { record_id, download_url, summary_doc_id?, source_duration_sec,
 *     main_show_start_sec?, main_show_end_sec?, sections?,
 *     radius_before_sec?, radius_after_sec?, include_main_show?,
 *     zoom_creds?, fireflies_api_key?, kaltura_creds?, yt_cookies? }
 *
 * Pipeline (roughly ADR-062 §2):
 *   1. Preview: rebuild the merged region set (server-side, same
 *      lib as /api/shorts/preview-regions).
 *   2. Download the source to a tmp file.
 *   3. ffmpeg -ss <start> -to <end> -c copy per region → tmp mp4s.
 *   4. ffmpeg -f concat -c copy → single stitched.mp4.
 *   5. Upload to the shared Drive under the record's year/month
 *      bucket with anyone-with-link sharing.
 *   6. Return the Drive download URL + region manifest.
 *
 * Cleanup on Opus terminal state is deferred; a weekly janitor
 * (documented in ADR-062 §Consequences) enforces a 30-day TTL.
 *
 * NB: the -c copy path may fail when regions don't align to
 * keyframes. When ffmpeg errors on -c copy we fall back to
 * -c:v libx264 -preset ultrafast -c:a aac for that region /
 * concat step — slower but correct.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import { buildRegions } from "../../../../lib/clipSourceRegions";
import { downloadSourceToFile } from "../../../../lib/videoDownload";
import { getDrive, getRootFolderId, uploadBinaryFile, shareAnyoneWithLink } from "../../../../lib/drive";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 600; // 10 min — long downloads + ffmpeg

interface Body {
  record_id?: string;
  download_url?: string;
  summary_doc_id?: string;
  source_duration_sec?: number;
  main_show_start_sec?: number;
  main_show_end_sec?: number;
  sections?: Array<"M" | "L" | "T" | "C">;
  radius_before_sec?: number;
  radius_after_sec?: number;
  include_main_show?: boolean;
  merge_gap_sec?: number;
  zoom_creds?: { accountId: string; clientId: string; clientSecret: string };
  fireflies_api_key?: string;
  kaltura_creds?: { partnerId: string; adminSecret: string };
  yt_cookies?: string;
}

async function fetchSummaryMarkdown(docId: string): Promise<string> {
  const drive = getDrive();
  try {
    const md = await drive.files.export({ fileId: docId, mimeType: "text/markdown" });
    if (typeof md.data === "string") return md.data;
  } catch { /* fall through */ }
  const txt = await drive.files.export({ fileId: docId, mimeType: "text/plain" });
  return typeof txt.data === "string" ? txt.data : "";
}

function ffmpeg(args: string[], timeoutMs = 600_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr || "").trim() || err.message;
        reject(new Error(`ffmpeg failed: ${detail.slice(0, 500)}`));
      } else resolve();
    });
  });
}

async function extractRegion(sourcePath: string, startSec: number, endSec: number, outPath: string) {
  const dur = endSec - startSec;
  // First attempt: -c copy (fast, no re-encode). Falls back to
  // re-encode if -c copy produces invalid output at the cut
  // boundary (common when regions don't land on keyframes).
  const copyArgs = ["-y", "-ss", String(startSec), "-i", sourcePath, "-t", String(dur), "-c", "copy", "-avoid_negative_ts", "make_zero", outPath];
  try { await ffmpeg(copyArgs); return; } catch { /* fall through */ }
  const reencArgs = ["-y", "-ss", String(startSec), "-i", sourcePath, "-t", String(dur), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-avoid_negative_ts", "make_zero", outPath];
  await ffmpeg(reencArgs);
}

async function concatRegions(partPaths: string[], outPath: string) {
  const listPath = `${outPath}.list.txt`;
  await fs.writeFile(listPath, partPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  const copyArgs = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath];
  try { await ffmpeg(copyArgs); return; }
  catch { /* fall through to re-encode */ }
  finally { fs.unlink(listPath).catch(() => {}); }
  const listPath2 = `${outPath}.list2.txt`;
  await fs.writeFile(listPath2, partPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  try {
    const reencArgs = ["-y", "-f", "concat", "-safe", "0", "-i", listPath2, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", outPath];
    await ffmpeg(reencArgs);
  } finally {
    fs.unlink(listPath2).catch(() => {});
  }
}

async function handler(req: NextRequest) {
  try { await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }

  const body: Body = await req.json().catch(() => ({}));
  const { record_id, download_url, summary_doc_id, source_duration_sec } = body;
  if (!record_id) return NextResponse.json({ error: "record_id required" }, { status: 400 });
  if (!download_url) return NextResponse.json({ error: "download_url required" }, { status: 400 });
  if (typeof source_duration_sec !== "number" || source_duration_sec <= 0) {
    return NextResponse.json({ error: "source_duration_sec must be a positive number" }, { status: 400 });
  }

  let markdown = "";
  if (summary_doc_id) {
    try { markdown = await fetchSummaryMarkdown(summary_doc_id); }
    catch (err) {
      return NextResponse.json({ error: `Couldn't fetch summary Doc: ${err instanceof Error ? err.message : String(err)}` }, { status: 424 });
    }
  }
  const rs = buildRegions(markdown, {
    sections: body.sections,
    radius_before_sec: body.radius_before_sec,
    radius_after_sec: body.radius_after_sec,
    include_main_show: body.include_main_show,
    main_show_start_sec: body.main_show_start_sec,
    main_show_end_sec: body.main_show_end_sec,
    merge_gap_sec: body.merge_gap_sec,
    source_duration_sec,
  });
  if (rs.regions.length === 0) {
    return NextResponse.json({ error: "no regions to stitch — either add a main-show window or a summary with timestamped highlights" }, { status: 400 });
  }

  const workDir = join(tmpdir(), `opus-stitch-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  const sourcePath = join(workDir, "source.mp4");
  const stitchedPath = join(workDir, "stitched.mp4");

  try {
    serverLog("info", "shorts:stitch", "downloading source", { record_id, download_url });
    await downloadSourceToFile(download_url, sourcePath, {
      zoom: body.zoom_creds,
      fireflies: body.fireflies_api_key ? { apiKey: body.fireflies_api_key } : undefined,
      kaltura: body.kaltura_creds,
      youtubeCookies: body.yt_cookies,
    });

    serverLog("info", "shorts:stitch", "extracting regions", { record_id, region_count: rs.regions.length });
    const partPaths: string[] = [];
    for (let i = 0; i < rs.regions.length; i++) {
      const r = rs.regions[i];
      const partPath = join(workDir, `part-${String(i).padStart(3, "0")}.mp4`);
      await extractRegion(sourcePath, r.start_sec, r.end_sec, partPath);
      partPaths.push(partPath);
    }

    serverLog("info", "shorts:stitch", "concatenating", { record_id, part_count: partPaths.length });
    await concatRegions(partPaths, stitchedPath);

    serverLog("info", "shorts:stitch", "uploading to Drive", { record_id });
    const uploaded = await uploadBinaryFile(
      `opus-stitch-${record_id}-${Date.now()}.mp4`,
      getRootFolderId(),
      stitchedPath,
      "video/mp4",
    );
    await shareAnyoneWithLink(uploaded.id);

    // Direct-download URL Opus's fetcher can follow. Drive's
    // webContentLink includes an `&export=download` param when
    // populated; fall back to the generic /uc? form otherwise.
    const opusUrl = uploaded.webContentLink
      ?? `https://drive.google.com/uc?export=download&id=${uploaded.id}`;

    return NextResponse.json({
      record_id,
      drive_file_id: uploaded.id,
      opus_video_url: opusUrl,
      web_view_link: uploaded.webViewLink,
      total_stitched_sec: rs.total_stitched_sec,
      region_manifest: rs.regions,
      extracted_highlights: rs.extracted_highlights,
    });
  } catch (err) {
    serverLog("error", "shorts:stitch", "build failed", { record_id, err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  } finally {
    // Always scrub the tmpdir — the source + parts are chunky.
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const POST = withRequestLogging("api:shorts/build-stitched-source", handler);
