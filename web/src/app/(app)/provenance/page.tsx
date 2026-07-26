"use client";

/**
 * ADR-057 Option A — Provenance graph view. Moved off /catalog into
 * its own page so the graph gets its own canvas rather than sharing
 * screen real estate with the card grid.
 */

import { useRouter } from "next/navigation";
import ProvenanceGraph from "../../../components/ProvenanceGraph";
import { useApp } from "../AppContext";

export default function ProvenancePage() {
  const { videos, setFilter } = useApp();
  const router = useRouter();

  return (
    <>
      <div className="header">
        <h1>Provenance</h1>
      </div>
      <ProvenanceGraph
        videos={videos}
        onJumpTo={(id) => {
          setFilter("All");
          router.push("/catalog");
          // Defer scroll — the target card lives on /catalog which
          // is about to mount.
          setTimeout(() => {
            const el = document.getElementById(`video-card-${id}`);
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 250);
        }}
      />
    </>
  );
}
