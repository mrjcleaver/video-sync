"use client";

/**
 * ADR-065 — Contributor landing page.
 *
 * Community members (Google group video-sync-contributors@) land here
 * after IAP auth. Trimmed surface: URL-based imports of YouTube / Loom
 * recordings (Zoom URL + manual Drive file are spec'd but not yet
 * wired — see ADR-065 §5), plus a read-only table of the contributor's
 * own submissions with status transitions surfaced.
 *
 * Higher-role users (Publisher / Admin) can visit this page too — it
 * is just a subset of Import. Filtering the "Your contributions" table
 * uses the current actor's email against contributor_email.
 */

import { useMemo, useState } from "react";
import URLImport from "../../../components/URLImport";
import { useApp } from "../AppContext";
import { useCurrentActor } from "../../../lib/useCurrentActor";
import { useRouter } from "next/navigation";

export default function ContributePage() {
  const { videos, addEvent, refresh } = useApp();
  const actorState = useCurrentActor();
  const router = useRouter();
  const [chapter, setChapter] = useState("");
  const [pastedTranscript, setPastedTranscript] = useState("");

  const email = actorState.actor?.email ?? "";
  const role = actorState.actor?.role ?? "Viewer";

  const mine = useMemo(
    () => videos
      .filter((v) => (v.contributor_email ?? "") === email && v.source_platform !== "OpusClip")
      .sort((a, b) => (b.recorded_at ?? b.indexed_at ?? "").localeCompare(a.recorded_at ?? a.indexed_at ?? "")),
    [videos, email],
  );

  function onImported({ ids }: { ids: string[] }) {
    // Stamp the newly-created records with the contributor attribution.
    // The URLImport creates records at Discovered via WasmVideoRecord.new;
    // we set the attribution via update_metadata immediately after.
    // (Ships via metadata_extra for now — the strongly-typed
    // contributor_email/chapter fields will populate on next server
    // hydrate once the WASM update_metadata command accepts them.)
    if (ids.length === 0) return;
    // ADR-071 §4 — if the contributor pasted a transcript, apply it
    // to any newly-created records that don't already have one
    // (Loom's auto-transcript is preserved). Cleared after the
    // batch so subsequent imports don't inherit stale text.
    if (pastedTranscript.trim()) {
      import("../../../lib/store").then(({ videoStore }) => {
        for (const id of ids) {
          const existing = videoStore.getAll().find(v => v.id === id);
          if (existing && !existing.transcript_text) {
            videoStore.setTranscript(id, pastedTranscript.trim());
          }
        }
      });
      setPastedTranscript("");
    }
    refresh();
    addEvent(`Contributed: ${ids.length} record${ids.length === 1 ? "" : "s"} by ${email}${chapter ? ` (${chapter})` : ""}`);
  }

  return (
    <>
      <div className="header">
        <h1>🎁 Contribute a recording</h1>
      </div>

      <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: "0.88rem", color: "var(--text-muted)", marginBottom: 8 }}>
          Paste a YouTube, Loom, public Zoom-share, or Google Drive URL to submit a recording.
          A curator reviews and (if approved) publishes it to the org&apos;s channels.
          You&apos;ll see it appear in <strong>Your contributions</strong> below.
        </div>

        <label style={{ display: "block", marginBottom: 12 }}>
          <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: 3 }}>
            Chapter (optional)
          </div>
          <input
            type="text"
            value={chapter}
            onChange={(e) => setChapter(e.target.value)}
            placeholder="e.g. Agentics Toronto"
            style={{
              width: "100%", maxWidth: 320, padding: "6px 8px",
              fontSize: "0.9rem", background: "var(--bg)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 4,
            }}
          />
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 3 }}>
            Free-text. Tags each submission below so curators know where it came from.
          </div>
        </label>

        <URLImport onImported={onImported} onEvent={addEvent} />

        <details style={{ marginTop: 12, fontSize: "0.82rem" }}>
          <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>
            Transcript (paste, optional)
          </summary>
          <div style={{ padding: "8px 4px" }}>
            <label htmlFor="contribute-transcript" style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              If you already have a transcript for these recordings (VTT, plain text, or copied from
              Zoom / Otter / Fathom), paste it here. It attaches to any newly-created records that
              don&apos;t already carry an auto-transcript. Useful for Drive files, which arrive
              without one.
            </label>
            <textarea
              id="contribute-transcript"
              value={pastedTranscript}
              onChange={(e) => setPastedTranscript(e.target.value)}
              placeholder="Paste transcript text here…"
              rows={5}
              style={{
                width: "100%", marginTop: 6, padding: "6px 8px",
                background: "var(--bg)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 6,
                fontSize: "0.8rem", fontFamily: "monospace",
                resize: "vertical", boxSizing: "border-box",
              }}
            />
          </div>
        </details>

        <details style={{ marginTop: 12, fontSize: "0.82rem" }}>
          <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>Other sources</summary>
          <div style={{ padding: "8px 4px", color: "var(--text-muted)", fontSize: "0.78rem" }}>
            <p>
              <strong>Zoom share URLs</strong> (<code>zoom.us/rec/share/…</code>): paste directly into the
              URL box above. The recording page is public, so no OAuth is needed on your side — a curator
              will re-fetch full metadata later.
            </p>
            <p>
              <strong>Google Drive files</strong> (<code>drive.google.com/file/d/…</code>): paste directly
              into the URL box above. Publicly-shared files ingest automatically; private files land in a
              curator queue and get pulled on approval — you&apos;ll see the status transition in
              <strong> Your contributions</strong>.
            </p>
          </div>
        </details>
      </div>

      <div className="panel" style={{ padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <strong>Your contributions ({mine.length})</strong>
          <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
            Signed in as {email} · role: {role}
          </span>
        </div>
        {mine.length === 0 ? (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontStyle: "italic", padding: "10px 0" }}>
            No submissions yet. Paste a URL above to add one.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.86rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "6px 4px" }}>Title</th>
                <th style={{ padding: "6px 4px" }}>Recorded</th>
                <th style={{ padding: "6px 4px" }}>Chapter</th>
                <th style={{ padding: "6px 4px" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((v) => (
                <tr
                  key={v.id}
                  onClick={() => router.push(`/catalog?just=${v.id}`)}
                  style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                >
                  <td style={{ padding: "6px 4px" }}>{v.title || "(untitled)"}</td>
                  <td style={{ padding: "6px 4px", color: "var(--text-muted)" }}>
                    {v.recorded_at ? new Date(v.recorded_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—"}
                  </td>
                  <td style={{ padding: "6px 4px", color: "var(--text-muted)" }}>{v.contributor_chapter || "—"}</td>
                  <td style={{ padding: "6px 4px" }}>{v.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
