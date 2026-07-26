"use client";

/**
 * ADR-057 — Overview / Calendar page.
 *
 * SyncStatusPanel already carries Overview + Calendar as tabs
 * (tab selection persists in localStorage). Promoted from /import
 * to its own sidebar entry because operators surfaced this as
 * "the first place I tend to look" — deserves top-level billing.
 */

import SyncStatusPanel from "../../../components/SyncStatusPanel";
import { useApp } from "../AppContext";

export default function OverviewPage() {
  const { videos, broadcastPairs, showPaired, ensureVideoVisible } = useApp();
  const visibleVideos = showPaired
    ? videos
    : videos.filter(v => !broadcastPairs.destinationRecordIds.has(v.id));
  return (
    <>
      <div className="header">
        <h1>Overview</h1>
      </div>
      <SyncStatusPanel videos={visibleVideos} onNavigateToVideo={ensureVideoVisible} />
    </>
  );
}
