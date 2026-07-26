"use client";

import { useMemo } from "react";
import type { VideoRecordJSON } from "../lib/wasm";
import {
  buildProvenance,
  type ProvenanceSession,
  type GraphNode,
  type RealNode,
  type DestinationNode,
  platformLabel,
} from "../lib/provenanceLinker";

interface Props {
  videos: VideoRecordJSON[];
  /** If provided, only show sessions containing this record ID */
  focusId?: string;
  onJumpTo?: (id: string) => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge status-${status}`} style={{ fontSize: "0.65rem", padding: "1px 6px" }}>
      {status}
    </span>
  );
}

function RealNodeCard({
  node,
  onJumpTo,
}: {
  node: RealNode;
  onJumpTo?: (id: string) => void;
}) {
  const r = node.record;
  const title = r.title.length > 45 ? r.title.slice(0, 44) + "…" : r.title;
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        minWidth: 180,
        maxWidth: 220,
        cursor: onJumpTo ? "pointer" : "default",
      }}
      onClick={() => onJumpTo?.(r.id)}
      title={onJumpTo ? "Click to jump to card" : undefined}
    >
      <div style={{ fontSize: "0.65rem", color: "var(--accent)", fontWeight: 600, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {platformLabel(r.source_platform)}
      </div>
      <div style={{ fontSize: "0.78rem", fontWeight: 500, lineHeight: 1.3, marginBottom: 4 }}>
        {title}
      </div>
      <StatusBadge status={r.status} />
    </div>
  );
}

function PhantomNodeCard({ node }: { node: Extract<GraphNode, { kind: "phantom" }> }) {
  return (
    <div
      style={{
        background: "transparent",
        border: "1.5px dashed var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        minWidth: 180,
        maxWidth: 220,
        opacity: 0.7,
      }}
    >
      <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontWeight: 600, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {platformLabel(node.platform)} (not in catalog)
      </div>
      <div style={{ fontSize: "0.75rem", fontFamily: "monospace", color: "var(--text-muted)", wordBreak: "break-all" }}>
        {node.external_id}
      </div>
      {node.account_hint && (
        <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>{node.account_hint}</div>
      )}
    </div>
  );
}

function DestCard({ dest }: { dest: DestinationNode }) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        minWidth: 160,
        maxWidth: 200,
      }}
    >
      <div style={{ fontSize: "0.65rem", color: "var(--green)", fontWeight: 600, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {platformLabel(dest.platform)}
      </div>
      {dest.external_url ? (
        <a
          href={dest.external_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: "0.72rem", color: "var(--accent)", wordBreak: "break-all" }}
          onClick={(e) => e.stopPropagation()}
        >
          {dest.external_id}
        </a>
      ) : (
        <div style={{ fontSize: "0.72rem", fontFamily: "monospace", wordBreak: "break-all" }}>{dest.external_id}</div>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      padding: "0 8px",
      color: "var(--text-muted)",
      fontSize: "1.2rem",
      alignSelf: "center",
      flexShrink: 0,
    }}>
      →
    </div>
  );
}

/**
 * Renders a RealNodeCard for the parent record, then, if it has any
 * OpusClip derivatives, nests them as compact rows below with a
 * "✂️ N clip(s)" summary + indented list. Keeps the columnar graph
 * layout while giving clips a legible home per parent.
 */
function NodeWithClips({
  node,
  clips,
  onJumpTo,
}: {
  node: RealNode;
  clips: Array<{ parentId: string; clip: RealNode }>;
  onJumpTo?: (id: string) => void;
}) {
  if (clips.length === 0) return <RealNodeCard node={node} onJumpTo={onJumpTo} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <RealNodeCard node={node} onJumpTo={onJumpTo} />
      <div style={{
        marginLeft: 16, paddingLeft: 8,
        borderLeft: "2px solid rgba(20,184,166,0.35)",
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        <div style={{ fontSize: "0.62rem", color: "rgb(94,234,212)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          ✂️ {clips.length} clip{clips.length === 1 ? "" : "s"}
        </div>
        {clips.map(({ clip }, i) => {
          const title = clip.record.title.length > 40 ? clip.record.title.slice(0, 39) + "…" : clip.record.title;
          return (
            <div
              key={i}
              onClick={() => onJumpTo?.(clip.record.id)}
              title={onJumpTo ? "Click to jump to card" : undefined}
              style={{
                background: "rgba(20,184,166,0.08)",
                border: "1px solid rgba(20,184,166,0.25)",
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: "0.72rem",
                cursor: onJumpTo ? "pointer" : "default",
                lineHeight: 1.3,
                minWidth: 160,
              }}
            >
              {title}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  onJumpTo,
}: {
  session: ProvenanceSession;
  onJumpTo?: (id: string) => void;
}) {
  const hasOrigins = session.origins.length > 0;
  const hasIntermediaries = session.intermediaries.length > 0;
  const hasDests = session.destinations.length > 0;
  // Group derivatives by parentId so we can render them nested
  // under the RealNodeCard for their parent.
  const derivativesByParent = new Map<string, typeof session.derivatives>();
  for (const d of session.derivatives ?? []) {
    const bucket = derivativesByParent.get(d.parentId) ?? [];
    bucket.push(d);
    derivativesByParent.set(d.parentId, bucket);
  }

  return (
    <div style={{
      background: "var(--bg-card)",
      border: "1px solid var(--border)",
      borderRadius: 10,
      padding: "14px 16px",
      marginBottom: 12,
    }}>
      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 10, fontWeight: 500 }}>
        {formatDate(session.date)}
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 0, flexWrap: "nowrap", overflowX: "auto" }}>

        {/* Origin column */}
        {hasOrigins && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
            <div style={{ fontSize: "0.6rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, paddingLeft: 2 }}>
              Origin
            </div>
            {session.origins.map((node, i) =>
              node.kind === "real" ? (
                <NodeWithClips key={i} node={node} clips={derivativesByParent.get(node.record.id) ?? []} onJumpTo={onJumpTo} />
              ) : (
                <PhantomNodeCard key={i} node={node} />
              )
            )}
          </div>
        )}

        {hasOrigins && hasIntermediaries && <Arrow />}

        {/* Intermediary column */}
        {hasIntermediaries && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
            <div style={{ fontSize: "0.6rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, paddingLeft: 2 }}>
              Intermediary
            </div>
            {session.intermediaries.map((node, i) => (
              <NodeWithClips key={i} node={node} clips={derivativesByParent.get(node.record.id) ?? []} onJumpTo={onJumpTo} />
            ))}
          </div>
        )}

        {hasIntermediaries && hasDests && <Arrow />}
        {!hasIntermediaries && hasOrigins && hasDests && <Arrow />}

        {/* Destination column */}
        {hasDests && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
            <div style={{ fontSize: "0.6rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, paddingLeft: 2 }}>
              Published
            </div>
            {session.destinations.map((dest, i) => (
              <DestCard key={i} dest={dest} />
            ))}
          </div>
        )}

        {/* If only intermediaries (no origin, no dest yet) */}
        {!hasOrigins && !hasDests && hasIntermediaries && (
          <div style={{ alignSelf: "center", color: "var(--text-muted)", fontSize: "0.75rem", padding: "0 12px" }}>
            (no linked origin or destination yet)
          </div>
        )}
      </div>
    </div>
  );
}

export default function ProvenanceGraph({ videos, focusId, onJumpTo }: Props) {
  const sessions = useMemo(() => {
    const all = buildProvenance(videos);
    if (!focusId) return all;
    return all.filter((s) =>
      [...s.origins, ...s.intermediaries].some(
        (n) => n.kind === "real" && n.record.id === focusId
      )
    );
  }, [videos, focusId]);

  if (sessions.length === 0) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", padding: "24px 0", textAlign: "center" }}>
        {focusId
          ? "No provenance links for this record yet. Use the Provenance button on a card to add upstream links."
          : "No provenance links yet. Import Fireflies or Zoom recordings and link them, or use the Provenance button on any video card."}
      </div>
    );
  }

  return (
    <div>
      {!focusId && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 12 }}>
          {sessions.length} session{sessions.length !== 1 ? "s" : ""} with provenance links
        </div>
      )}
      {sessions.map((s, i) => (
        <SessionRow key={i} session={s} onJumpTo={onJumpTo} />
      ))}
    </div>
  );
}
