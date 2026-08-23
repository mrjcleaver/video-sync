/**
 * Client-side accessor for the bulk-automation kill switch.
 *
 * Mirrors seriesRegistryClient's shape: an async fetch warmed once, plus a
 * synchronous accessor for the hot paths that can't await (a timer
 * callback deciding whether to run).
 *
 * The synchronous accessor defaults to DISABLED until the first fetch
 * resolves. That direction matters: a race at page load must not let a
 * bulk publish start before we know whether it's allowed. Erring toward
 * "don't act" costs one skipped tick; erring the other way pushes videos.
 */

export interface AutomationSettings {
  bulk_enabled: boolean;
  set_by?: string;
  set_at?: string;
}

const DISABLED: AutomationSettings = { bulk_enabled: false };

let cache: AutomationSettings | null = null;
let inflight: Promise<AutomationSettings> | null = null;

async function fetchOnce(): Promise<AutomationSettings> {
  try {
    const res = await fetch("/api/admin/automation", { cache: "no-store" });
    if (!res.ok) return { ...DISABLED };
    const data = await res.json() as Partial<AutomationSettings>;
    return { ...DISABLED, ...data, bulk_enabled: data.bulk_enabled === true };
  } catch {
    // Offline or a failing route means we cannot confirm it's allowed.
    return { ...DISABLED };
  }
}

/** Fetch the setting, cached after the first success. */
export async function getAutomationSettings(): Promise<AutomationSettings> {
  if (cache) return cache;
  if (!inflight) inflight = fetchOnce().then(v => { cache = v; inflight = null; return v; });
  return inflight;
}

/** Synchronous read for timer callbacks. Disabled until warmed. */
export function isBulkAutomationEnabled(): boolean {
  return cache?.bulk_enabled === true;
}

/** Cached settings, or the disabled default when not yet warmed. */
export function getAutomationSettingsCached(): AutomationSettings {
  return cache ?? { ...DISABLED };
}

/** Flip the switch. Admin only server-side; throws with the route's
 *  message otherwise so the caller can surface it. */
export async function setBulkAutomation(enabled: boolean): Promise<AutomationSettings> {
  const res = await fetch("/api/admin/automation", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bulk_enabled: enabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Save failed (${res.status})`);
  }
  cache = { ...DISABLED, ...(data as Partial<AutomationSettings>), bulk_enabled: enabled };
  return cache;
}

/** Drop the cache so the next read re-fetches. */
export function refreshAutomationSettings(): void {
  cache = null;
}

/** Shared copy for the disabled state on every gated control, so the
 *  explanation is identical wherever an operator meets it. */
export const BULK_DISABLED_HINT =
  "Bulk automation is off. Turn it on in Config → Bulk automation to allow unattended batch runs.";
