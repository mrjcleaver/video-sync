"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import { videoStore } from "../lib/store";
import {
  type BackfillProfile,
  loadProfiles, saveProfiles,
  loadQueue, saveQueue,
  loadClientState, saveClientState,
  populateQueue, readyQueue, removeFromQueue, markQueueEntryFailed,
  computePublishAttrs,
  statusColor,
  MONTH_NAMES,
} from "../lib/backfill";
import HelpTip from "./HelpTip";
import { setPrivacy, normalisePrivacy } from "../lib/youtubePrivacyCache";
import { resolveDestinations, isAutomatedDestination, destinationLabel } from "../lib/destinationResolver";
import { loadProcessingRules } from "../lib/processingRules";
import { isBulkAutomationEnabled, getAutomationSettings, BULK_DISABLED_HINT } from "../lib/bulkAutomation";
import { getSeriesRegistryCached } from "../lib/seriesRegistryClient";
import { executePublish } from "../lib/publish/execute";
import { withProvenanceFooter, recordProvenanceParts } from "../lib/publish/provenanceFooter";
import { useCurrentActor, actorCommand } from "../lib/useCurrentActor";

const CONNECTIONS_KEY = "video-sync:connections";

/** Short date tag for event log disambiguation — e.g. "(15 Mar)" */
function dateTag(recorded_at: string | null | undefined): string {
  if (!recorded_at) return "";
  const d = new Date(recorded_at);
  return ` (${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })})`;
}

interface Props {
  videos: VideoRecordJSON[];
  onEvent: (event: string, fields?: { video_id?: string }) => void;
  onMutated: () => void;
  onNavigateToVideo?: (id: string, intent?: "publish") => void;
}

function loadYouTubeCreds(): { refreshToken?: string; clientId?: string; clientSecret?: string } {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    const conn = raw ? JSON.parse(raw) : {};
    return conn["YouTube"]?.credentials ?? {};
  } catch { return {}; }
}

function loadZoomCreds(): { accountId?: string; clientId?: string; clientSecret?: string } {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    const conn = raw ? JSON.parse(raw) : {};
    const z = conn["Zoom"]?.credentials ?? {};
    return { accountId: z.accountId, clientId: z.clientId, clientSecret: z.clientSecret };
  } catch { return {}; }
}

function loadFirefliesCreds(): { apiKey?: string } {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    const conn = raw ? JSON.parse(raw) : {};
    return { apiKey: conn["Fireflies"]?.credentials?.apiKey };
  } catch { return {}; }
}

function newProfile(): BackfillProfile {
  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: true,
    source_platforms: ["Zoom"],
    date_from: yearAgo,
    date_to: today,
    criteria: { days_of_week: [4, 5], min_duration_minutes: 20 },
    default_privacy: "unlisted",
    max_uploads_per_day: 5,
    upload_window_start_hour: 2,
  };
}

