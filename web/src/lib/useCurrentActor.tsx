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
 * Returns a JSON string suitable for `actor: ...` in WASM commands.
 * Falls back to the synthetic admin actor when the real one isn't loaded
 * yet (boot, network error). Migration target for ADMIN_ACTOR sites.
 */
export function actorJsonOrFallback(actor: Actor | null): string {
  return JSON.stringify(actor ?? FALLBACK_ACTOR);
}
