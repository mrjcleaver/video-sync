"use client";

/**
 * Current-actor context for ADR-036.
 *
 * Exposes the authenticated user's actor (derived server-side from the
 * IAP JWT) to every client component. Replaces the hard-coded
 * ADMIN_ACTOR pattern.
 *
 * Until the migration is complete, callers can fall back to the legacy
 * ADMIN_ACTOR when the actor isn't loaded yet — the JSON shape is
 * identical, so WASM commands accept either.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Role = "Admin" | "Publisher" | "Viewer";

export interface Actor {
  user_id: string;
  role: Role;
  email: string;
}

interface ActorState {
  actor: Actor | null;
  loading: boolean;
  error: string | null;
}

const FALLBACK_ACTOR: Actor = {
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "Admin",
  email: "loading@localhost",
};

const CurrentActorContext = createContext<ActorState>({
  actor: null,
  loading: true,
  error: null,
});

export function CurrentActorProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ActorState>({ actor: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then(r => {
        if (!r.ok) throw new Error(`auth/me ${r.status}`);
        return r.json();
      })
      .then((data: Actor) => {
        if (!cancelled) setState({ actor: data, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ actor: null, loading: false, error: err.message });
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <CurrentActorContext.Provider value={state}>{children}</CurrentActorContext.Provider>
  );
}

export function useCurrentActor(): ActorState {
  return useContext(CurrentActorContext);
}

/**
 * Returns the actor object suitable for embedding in a WASM command JSON.
 *
 * - `state.actor` if loaded → real authenticated actor
 * - `FALLBACK_ACTOR` while `state.loading` → keeps single-user dev mode
 *   responsive; safe because the WASM aggregate's authorization is
 *   re-checked server-side once Phase 2 lands
 * - `null` on `state.error` (e.g. /api/auth/me returned 401) → callers
 *   MUST refuse to run the command rather than silently fall back to
 *   admin (QE finding sec#3 + rev#5)
 *
 * Use `withActor(state, extra)` for the common pattern of merging the
 * actor into the rest of the command payload.
 */
export function actorOrNull(state: ActorState): Actor | null {
  if (state.actor) return state.actor;
  if (state.loading) return FALLBACK_ACTOR;
  return null;  // error state — caller must check
}

/**
 * Build the JSON string for a WASM command payload. Returns null on
 * auth-error; callers should bail out with an event-log entry instead
 * of mutating with the fallback admin.
 *
 * Usage:
 *   const payload = withActor(actorState, { reason: "..." });
 *   if (!payload) { onEvent("Cannot mutate — auth not ready"); return; }
 *   videoStore.mutate(id, r => r.skip(payload));
 */
export function withActor(state: ActorState, extra: Record<string, unknown> = {}): string | null {
  const actor = actorOrNull(state);
  if (!actor) return null;
  return JSON.stringify({ actor, ...extra });
}

/**
 * Legacy compatibility shim for the canonical migrated callsite.
 * Always returns a valid JSON string (falls back to admin in error
 * paths, matching the pre-ADR-036 behaviour). Use `withActor` for new
 * code so error paths block rather than silently elevate.
 *
 * @deprecated Use `withActor` so 401s don't silently elevate.
 */
export function actorJsonOrFallback(actor: Actor | null): string {
  return JSON.stringify(actor ?? FALLBACK_ACTOR);
}
