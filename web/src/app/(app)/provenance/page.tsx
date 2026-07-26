"use client";

/**
 * ADR-057 Option A — Provenance graph view. Moved off /catalog into
 * its own page so the graph gets its own canvas rather than sharing
 * screen real estate with the card grid.
 */

import ProvenanceGraph from "../../../components/ProvenanceGraph";
import { useApp } from "../AppContext";

export default function ProvenancePage() {
  const { videos, ensureVideoVisible } = useApp();
  return (
    <>
      <div className="header">
        <h1>Provenance</h1>
      </div>
      <ProvenanceGraph videos={videos} onJumpTo={ensureVideoVisible} />
    </>
  );
}
