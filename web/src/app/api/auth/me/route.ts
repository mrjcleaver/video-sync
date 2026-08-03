import { NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getActor, getTrueActor } from "../../../../lib/auth";

/**
 * GET /api/auth/me
 *
 * Returns the actor derived from the IAP JWT (or the dev actor when
 * ALLOW_NO_IAP=1). Used by the client `useCurrentActor()` hook to
 * populate command-actor JSON in WASM mutations (ADR-036).
 *
 * Response: { user_id, role, email } on success, 401 with error on
 * auth failure. `sub` is intentionally withheld.
 *
 * Cache-Control: no-store — auth responses must never be cached
 * (browser, CDN, or Next route cache). QE finding rev#4.
 */

// Force runtime evaluation per request — no static caching of an auth response
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  "Pragma": "no-cache",
};

async function handler(req: Request) {
  try {
    // Always return the TRUE role here — the client uses this to
    // determine the ceiling of allowed "view as" roles. Other routes
    // honour X-View-As via getActor().
    const trueActor = await getTrueActor(req);
    // But surface the effective (possibly demoted) role too so the UI
    // can render both "You are Admin, viewing as Contributor" cleanly.
    const effectiveActor = await getActor(req);
    return NextResponse.json(
      {
        user_id: trueActor.user_id,
        role: effectiveActor.role,       // effective role — respects X-View-As
        true_role: trueActor.role,       // ceiling — never demoted
        email: trueActor.email,
      },
      { headers: NO_CACHE_HEADERS },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 401, headers: NO_CACHE_HEADERS },
    );
  }
}

export const GET = withRequestLogging("api:auth/me", handler);