export default function BackfillPanel({ videos, onEvent, onMutated, onNavigateToVideo }: Props) {
  const actorState = useCurrentActor();
  const cmd = (extra?: Record<string, unknown>) => actorCommand(actorState, extra);
  const [profiles, setProfilesState] = useState<BackfillProfile[]>([]);
  const [queue, setQueueState] = useState(loadQueue());
  const [clientState, setClientStateValue] = useState(loadClientState());
  const [serverState, setServerState] = useState<{ uploads_today: number; last_reset_date: string } | null>(null);
  const [editing, setEditing] = useState<BackfillProfile | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"profiles" | "queue">("queue");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setProfilesState(loadProfiles());
    refreshServerState();
  }, []);

  function refreshServerState() {
    fetch("/api/backfill/state")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setServerState(d); })
      .catch(() => {});
  }

  function saveAndSet(p: BackfillProfile[]) {
    saveProfiles(p);
    setProfilesState(p);
  }

  function handlePopulate() {
    const added = populateQueue(videos, profiles);
    const q = loadQueue();
    saveQueue(q);
    setQueueState([...q]);
    onEvent(`Backfill: added ${added} video(s) to queue`);
    setStatus(`${added} videos added to queue`);
  }

  const runTick = useCallback(async () => {
    const q = loadQueue();
    const ready = readyQueue(q);
    if (ready.length === 0) {
      setStatus("Queue empty — nothing to upload");
      stopOrchestrator();
      return;
    }

    const activeProfiles = loadProfiles().filter(p => p.enabled);
    if (activeProfiles.length === 0) {
      setStatus("No enabled profiles");
      return;
    }

    // Pick the first active profile's quota settings (use profile matched to queue entry)
    const firstEntry = ready[0];
    const profile = activeProfiles.find(p => p.id === firstEntry.profile_id) ?? activeProfiles[0];

    // Call server tick to check quota
    let tickRes: { can_upload: boolean; next_id: string | null; uploads_today: number; quota_limit: number; window_open: boolean; reason?: string };
    try {
      const res = await fetch("/api/backfill/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_uploads_per_day: profile.max_uploads_per_day,
          window_start_hour: profile.upload_window_start_hour ?? 0,
          queue: ready.map(e => e.video_id),
        }),
      });
      tickRes = await res.json();
    } catch {
      setStatus("Tick request failed — retrying later");
      return;
    }

    setServerState({ uploads_today: tickRes.uploads_today, last_reset_date: new Date().toISOString().slice(0, 10) });

    if (!tickRes.can_upload) {
      setStatus(tickRes.reason ?? "Cannot upload");
      if (!tickRes.window_open) return; // just wait for window
      if (tickRes.uploads_today >= tickRes.quota_limit) stopOrchestrator(); // quota hit
      return;
    }

    if (!isBulkAutomationEnabled()) {
      // Flipped off mid-run — stop at this boundary rather than finishing
      // the queue.
      setStatus(BULK_DISABLED_HINT);
      stopOrchestrator();
      return;
    }

    const videoId = tickRes.next_id!;
    const video = videos.find(v => v.id === videoId);
    if (!video) {
      removeFromQueue(videoId);
      setQueueState(loadQueue());
      return;
    }

    const ytCreds = loadYouTubeCreds();
    if (!ytCreds.refreshToken || !ytCreds.clientId || !ytCreds.clientSecret) {
      setStatus("YouTube credentials not configured");
      stopOrchestrator();
      return;
    }

    const attrs = computePublishAttrs(video, profile);
    setStatus(`Uploading: "${video.title}"…`);

    // Mark as publishing
    try {
      videoStore.mutate(videoId, r => r.request_publish(cmd()));
      onMutated();
      onNavigateToVideo?.(videoId, "publish");
    } catch { /* may already be in Publishing */ }

    // ADR-077 §3 — resolve the destinations this record's series declares
    // and push each through the shared executor, instead of posting
    // straight to YouTube.
    //
    // This also fixes a broken path: /api/youtube/upload always responds
    // text/event-stream, so the `await res.json()` this replaced could
    // never parse a successful upload. Every bulk publish threw and marked
    // the record Failed even when the video had gone up.
    const destinations = resolveDestinations(
      video,
      getSeriesRegistryCached(),
      loadProcessingRules(),
      profile,
    ).destinations.filter(isAutomatedDestination);

    if (destinations.length === 0) {
      setStatus(`Skipped "${video.title}" — no automated destination declared`);
      onEvent(`Backfill: skipped "${video.title}"${dateTag(video.recorded_at)} — its series declares no automated destination`, { video_id: videoId });
      removeFromQueue(videoId);
      setQueueState(loadQueue());
      return;
    }

    try {
      const report = await executePublish({
        record: video,
        destinations,
        attrsFor: (spec) => ({
          title: attrs.title ?? video.title,
          description: withProvenanceFooter(
            attrs.description ?? video.description,
            recordProvenanceParts(video),
            spec.platform,
          ),
          tags: attrs.tags ?? video.tags ?? [],
          visibility: spec.platform === "YouTube"
            ? (attrs.privacy_status ?? profile.default_privacy)
            : spec.platform === "Kaltura" ? spec.visibility : undefined,
        }),
        sourceUrlFor: () => video.download_url,
        creds: {
          source: {
            ...(video.download_url?.startsWith("zoom://") ? (() => {
              const z = loadZoomCreds();
              return { zoomAccountId: z.accountId, zoomClientId: z.clientId, zoomClientSecret: z.clientSecret };
            })() : {}),
            ...(video.download_url?.startsWith("fireflies://")
              ? { firefliesApiKey: loadFirefliesCreds().apiKey }
              : {}),
          },
          youtube: {
            refreshToken: ytCreds.refreshToken,
            clientId: ytCreds.clientId,
            clientSecret: ytCreds.clientSecret,
          },
        },
        onPhase: (phase) => setStatus(`"${video.title}": ${phase}`),
        onOutcome: (outcome) => {
          if (outcome.status !== "pushed") {
            onEvent(`Backfill: ${destinationLabel(outcome.spec)} failed for "${video.title}"${dateTag(video.recorded_at)} — ${outcome.error ?? outcome.skipReason}`, { video_id: videoId });
            return;
          }
          videoStore.mutate(videoId, r => r.recordDestinationResult(cmd({
            platform: outcome.spec.platform,
            external_id: outcome.external_id,
            external_url: outcome.external_url,
          })));
        },
      });

      if (!report.anyPushed) {
        throw new Error(report.results.map(r => `${destinationLabel(r.spec)}: ${r.error ?? r.skipReason}`).join("; "));
      }

      const ytOutcome = report.results.find(r => r.spec.platform === "YouTube" && r.status === "pushed");
      const ytId = ytOutcome?.external_id ?? "";
      const videoUrl = report.results.find(r => r.status === "pushed")?.external_url ?? "";

      // Cache privacy — we know what we uploaded with
      setPrivacy(ytId, normalisePrivacy(attrs.privacy_status ?? profile.default_privacy));
      onMutated();

      removeFromQueue(videoId);
      setQueueState(loadQueue());

      // Increment server quota counter
      await fetch("/api/backfill/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ increment: true }),
      }).then(r => r.ok ? r.json() : null).then(d => { if (d) setServerState(d); }).catch(() => {});

      // Update client state
      const cs = loadClientState();
      const today = new Date().toISOString().slice(0, 10);
      const newUploadsToday = cs.last_reset_date === today ? cs.uploads_today + 1 : 1;
      const newCs = { uploads_today: newUploadsToday, last_reset_date: today };
      saveClientState(newCs);
      setClientStateValue(newCs);

      onEvent(`Backfill: published "${video.title}"${dateTag(video.recorded_at)} → ${videoUrl}`, { video_id: videoId });
      setStatus(`Published "${video.title}"`);
    } catch (err) {
      videoStore.mutate(videoId, r => r.mark_failed(cmd({ reason: String(err) })));
      onMutated();
      markQueueEntryFailed(videoId, 1);
      setQueueState(loadQueue());
      onEvent(`Backfill: upload failed for "${video.title}"${dateTag(video.recorded_at)} — ${String(err)}`, { video_id: videoId });
      setStatus(`Failed: ${String(err).slice(0, 80)}`);
    }
  }, [videos, onEvent, onMutated]);

  function startOrchestrator() {
    // Bulk automation kill switch. This orchestrator publishes videos
    // unattended on a timer, so it is the single most consequential thing
    // the switch gates.
    if (!isBulkAutomationEnabled()) {
      setStatus(BULK_DISABLED_HINT);
      return;
    }
    setRunning(true);
    runTick();
    intervalRef.current = setInterval(runTick, 5 * 60 * 1000); // 5 min
  }

  function stopOrchestrator() {
    setRunning(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
  }

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  // Warm the kill-switch cache; the sync accessor reads disabled until it
  // resolves, so Start stays unavailable for the first moment after load.
  const [bulkEnabled, setBulkEnabled] = useState(false);
  useEffect(() => {
    void getAutomationSettings().then(s => setBulkEnabled(s.bulk_enabled));
  }, []);

  const readyEntries = readyQueue(queue);
  const uploadsToday = serverState?.uploads_today ?? clientState.uploads_today;

  return (
    <div className="zoom-import">
      <div className="zoom-import-header">
        <h2>Backfill Uploader</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {status && <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status}</span>}
          {serverState && (
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              {uploadsToday} / {profiles[0]?.max_uploads_per_day ?? "?"} today
            </span>
          )}
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {readyEntries.length} queued
          </span>
          <button className="btn btn-sm" onClick={onMutated} title="Refresh video data">
            ↻
          </button>
          {/* Stop is never blocked — an operator must always be able to halt
              a run in progress, whatever the kill switch says. */}
          <button
            className={`btn btn-sm ${running ? "btn-primary" : "btn-green"}`}
            onClick={running ? stopOrchestrator : startOrchestrator}
            disabled={
              running
                ? false
                : profiles.filter(p => p.enabled).length === 0 || !bulkEnabled
            }
            title={
              !running && !bulkEnabled
                ? BULK_DISABLED_HINT
                : running ? "Stop the timed orchestrator" : "Begin the timed orchestrator"
            }
          >
            {running ? "⏹ Stop" : "▶ Start"}
          </button>
          {!bulkEnabled && (
            <span
              style={{ fontSize: "0.7rem", color: "var(--yellow)" }}
              title={BULK_DISABLED_HINT}
            >
              automation off
            </span>
          )}
        </div>
      </div>

      <HelpTip>
        Bulk-upload historical recordings to YouTube on a quota-safe schedule.{" "}
        <strong>Profiles</strong> define which recordings qualify (platform, date range, day of
        week, duration, title pattern) and set the upload pace (max uploads/day, upload window).{" "}
        <strong>Queue</strong> shows videos pending upload with their transformed titles,
        descriptions, tags, and privacy — computed by your Processing Rules. Click{" "}
        <em>Auto-populate</em> to fill the queue from Approved videos, then{" "}
        <em>▶ Start</em> to begin the timed orchestrator. Coverage and per-video status
        live in the <strong>Sync Status</strong> panel above.
      </HelpTip>

      <div className="filter-tabs" style={{ marginBottom: 12 }}>
        {(["profiles", "queue"] as const).map(t => (
          <button key={t} className={`filter-tab ${activeTab === t ? "active" : ""}`} onClick={() => setActiveTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === "queue" && readyEntries.length > 0 ? ` (${readyEntries.length})` : ""}
          </button>
        ))}
      </div>

      {activeTab === "profiles" && (
        <ProfilesTab
          profiles={profiles}
          editing={editing}
          onSave={(p) => {
            const idx = profiles.findIndex(x => x.id === p.id);
            const updated = idx >= 0
              ? profiles.map((x, i) => i === idx ? p : x)
              : [...profiles, p];
            saveAndSet(updated);
            setEditing(null);
          }}
          onEdit={setEditing}
          onDelete={(id) => saveAndSet(profiles.filter(p => p.id !== id))}
          onNew={() => setEditing(newProfile())}
          onCancel={() => setEditing(null)}
        />
      )}

      {activeTab === "queue" && (
        <QueueTab
          videos={videos}
          queue={queue}
          profiles={profiles}
          readyEntries={readyEntries}
          onPopulate={handlePopulate}
          onClearQueue={() => {
            saveQueue([]);
            setQueueState([]);
            onEvent("Backfill: queue cleared");
          }}
        />
      )}
    </div>
  );
}

