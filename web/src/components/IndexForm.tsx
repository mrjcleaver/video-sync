"use client";

import { useState, FormEvent } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";

const SAMPLE_VIDEOS = [
  {
    source_id: "zoom-weekly-001",
    source_platform: "Zoom",
    title: "Weekly Engineering Standup",
    description: "Monday team standup recording",
    duration_seconds: 1800,
    participants: ["alice@co.com", "bob@co.com"],
    download_url: "https://zoom.us/rec/weekly-001",
    tags: ["standup", "engineering"],
  },
  {
    source_id: "loom-demo-002",
    source_platform: "Loom",
    title: "Product Demo — Q1 Features",
    description: "Walkthrough of new Q1 features for stakeholders",
    duration_seconds: 900,
    participants: ["carol@co.com"],
    download_url: "https://loom.com/share/demo-002",
    tags: ["demo", "product", "q1"],
  },
  {
    source_id: "fireflies-retro-003",
    source_platform: "Fireflies",
    title: "Sprint Retrospective",
    description: "Team retro with action items",
    duration_seconds: 2700,
    participants: ["alice@co.com", "bob@co.com", "dave@co.com"],
    download_url: "https://app.fireflies.ai/retro-003",
    tags: ["retro", "agile"],
  },
];

interface Props {
  onIndexed: () => void;
  onEvent: (event: string) => void;
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

  function loadSamples() {
    for (const sample of SAMPLE_VIDEOS) {
      indexVideo(sample);
    }
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
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-sm" onClick={loadSamples}>
            Load Samples
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Collapse" : "Manual Entry"}
          </button>
        </div>
      </div>

      {expanded && (
        <form onSubmit={handleSubmit} className="form-grid" style={{ marginTop: 12 }}>
          <div>
            <label>Title *</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Video title"
              required
            />
          </div>
          <div>
            <label>Platform</label>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="Zoom">Zoom</option>
              <option value="Loom">Loom</option>
              <option value="Fireflies">Fireflies</option>
            </select>
          </div>
          <div>
            <label>Source ID</label>
            <input
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              placeholder="zoom-abc-123"
            />
          </div>
          <div>
            <label>Duration (seconds)</label>
            <input
              type="number"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
          <div className="full-width">
            <label>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>
          <div>
            <label>Download URL</label>
            <input
              value={downloadUrl}
              onChange={(e) => setDownloadUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div>
            <label>Tags (comma-separated)</label>
            <input
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
