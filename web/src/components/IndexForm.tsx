"use client";

import { useState, FormEvent } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import HelpTip from "./HelpTip";


interface Props {
  onIndexed: () => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
}

export default function IndexForm({ onIndexed, onEvent }: Props) {
  const [title, setTitle] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [platform, setPlatform] = useState("Zoom");
  const [description, setDescription] = useState("");
  const [duration, setDuration] = useState("1800");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [tags, setTags] = useState("");
  const [expanded, setExpanded] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    indexVideo({
      source_id: sourceId || `manual-${Date.now()}`,
      source_platform: platform,
      title,
      description: description || undefined,
      duration_seconds: parseInt(duration) || 0,
      participants: [],
      download_url: downloadUrl || `https://example.com/${Date.now()}`,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
  }

  function indexVideo(cmd: Record<string, unknown>) {
    const record = new WasmVideoRecord(JSON.stringify(cmd));
    videoStore.add(record);
    onEvent(`VideoIndexed: "${cmd.title}" (${record.id()})`);
    onIndexed();
    // reset form
    setTitle("");
    setSourceId("");
    setDescription("");
    setDuration("1800");
    setDownloadUrl("");
    setTags("");
  }

  return (
    <div className="index-form">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2>Index new video</h2>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={expanded ? "manual-video-form" : undefined}
        >
          {expanded ? "Collapse" : "Manual entry"}
        </button>
      </div>

      <HelpTip>
        Manually index a single video into the pipeline. Use this to add recordings that aren&apos;t
        available via Zoom or Fireflies. Paste any URL, assign a platform, and tag the entry.
        Indexed videos immediately appear in the library and can be approved, processed, and
        uploaded to YouTube through the normal workflow.
      </HelpTip>

      {expanded && (
        <form id="manual-video-form" onSubmit={handleSubmit} className="form-grid" style={{ marginTop: 16 }}>
          <div>
            <label htmlFor="manual-video-title">Title *</label>
            <input
              id="manual-video-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Video title"
              required
            />
          </div>
          <div>
            <label htmlFor="manual-video-platform">Platform</label>
            <select id="manual-video-platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="Zoom">Zoom</option>
              <option value="Loom">Loom</option>
              <option value="Fireflies">Fireflies</option>
            </select>
          </div>
          <div>
            <label htmlFor="manual-video-source-id">Source ID</label>
            <input
              id="manual-video-source-id"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              placeholder="zoom-abc-123"
            />
          </div>
          <div>
            <label htmlFor="manual-video-duration">Duration (seconds)</label>
            <input
              id="manual-video-duration"
              type="number"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
          <div className="full-width">
            <label htmlFor="manual-video-description">Description</label>
            <textarea
              id="manual-video-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>
          <div>
            <label htmlFor="manual-video-download-url">Download URL</label>
            <input
              id="manual-video-download-url"
              value={downloadUrl}
              onChange={(e) => setDownloadUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div>
            <label htmlFor="manual-video-tags">Tags (comma-separated)</label>
            <input
              id="manual-video-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="standup, engineering"
            />
          </div>
          <div className="full-width">
            <button type="submit" className="btn btn-primary">
              Index video
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