// ── Profiles Tab ──────────────────────────────────────────────────────────────

interface ProfilesTabProps {
  profiles: BackfillProfile[];
  editing: BackfillProfile | null;
  onSave: (p: BackfillProfile) => void;
  onEdit: (p: BackfillProfile) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onCancel: () => void;
}

const ALL_PLATFORMS = ["Zoom", "Fireflies", "Loom"];

function ProfilesTab({ profiles, editing, onSave, onEdit, onDelete, onNew, onCancel }: ProfilesTabProps) {
  if (editing) {
    return <ProfileEditor profile={editing} onSave={onSave} onCancel={onCancel} />;
  }

  return (
    <div>
      {profiles.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: 12 }}>
          No profiles yet. A profile defines which recordings to backfill and at what pace.
        </div>
      )}
      {profiles.map(p => (
        <div key={p.id} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
              {p.name || "(unnamed)"}
              {!p.enabled && <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 6 }}>(disabled)</span>}
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2 }}>
              {p.source_platforms.join(", ")} · {p.date_from} to {p.date_to ?? "today"} · {p.max_uploads_per_day}/day · {p.default_privacy}
            </div>
            {p.criteria.days_of_week && (
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                Days: {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].filter((_, i) => p.criteria.days_of_week!.includes(i)).join(", ")}
                {p.criteria.min_duration_minutes && ` · ≥${fmtDuration(p.criteria.min_duration_minutes * 60)}`}
                {p.criteria.max_duration_minutes && ` · ≤${fmtDuration(p.criteria.max_duration_minutes * 60)}`}
                {p.criteria.title_pattern && ` · title~/${p.criteria.title_pattern}/`}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-sm" onClick={() => onEdit(p)}>Edit</button>
            <button className="btn btn-sm" style={{ color: "var(--red)" }} onClick={() => onDelete(p.id)}>Delete</button>
          </div>
        </div>
      ))}
      <button className="btn btn-sm btn-primary" onClick={onNew} style={{ marginTop: 4 }}>+ New Profile</button>
    </div>
  );
}

