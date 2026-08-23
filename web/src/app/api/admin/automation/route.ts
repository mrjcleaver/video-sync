/**
 * GET  /api/admin/automation   — read the bulk-automation switch
 * PUT  /api/admin/automation   — flip it (Admin only)
 *
 * A single kill switch over every background activity that MUTATES the
 * catalog or pushes to an external platform without an operator watching
 * each item:
 *
 *   - the backfill orchestrator (bulk publish on a 5-minute timer)
 *   - the ingestion rule runner (auto-scope / approve / skip, 60s timer)
 *   - the catch-up sweep (bulk summarise + link, spends LLM budget)
 *
 * Read-only polling — the audit feed, memory health, the access log — is
 * deliberately NOT gated. Those observe; they don't act.
 *
 * **Default is OFF.** A deployment with no stored setting does not run
 * bulk automation, so shipping a change to the publish path cannot start
 * pushing videos before an operator has looked at it. Turning it on is an
 * explicit, audited act.
 *
 * GET is open to any authenticated actor because the panels need it to
 * render their disabled state. PUT is Admin-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";

export const dynamic = "force-dynamic";

const FILE = () => join(process.cwd(), "data", "automation.json");

export interface AutomationSettings {
  /** When false, no bulk/background mutation runs. */
  bulk_enabled: boolean;
  /** Who last changed it, for the audit trail. */
  set_by?: string;
  set_at?: string;
}

/** Safe default: automation off. Applies to a fresh deployment, a missing
 *  file, and a corrupt one — every failure mode lands on "don't act". */
const SAFE_DEFAULT: AutomationSettings = { bulk_enabled: false };

async function read(): Promise<AutomationSettings> {
  try {
    const raw = await fs.readFile(FILE(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AutomationSettings>;
    return {
      bulk_enabled: parsed.bulk_enabled === true,
      set_by: typeof parsed.set_by === "string" ? parsed.set_by : undefined,
      set_at: typeof parsed.set_at === "string" ? parsed.set_at : undefined,
    };
  } catch {
    return { ...SAFE_DEFAULT };
  }
}

async function getHandler() {
  return NextResponse.json(await read());
}

async function putHandler(req: NextRequest) {
  let actor;
  try { actor = await getActor(req); }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role !== "Admin") {
    return NextResponse.json({ error: "Admin role required to change automation settings" }, { status: 403 });
  }

  let body: { bulk_enabled?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.bulk_enabled !== "boolean") {
    return NextResponse.json({ error: "bulk_enabled must be a boolean" }, { status: 400 });
  }

  const next: AutomationSettings = {
    bulk_enabled: body.bulk_enabled,
    set_by: actor.email,
    set_at: new Date().toISOString(),
  };
  await fs.mkdir(dirname(FILE()), { recursive: true });
  await fs.writeFile(FILE(), JSON.stringify(next, null, 2), "utf-8");

  // Worth its own log line: "who turned bulk publishing on, and when" is
  // the first question after an unexpected batch of uploads.
  serverLog("warn", "api:admin/automation", "bulk-automation-changed", {
    bulk_enabled: next.bulk_enabled, actor_email: actor.email,
  });
  return NextResponse.json(next);
}

export const GET = withRequestLogging("api:admin/automation", getHandler as never);
export const PUT = withRequestLogging("api:admin/automation", putHandler as never);
