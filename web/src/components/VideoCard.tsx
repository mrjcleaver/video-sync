"use client";

import { useState } from "react";
import type { VideoRecordJSON, PlatformLocationJSON } from "../lib/wasm";
import { videoStore } from "../lib/store";
import { addExclusion } from "../lib/rules";

const PLATFORMS = ["Zoom", "Loom", "Fireflies", "YouTube", "Kaltura", "Veedio"] as const;
const ROLES = ["Origin", "Intermediate", "Destination"] as const;

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Static admin actor for demo purposes
const ADMIN_ACTOR = JSON.stringify({
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "Admin",
});

interface Props {
  video: VideoRecordJSON;
  onMutated: () => void;
  onEvent: (event: string) => void;
}

export default function VideoCard({ video, onMutated, onEvent }: Props) {
  const [noteText, setNoteText] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const [showLocationForm, setShowLocationForm] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState("");
  const [locPlatform, setLocPlatform] = useState<string>("Loom");
  const [locExternalId, setLocExternalId] = useState("");
  const [locExternalUrl, setLocExternalUrl] = useState("");
  const [locRole, setLocRole] = useState<string>("Intermediate");
  const [checkingStatus, setCheckingStatus] = useState<string | null>(null);

  function approve() {
    videoStore.mutate(video.id, (r) =>
      r.approve(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) }))
    );
    onEvent(`VideoApproved: "${video.title}"`);
    onMutated();
  }

  function markInScope() {
    videoStore.mutate(video.id, (r) =>
      r.mark_in_scope(
        JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR), rule_id: null })
      )
    );
    onEvent(`VideoScoped: "${video.title}"`);
    onMutated();
  }

  function skip() {
    videoStore.mutate(video.id, (r) =>
      r.skip(
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          reason: "Skipped from dashboard",
        })
      )
    );
    onEvent(`VideoSkipped: "${video.title}"`);
    onMutated();
  }

  function exclude() {
    addExclusion(video.source_platform, video.source_id, "Manual exclusion");
    videoStore.mutate(video.id, (r) =>
      r.skip(
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          reason: "Excluded from ingestion",
        })
      )
    );
    onEvent(`VideoExcluded: "${video.title}"`);
    onMutated();
  }

  function requestPublish() {
    videoStore.mutate(video.id, (r) =>
      r.request_publish(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) }))
    );
    onEvent(`StatusChanged: "${video.title}" -> Publishing`);
    onMutated();
  }

  async function publishToYouTube() {
    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      if (raw) connections = JSON.parse(raw);
    } catch { /* ignore */ }

    const ytCreds = connections["YouTube"]?.credentials;
    if (!ytCreds?.refreshToken || !ytCreds?.clientId || !ytCreds?.clientSecret) {
      alert("YouTube not authorized. Configure and authorize YouTube in Connections first.");
      return;
    }

    setUploading(true);
    const isZoomSource = video.download_url.startsWith("zoom://");
    const isLoomSource = /loom\.com\/(?:share|v)\//i.test(video.download_url);
    setUploadPhase(isZoomSource ? "Downloading from Zoom..." : isLoomSource ? "Downloading from Loom..." : "Uploading to YouTube...");

    try {
      // Include Zoom credentials if the source is a Zoom recording
      const zoomCreds = connections["Zoom"]?.credentials;
      const uploadBody: Record<string, unknown> = {
        refreshToken: ytCreds.refreshToken,
        clientId: ytCreds.clientId,
        clientSecret: ytCreds.clientSecret,
        title: video.title,
        description: video.description || "",
        tags: video.tags,
        downloadUrl: video.download_url,
        privacyStatus: "unlisted",
        recordedAt: video.recorded_at || undefined,
      };

      if (isZoomSource && zoomCreds) {
        uploadBody.zoomAccountId = zoomCreds.accountId;
        uploadBody.zoomClientId = zoomCreds.clientId;
        uploadBody.zoomClientSecret = zoomCreds.clientSecret;
      }

      if (isZoomSource) {
        // Update phase after download starts
        setTimeout(() => {
          if (uploading) setUploadPhase("Uploading to YouTube...");
        }, 5000);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 min timeout

      const res = await fetch("/api/youtube/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(uploadBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Server returned ${res.status} with non-JSON response`);
      }
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);

      videoStore.mutate(video.id, (r) =>
        r.mark_published(
          JSON.stringify({
            destination_id: data.videoId,
            destination_url: data.videoUrl,
          })
        )
      );
      onEvent(`VideoPublished: "${video.title}" -> ${data.videoUrl}`);
      onMutated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      videoStore.mutate(video.id, (r) =>
        r.mark_failed(JSON.stringify({ error_message: msg }))
      );
      onEvent(`VideoPublishFailed: "${video.title}" — ${msg}`);
      onMutated();
    } finally {
      setUploading(false);
      setUploadPhase("");
    }
  }

  function abandonVideo() {
    videoStore.mutate(video.id, (r) =>
      r.abandon(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR), reason: "Abandoned from dashboard" }))
    );
    onEvent(`VideoAbandoned: "${video.title}"`);
    onMutated();
  }

  function markToRetry() {
    videoStore.mutate(video.id, (r) =>
      r.mark_to_retry(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR), reason: "Retry requested from dashboard" }))
    );
    onEvent(`VideoMarkedToRetry: "${video.title}"`);
    onMutated();
  }

  async function checkYouTubeStatus(loc: PlatformLocationJSON) {
    let connections: Record<string, { credentials?: Record<string, string> }> = {};
    try {
      const raw = localStorage.getItem("video-sync:connections");
      if (raw) connections = JSON.parse(raw);
    } catch { /* ignore */ }

    const ytCreds = connections["YouTube"]?.credentials;
    if (!ytCreds?.refreshToken || !ytCreds?.clientId || !ytCreds?.clientSecret) {
      alert("YouTube not authorized. Configure YouTube in Connections first.");
      return;
    }

    setCheckingStatus(loc.external_id);
    try {
      const res = await fetch(
        `/api/youtube/status?videoId=${encodeURIComponent(loc.external_id)}`,
        {
          headers: {
            "x-youtube-refresh-token": ytCreds.refreshToken,
            "x-youtube-client-id": ytCreds.clientId,
            "x-youtube-client-secret": ytCreds.clientSecret,
          },
        }
      );
      const data = await res.json();
      if (!res.ok) {
        // Video not found or API error — mark as failed
        if (res.status === 404) {
          try {
            videoStore.mutate(video.id, (r) =>
              r.mark_failed(JSON.stringify({ error_message: "YouTube video not found" }))
            );
            onEvent(`VideoFailed: "${video.title}" — YouTube video not found`);
            onMutated();
          } catch { /* ignore if status transition not allowed */ }
          return;
        }
        throw new Error(data.error || `Status check failed (${res.status})`);
      }

      // If YouTube reports processing failed or removed, mark video as failed
      const failedStatuses = ["ProcessingFailed", "Removed"];
      if (failedStatuses.includes(data.status)) {
        try {
          videoStore.mutate(video.id, (r) =>
            r.update_location_status(
              JSON.stringify({
                actor: JSON.parse(ADMIN_ACTOR),
                platform: "YouTube",
                external_id: loc.external_id,
                status: data.status,
              })
            )
          );
        } catch { /* ignore */ }
        try {
          videoStore.mutate(video.id, (r) =>
            r.mark_failed(JSON.stringify({ error_message: `YouTube status: ${data.status}` }))
          );
        } catch { /* ignore if transition not allowed */ }
        onEvent(`VideoFailed: "${video.title}" — YouTube ${data.status}`);
        onMutated();
        return;
      }

      try {
        videoStore.mutate(video.id, (r) =>
          r.update_location_status(
            JSON.stringify({
              actor: JSON.parse(ADMIN_ACTOR),
              platform: "YouTube",
              external_id: loc.external_id,
              status: data.status,
            })
          )
        );
      } catch (wasmErr) {
        onEvent(`LocationStatusUpdated (display only): YouTube/${loc.external_id} -> ${data.status}`);
        onMutated();
        return;
      }
      onEvent(`LocationStatusUpdated: "${video.title}" YouTube/${loc.external_id} -> ${data.status}`);
      onMutated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent(`YouTubeStatusCheckFailed: "${video.title}" — ${msg}`);
      alert(`YouTube status check failed: ${msg}`);
    } finally {
      setCheckingStatus(null);
    }
  }

  function markFailed() {
    videoStore.mutate(video.id, (r) =>
      r.mark_failed(JSON.stringify({ error_message: "Manual failure from dashboard" }))
    );
    onEvent(`StatusChanged: "${video.title}" -> Failed`);
    onMutated();
  }

  function addLocation() {
    if (!locExternalId.trim()) return;
    videoStore.mutate(video.id, (r) =>
      r.add_location(
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          platform: locPlatform,
          external_id: locExternalId.trim(),
          external_url: locExternalUrl.trim() || null,
          role: locRole,
        })
      )
    );
    onEvent(`LocationAdded: "${video.title}" — ${locPlatform}/${locExternalId}`);
    setLocExternalId("");
    setLocExternalUrl("");
    setShowLocationForm(false);
    onMutated();
  }

  function removeLocation(loc: PlatformLocationJSON) {
    videoStore.mutate(video.id, (r) =>
      r.remove_location(
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          platform: loc.platform,
          external_id: loc.external_id,
        })
      )
    );
    onEvent(`LocationRemoved: "${video.title}" — ${loc.platform}/${loc.external_id}`);
    onMutated();
  }

  function addNote() {
    if (!noteText.trim()) return;
    videoStore.mutate(video.id, (r) =>
      r.add_note(
        JSON.stringify({
          actor: JSON.parse(ADMIN_ACTOR),
          text: noteText.trim(),
        })
      )
    );
    onEvent(`NoteAdded: "${video.title}" — "${noteText.trim()}"`);
    setNoteText("");
    onMutated();
  }

  const status = video.status;
  const canApprove = status === "Discovered" || status === "InScope" || status === "Failed" || status === "ToRetry";
  const canSkip = status === "Discovered" || status === "InScope";
  const canAbandon = status === "Failed" || status === "InScope" || status === "Discovered" || status === "Skipped" || status === "Published";
  const canRetry = status === "Failed" || status === "Published";
  const canScope = status === "Discovered";
  const canPublish = status === "Approved";
  const isPublishing = status === "Publishing";
  const alreadyPublished = (video.locations ?? []).some(
    (l) => l.role === "Destination" && l.platform === "YouTube"
  );

  return (
    <div className="video-card">
      <div className="video-card-header">
        <h3>{video.title}</h3>
        <span className={`status-badge status-${status}`}>{status}</span>
      </div>

      <div className="video-card-meta">
        <span>{video.source_platform}</span>
        <span>{formatDuration(video.duration_seconds)}</span>
        <span>{formatDate(video.recorded_at || video.indexed_at)}</span>
        {video.participants.length > 0 && (
          <span>{video.participants.length} participants</span>
        )}
      </div>

      {video.description && (
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: 8 }}>
          {video.description}
        </p>
      )}

      {video.tags.length > 0 && (
        <div className="video-card-tags">
          {video.tags.map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Locations */}
      {video.locations && video.locations.length > 0 && (
        <div className="locations-section">
          {video.locations.map((loc) => (
            <div key={`${loc.platform}-${loc.external_id}`} className="location-row">
              <span className="location-platform">{loc.platform}</span>
              {loc.external_url ? (
                <a
                  className="location-link"
                  href={loc.external_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {loc.external_id}
                </a>
              ) : (
                <span style={{ fontSize: "0.8rem" }}>{loc.external_id}</span>
              )}
              <span className={`location-role role-${loc.role}`}>{loc.role}</span>
              {loc.status && (
                <span className="location-status">{loc.status}</span>
              )}
              {loc.platform === "YouTube" && loc.role === "Destination" && (
                <button
                  className="btn btn-sm"
                  style={{ padding: "1px 6px", fontSize: "0.7rem" }}
                  onClick={() => checkYouTubeStatus(loc)}
                  disabled={checkingStatus === loc.external_id}
                >
                  {checkingStatus === loc.external_id ? "..." : "Check Status"}
                </button>
              )}
              <button
                className="location-remove"
                onClick={() => removeLocation(loc)}
                title="Remove location"
              >
                x
              </button>
            </div>
          ))}
          {!showLocationForm && (
            <button
              className="btn btn-sm"
              style={{ marginTop: 6 }}
              onClick={() => setShowLocationForm(true)}
            >
              + Location
            </button>
          )}
          {showLocationForm && (
            <div className="location-add-form">
              <select value={locPlatform} onChange={(e) => setLocPlatform(e.target.value)}>
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <input
                placeholder="External ID"
                value={locExternalId}
                onChange={(e) => setLocExternalId(e.target.value)}
              />
              <input
                placeholder="URL (optional)"
                value={locExternalUrl}
                onChange={(e) => setLocExternalUrl(e.target.value)}
              />
              <select value={locRole} onChange={(e) => setLocRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <button className="btn btn-sm btn-primary" onClick={addLocation}>Add</button>
              <button className="btn btn-sm" onClick={() => setShowLocationForm(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* Notes */}
      {(video.notes.length > 0 || showNotes) && (
        <div className="notes-section">
          {video.notes.map((note) => (
            <div key={note.id} className="note">
              {note.text}{" "}
              <span style={{ fontSize: "0.7rem" }}>— {formatDate(note.created_at)}</span>
            </div>
          ))}
          <div className="note-input">
            <input
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addNote()}
              placeholder="Add a note..."
            />
            <button className="btn btn-sm" onClick={addNote}>
              Add
            </button>
          </div>
        </div>
      )}

      <div className="video-card-actions">
        {canApprove && (
          <button className="btn btn-sm btn-green" onClick={approve}>
            Approve
          </button>
        )}
        {canScope && (
          <button className="btn btn-sm btn-primary" onClick={markInScope}>
            In Scope
          </button>
        )}
        {canSkip && (
          <button className="btn btn-sm" onClick={skip}>
            Skip
          </button>
        )}
        {canSkip && (
          <button className="btn btn-sm btn-red" onClick={exclude}>
            Exclude
          </button>
        )}
        {canPublish && !alreadyPublished && (
          <button className="btn btn-sm btn-primary" onClick={requestPublish}>
            Publish
          </button>
        )}
        {canPublish && alreadyPublished && (
          <span style={{ fontSize: "0.8rem", color: "var(--green)", padding: "4px 10px" }}>
            Already published
          </span>
        )}
        {canRetry && (
          <button className="btn btn-sm btn-yellow" onClick={markToRetry}>
            Retry
          </button>
        )}
        {canAbandon && (
          <button className="btn btn-sm" onClick={abandonVideo}>
            Abandon
          </button>
        )}
        {isPublishing && (
          <>
            {uploading ? (
              <span className="upload-progress">{uploadPhase}</span>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={publishToYouTube}>
                Publish to YouTube
              </button>
            )}
            <button className="btn btn-sm btn-red" onClick={markFailed} disabled={uploading}>
              Mark Failed
            </button>
          </>
        )}
        {!showNotes && video.notes.length === 0 && (
          <button className="btn btn-sm" onClick={() => setShowNotes(true)}>
            + Note
          </button>
        )}
        <button
          className="btn btn-sm btn-red"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            if (window.confirm(`Delete "${video.title}"? This cannot be undone.`)) {
              videoStore.remove(video.id);
              onEvent(`VideoDeleted: "${video.title}"`);
              onMutated();
            }
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
