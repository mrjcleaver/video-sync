"use client";

import { useState, useId, FormEvent } from "react";
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

  const idPrefix = useId();

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
        <h2>Index New Video</h2>
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Collapse" : "Manual Entry"}
        </button>
      </div>

      <HelpTip>
        Manually index a single video into the pipeline. Use this to add recordings that aren&apos;t
        available via Zoom or Fireflies — paste any URL, assign a platform, and tag the entry.
        Indexed videos immediately appear in the library and can be approved, processed, and
        uploaded to YouTube through the normal workflow.
      </HelpTip>

      {expanded && (
        <form onSubmit={handleSubmit} className="form-grid" style={{ marginTop: 12 }}>
          <div>
            <label htmlFor={`${idPrefix}-title`}>Title *</label>
            <input
              id={`${idPrefix}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Video title"
              required
            />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-platform`}>Platform</label>
            <select id={`${idPrefix}-platform`} value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="Zoom">Zoom</option>
              <option value="Loom">Loom</option>
              <option value="Fireflies">Fireflies</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-source`}>Source ID</label>
            <input
              id={`${idPrefix}-source`}
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              placeholder="zoom-abc-123"
            />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-duration`}>Duration (seconds)</label>
            <input
              id={`${idPrefix}-duration`}
              type="number"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
          <div className="full-width">
            <label htmlFor={`${idPrefix}-description`}>Description</label>
            <textarea
              id={`${idPrefix}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-url`}>Download URL</label>
            <input
              id={`${idPrefix}-url`}
              value={downloadUrl}
              onChange={(e) => setDownloadUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-tags`}>Tags (comma-separated)</label>
            <input
              id={`${idPrefix}-tags`}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="standup, engineering"
            />
          </div>
          <div className="full-width">
            <button type="submit" className="btn btn-primary">
              Index Video
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
