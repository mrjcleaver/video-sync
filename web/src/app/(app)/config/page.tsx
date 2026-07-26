"use client";

/**
 * ADR-057 Option A — Config page. Setup and admin surface:
 * platform credentials (Connections), rules for automation
 * (Ingestion / Processing / Post-Processing), and the summary
 * prompt version (ADR-046). Rarely-visited by daily users but
 * dense when it IS visited — deserves its own canvas.
 */

import ConnectionsPanel from "../../../components/ConnectionsPanel";
import RulesPanel from "../../../components/RulesPanel";
import ProcessingRulesPanel from "../../../components/ProcessingRulesPanel";
import PostProcessingRulesPanel from "../../../components/PostProcessingRulesPanel";
import SeriesRegistryPanel from "../../../components/SeriesRegistryPanel";
import { useApp } from "../AppContext";
import { useState } from "react";

export default function ConfigPage() {
  const [showConnections, setShowConnections] = useState(true);
  const { ruleRunner } = useApp();
  return (
    <>
      <div className="header">
        <h1>Config</h1>
      </div>
      <ConnectionsPanel open={showConnections} onToggle={() => setShowConnections(v => !v)} />
      <RulesPanel
        isRunnerRunning={ruleRunner.isRunning}
        lastRun={ruleRunner.lastRun}
        matchCount={ruleRunner.matchCount}
        onRunNow={ruleRunner.runNow}
      />
      <ProcessingRulesPanel />
      <PostProcessingRulesPanel />
      <SeriesRegistryPanel />
    </>
  );
}
