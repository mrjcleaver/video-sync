"use client";

/**
 * ADR-057 Option A — Maintain page. Promotes the CatchUp drawer's
 * content to a first-class page so the four+ maintenance cards
 * (broadcast-pair migration, YouTube row backfill, summary badge
 * backfill, title alignment, catch-up runner) get proper canvas
 * room rather than competing for drawer width.
 *
 * CatchUpPanel still supports the drawer variant elsewhere via its
 * `variant` prop; this page renders it in "page" mode.
 */

import CatchUpPanel from "../../../components/CatchUpPanel";
import SummaryPromptPanel from "../../../components/SummaryPromptPanel";
import { useApp } from "../AppContext";
import { useState } from "react";

export default function MaintainPage() {
  const { videos, addEvent } = useApp();
  // Summary Prompt is arguably Config-ish, but it's an
  // operator-invoked maintenance-ish action (bulk regen unlocked
  // summaries), so it lives next to CatchUp with a toggle to keep
  // the page compact.
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <>
      <div className="header">
        <h1>Maintain</h1>
        <div className="stats">
          <button
            className={`btn btn-sm ${showPrompt ? "btn-primary" : ""}`}
            onClick={() => setShowPrompt(v => !v)}
            title="Edit the org-shared summary prompt and bulk-regenerate unlocked summaries (ADR-046)"
          >
            📄 Summary Prompt
          </button>
        </div>
      </div>
      <CatchUpPanel
        open
        videos={videos}
        onEvent={addEvent}
        onClose={() => {/* no-op — this is a page, not a drawer */}}
        variant="page"
      />
      <SummaryPromptPanel
        open={showPrompt}
        videos={videos}
        onEvent={addEvent}
        onClose={() => setShowPrompt(false)}
      />
    </>
  );
}
