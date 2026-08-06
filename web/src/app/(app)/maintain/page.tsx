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
 *
 * ADR-064 moved the Show Notes prompt and description strategy panels
 * out of here and into /config where the other operator-tunable knobs
 * live. Maintain stays focused on bulk-regen / catch-up actions.
 */

import CatchUpPanel from "../../../components/CatchUpPanel";
import DrivePendingPullPanel from "../../../components/DrivePendingPullPanel";
import { useApp } from "../AppContext";

export default function MaintainPage() {
  const { videos, addEvent } = useApp();
  return (
    <>
      <div className="header">
        <h1>Maintain</h1>
      </div>
      {/* ADR-071 §2 — pending curator Drive pulls. Renders nothing when
          the queue is empty, so it doesn't pollute the layout. */}
      <DrivePendingPullPanel videos={videos} onEvent={addEvent} />
      <CatchUpPanel
        open
        videos={videos}
        onEvent={addEvent}
        onClose={() => {/* no-op — this is a page, not a drawer */}}
        variant="page"
      />
    </>
  );
}