// ── Profile Editor ────────────────────────────────────────────────────────────

function ProfileEditor({ profile, onSave, onCancel }: { profile: BackfillProfile; onSave: (p: BackfillProfile) => void; onCancel: () => void }) {
  const [form, setForm] = useState<BackfillProfile>({ ...profile, criteria: { ...profile.criteria, days_of_week: [...(profile.criteria.days_of_week ?? [])] } });

  function set<K extends keyof BackfillProfile>(key: K, value: BackfillProfile[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function setCriteria<K extends keyof BackfillProfile["criteria"]>(key: K, value: BackfillProfile["criteria"][K]) {
    setForm(f => ({ ...f, criteria: { ...f.criteria, [key]: value } }));
  }

  function togglePlatform(p: string) {
    setForm(f => ({
      ...f,
      source_platforms: f.source_platforms.includes(p)
        ? f.source_platforms.filter(x => x !== p)
        : [...f.source_platforms, p],
    }));
  }

  function toggleDay(d: number) {
    const days = form.criteria.days_of_week ?? [];
    setCriteria("days_of_week", days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort());
  }

  const inputStyle = { padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: "0.8rem" }}>Name</label>
        <input value={form.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Live Vibe Coding" style={{ ...inputStyle, flex: "1 1 180px" }} />
        <label style={{ fontSize: "0.8rem" }}>
          <input type="checkbox" checked={form.enabled} onChange={e => set("enabled", e.target.checked)} style={{ marginRight: 4 }} />
          Enabled
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: "0.8rem" }}>Platforms:</span>
        {ALL_PLATFORMS.map(p => (
          <button key={p} className={`btn btn-sm ${form.source_platforms.includes(p) ? "btn-primary" : ""}`} style={{ padding: "2px 8px", fontSize: "0.75rem" }} onClick={() => togglePlatform(p)}>{p}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: "0.8rem" }}>Date from</label>
        <input type="date" value={form.date_from} onChange={e => set("date_from", e.target.value)} style={inputStyle} />
        <label style={{ fontSize: "0.8rem" }}>to</label>
        <input type="date" value={form.date_to ?? ""} onChange={e => set("date_to", e.target.value || undefined)} style={inputStyle} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: "0.8rem" }}>Target days:</span>
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d, i) => (
          <button key={d} className={`btn btn-sm ${(form.criteria.days_of_week ?? []).includes(i) ? "btn-primary" : ""}`} style={{ padding: "2px 6px", fontSize: "0.7rem" }} onClick={() => toggleDay(i)}>{d}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: "0.8rem" }}>Min duration (min)</label>
        <input type="number" value={form.criteria.min_duration_minutes ?? ""} onChange={e => setCriteria("min_duration_minutes", e.target.value ? Number(e.target.value) : undefined)} style={{ ...inputStyle, width: 70 }} />
        <label style={{ fontSize: "0.8rem" }}>Max</label>
        <input type="number" value={form.criteria.max_duration_minutes ?? ""} onChange={e => setCriteria("max_duration_minutes", e.target.value ? Number(e.target.value) : undefined)} style={{ ...inputStyle, width: 70 }} />
        <label style={{ fontSize: "0.8rem" }}>Title regex</label>
        <input value={form.criteria.title_pattern ?? ""} onChange={e => setCriteria("title_pattern", e.target.value || undefined)} placeholder="e.g. Vibe Coding" style={{ ...inputStyle, flex: "1 1 140px" }} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: "0.8rem" }}>Default privacy</label>
        <select value={form.default_privacy} onChange={e => set("default_privacy", e.target.value as BackfillProfile["default_privacy"])} style={inputStyle}>
          <option value="private">private</option>
          <option value="unlisted">unlisted</option>
          <option value="public">public</option>
        </select>
        <label style={{ fontSize: "0.8rem" }}>Max uploads/day</label>
        <input type="number" min={1} max={50} value={form.max_uploads_per_day} onChange={e => set("max_uploads_per_day", Number(e.target.value))} style={{ ...inputStyle, width: 60 }} />
        <label style={{ fontSize: "0.8rem" }}>Window start (UTC hour)</label>
        <input type="number" min={0} max={23} value={form.upload_window_start_hour} onChange={e => set("upload_window_start_hour", Number(e.target.value))} style={{ ...inputStyle, width: 50 }} />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={() => onSave(form)}>Save Profile</button>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Queue Tab ─────────────────────────────────────────────────────────────────

