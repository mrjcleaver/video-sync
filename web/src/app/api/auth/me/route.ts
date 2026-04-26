import { NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";

/**
 * GET /api/auth/me
 *
 * Returns the actor derived from the IAP JWT (or the dev actor when
 * ALLOW_NO_IAP=1). Used by the client `useCurrentActor()` hook to
 * populate command-actor JSON in WASM mutations (ADR-036).
 *
 * Response: { user_id, role, email, sub } on success, 401 with error
 * on auth failure.
 */

async function handler(req: Request) {
  try {
    const actor = await getActor(req);
    // Don't expose the raw `sub` to the client — it's a Google identifier
    // we only need server-side. user_id (the derived UUID) is safe.
    return NextResponse.json({
      user_id: actor.user_id,
      role: actor.role,
      email: actor.email,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 401 },
    );
  }
}

export const GET = withRequestLogging("api:auth/me", handler);
