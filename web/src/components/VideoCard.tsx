"use client";

import { useState } from "react";
import type { VideoRecordJSON, PlatformLocationJSON } from "../lib/wasm";
import { videoStore } from "../lib/store";

const PLATFORMS = ["Zoom", "Loom", "Fireflies", "YouTube", "Kaltura"] as const;
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
  const [locPlatform, setLocPlatform] = useState<string>("Loom");
  const [locExternalId, setLocExternalId] = useState("");
  const [locExternalUrl, setLocExternalUrl] = useState("");
  const [locRole, setLocRole] = useState<string>("Intermediate");

  function approve() {
    videoStore.mutate(video.id, (r) =>
      r.approve(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) }))
    );
    onEvent(`VideoApproved: "${video.title}"`);
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

  function requestPublish() {
    videoStore.mutate(video.id, (r) =>
      r.request_publish(JSON.stringify({ actor: JSON.parse(ADMIN_ACTOR) }))
    );
    onEvent(`StatusChanged: "${video.title}" -> Publishing`);
    onMutated();
  }

  function markPublished() {
    videoStore.mutate(video.id, (r) =>
      r.mark_published(
        JSON.stringify({
          destination_id: `yt-${Date.now()}`,
          destination_url: `https://youtube.com/watch?v=${Date.now()}`,
        })
      )
    );
    onEvent(`StatusChanged: "${video.title}" -> Published`);
    onMutated();
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
  const canApprove = status === "Discovered" || status === "Failed";
  const canSkip = status === "Discovered";
  const canPublish = status === "Approved";
  const isPublishing = status === "Publishing";

  return (
    <div className="video-card">
      <div className="video-card-header">
        <h3>{video.title}</h3>
        <span className={`status-badge status-${status}`}>{status}</span>
      </div>

      <div className="video-card-meta">
        <span>{video.source_platform}</span>
        <span>{formatDuration(video.duration_seconds)}</span>
        <span>{formatDate(video.indexed_at)}</span>
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
        {canSkip && (
          <button className="btn btn-sm" onClick={skip}>
            Skip
          </button>
        )}
        {canPublish && (
          <button className="btn btn-sm btn-primary" onClick={requestPublish}>
            Publish
          </button>
        )}
        {isPublishing && (
          <>
            <button className="btn btn-sm btn-green" onClick={markPublished}>
              Mark Published
            </button>
            <button className="btn btn-sm btn-red" onClick={markFailed}>
              Mark Failed
            </button>
          </>
        )}
        {!showNotes && video.notes.length === 0 && (
          <button className="btn btn-sm" onClick={() => setShowNotes(true)}>
            + Note
          </button>
        )}
      </div>
    </div>
  );
}