interface QueueTabProps {
  videos: VideoRecordJSON[];
  queue: ReturnType<typeof loadQueue>;
  profiles: BackfillProfile[];
  readyEntries: ReturnType<typeof readyQueue>;
  onPopulate: () => void;
  onClearQueue: () => void;
}

const PRIVACY_COLOR: Record<string, string> = {
  public: "var(--green)",
  unlisted: "#fbbf24",
  private: "var(--red)",
};

function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function fmtMins(s: number): string {
  return `${Math.floor(s / 60)} min`;
}

function QueueTab({ videos, queue, profiles, readyEntries, onPopulate, onClearQueue }: QueueTabProps) {
  /** ADR-077 §3 — resolve each queued record's declared destinations once
   *  so the queue can show the split before a run starts. Registry and
   *  rules are read once, not per record. */
  const destinationPreflight = useMemo(() => {
    const registry = getSeriesRegistryCached();
    const rules = loadProcessingRules();
    const tally = new Map<string, number>();
    let none = 0;
    for (const entry of readyEntries) {
      const video = videos.find(v => v.id === entry.video_id);
      if (!video) continue;
      const profile = profiles.find(p => p.id === entry.profile_id) ?? profiles[0] ?? null;
      const dests = resolveDestinations(video, registry, rules, profile)
        .destinations.filter(isAutomatedDestination);
      if (dests.length === 0) { none++; continue; }
      for (const d of dests) {
        const label = destinationLabel(d);
        tally.set(label, (tally.get(label) ?? 0) + 1);
      }
    }
    return {
      counts: [...tally.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
      none,
      total: readyEntries.length,
    };
  }, [videos, queue, profiles, readyEntries]);

  const videoMap = new Map(videos.map(v => [v.id, v]));
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <button className="btn btn-sm btn-primary" onClick={onPopulate}>
          Auto-populate from Approved videos
        </button>
        {queue.length > 0 && (
          <button className="btn btn-sm" style={{ color: "var(--red)" }} onClick={onClearQueue}>
            Clear Queue
          </button>
        )}
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {readyEntries.length} ready · {queue.length - readyEntries.length} deferred
        </span>
      </div>

      {/* ADR-075 §Batch publish / ADR-077 §3 — per-destination pre-flight, so
          an operator can gut-check "150 → YouTube, 82 → Kaltura" before
          starting the orchestrator rather than discovering the split
          afterwards. */}
      {destinationPreflight.total > 0 && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span>Will publish to:</span>
          {destinationPreflight.counts.map(({ label, count }: { label: string; count: number }) => (
            <span key={label} style={{ color: "var(--text)" }}>
              {count} → {label}
            </span>
          ))}
          {destinationPreflight.none > 0 && (
            <span
              style={{ color: "var(--yellow)" }}
              title="These records' series declare no automated destination, so the orchestrator will skip them."
            >
              {destinationPreflight.none} with no destination
            </span>
          )}
        </div>
      )}

      {queue.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
          Queue is empty. Click "Auto-populate" to add all Approved videos matching your profiles.
        </div>
      )}

      <div style={{ maxHeight: 480, overflowY: "auto" }}>
        {queue.map(entry => {
          const v = videoMap.get(entry.video_id);
          const profile = profiles.find(p => p.id === entry.profile_id);
          const isDeferred = entry.retry_after && entry.retry_after > new Date().toISOString();
          const isExpanded = expanded === entry.video_id;

          // Compute transformed publish attributes (synchronous, uses processing rules)
          const attrs = v && profile ? computePublishAttrs(v, profile) : null;
          const titleChanged = attrs && v && attrs.title !== v.title;
          const hasTranscript = !!(v?.transcript_text);
          const hasDescription = !!(attrs?.description);

          return (
            <div key={entry.video_id} style={{
              borderRadius: 6, marginBottom: 6,
              background: "var(--bg-card)", border: "1px solid var(--border)",
              opacity: isDeferred ? 0.6 : 1,
              overflow: "hidden",
            }}>
              {/* Header row */}
              <div
                style={{ padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 8 }}
                onClick={() => setExpanded(isExpanded ? null : entry.video_id)}
              >
                <span style={{ color: statusColor(v?.status), flexShrink: 0, marginTop: 2 }}>●</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Transformed title (primary) */}
                  <div style={{ fontSize: "0.85rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {attrs?.title ?? v?.title ?? entry.video_id}
                  </div>
                  {/* Original title if it differs */}
                  {titleChanged && (
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontStyle: "italic", marginTop: 1 }}>
                      was: {v!.title}
                    </div>
                  )}
                  {/* Meta row */}
                  <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                    {v && <span title={fmtMins(v.duration_seconds)} style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{fmtDuration(v.duration_seconds)}</span>}
                    {v && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{v.source_platform}</span>}
                    {v?.recorded_at && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{v.recorded_at.slice(0, 10)}</span>}
                    {attrs && (
                      <span style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: 10, border: `1px solid ${PRIVACY_COLOR[attrs.privacy_status]}`, color: PRIVACY_COLOR[attrs.privacy_status] }}>
                        {attrs.privacy_status}
                      </span>
                    )}
                    {hasTranscript && (
                      <span style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: 10, background: "rgba(56,189,248,0.12)", color: "#38bdf8" }}>
                        transcript
                      </span>
                    )}
                    {profile && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>profile: {profile.name || "(unnamed)"}</span>}
                    {entry.attempts > 0 && <span style={{ fontSize: "0.7rem", color: "var(--red)" }}>attempt {entry.attempts}</span>}
                    {isDeferred && <span style={{ fontSize: "0.7rem", color: "#f97316" }}>retry {entry.retry_after?.slice(0, 10)}</span>}
                    <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginLeft: "auto" }}>{isExpanded ? "▲" : "▼"}</span>
                  </div>
                </div>
              </div>

              {/* Expanded detail panel */}
              {isExpanded && attrs && (
                <div style={{ padding: "0 12px 12px 32px", borderTop: "1px solid var(--border)" }}>
                  {/* Description */}
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.05em" }}>Description</div>
                    {hasDescription ? (
                      <div style={{ fontSize: "0.78rem", color: "var(--text)", whiteSpace: "pre-wrap", maxHeight: 100, overflowY: "auto" }}>
                        {attrs.description}
                      </div>
                    ) : (
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontStyle: "italic" }}>No description</div>
                    )}
                  </div>

                  {/* Tags */}
                  {attrs.tags.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Tags</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {attrs.tags.map(tag => (
                          <span key={tag} style={{ fontSize: "0.68rem", padding: "1px 7px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)" }}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Transcript snippet */}
                  {hasTranscript && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.05em" }}>Transcript snippet</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontStyle: "italic", maxHeight: 60, overflowY: "auto" }}>
                        {v!.transcript_text!.slice(0, 300)}{v!.transcript_text!.length > 300 ? "…" : ""}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
