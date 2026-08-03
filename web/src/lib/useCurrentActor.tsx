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
import type { ClientActor as Actor, Role } from "./types/actor";

export type { Role };
export type { ClientActor as Actor } from "./types/actor";

interface ActorState {
  actor: Actor | null;
  loading: boolean;
  error: string | null;
  /** The role the server gave us, before any client-side "view as" downgrade. */
  trueRole: Role | null;
  /** Currently-selected "view as" role. null = view as your true role. */
  viewAsRole: Role | null;
  /** Setter for the "view as" role. Downgrading only — attempts to elevate no-op.
   *  Persists to localStorage. */
  setViewAsRole: (role: Role | null) => void;
}

const ROLE_ORDER: Record<Role, number> = { Viewer: 0, Contributor: 1, Publisher: 2, Admin: 3 };
const VIEW_AS_KEY = "video-sync:view-as-role";

const FALLBACK_ACTOR: Actor = {
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "Admin",
  email: "loading@localhost",
};

const CurrentActorContext = createContext<ActorState>({
  actor: null,
  loading: true,
  error: null,
  trueRole: null,
  viewAsRole: null,
  setViewAsRole: () => {},
});

// Per ADR-045: users who pass IAP (e.g. any @agentics.org Workspace user)
// but are not in any video-sync role group get bounced to the project
// wiki rather than left on an unusable HTML shell. Configurable via env;
// defaults to the GitHub wiki.
const UNAUTHORIZED_REDIRECT_URL =
  process.env.NEXT_PUBLIC_UNAUTHORIZED_REDIRECT_URL ??
  "https://github.com/mrjcleaver/video-sync/wiki";

export function CurrentActorProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState<Actor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trueRole, setTrueRole] = useState<Role | null>(null);
  const [viewAsRole, setViewAsRoleState] = useState<Role | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(VIEW_AS_KEY);
    if (!raw) return null;
    if (raw === "Admin" || raw === "Publisher" || raw === "Contributor" || raw === "Viewer") return raw;
    return null;
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then(async r => {
        if (r.status === 401) {
          if (typeof window !== "undefined") {
            window.location.replace(UNAUTHORIZED_REDIRECT_URL);
          }
          throw new Error("unauthorized");
        }
        if (!r.ok) throw new Error(`auth/me ${r.status}`);
        return r.json();
      })
      .then((data: Actor) => {
        if (cancelled) return;
        setActor(data);
        // Prefer the explicit true_role from /api/auth/me when present;
        // fall back to the effective role for backward compatibility.
        setTrueRole(data.true_role ?? data.role);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Install a fetch interceptor that stamps X-View-As on every same-origin
  // request when a view-as role is active. The server's getActor honours
  // the header only when it demotes (never elevates), so a compromised
  // client can't use this to gain privileges. Interceptor is idempotent
  // — the previous ref is chained through so we don't double-wrap on
  // React strict-mode double-mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const origFetch = window.fetch.bind(window);
    const patched: typeof window.fetch = (input, init) => {
      const nextInit: RequestInit = init ? { ...init } : {};
      const headers = new Headers(nextInit.headers ?? {});
      if (viewAsRole) headers.set("X-View-As", viewAsRole);
      else headers.delete("X-View-As");
      nextInit.headers = headers;
      return origFetch(input, nextInit);
    };
    window.fetch = patched;
    return () => { window.fetch = origFetch; };
  }, [viewAsRole]);

  const setViewAsRole = (role: Role | null) => {
    if (typeof window !== "undefined") {
      if (role) window.localStorage.setItem(VIEW_AS_KEY, role);
      else window.localStorage.removeItem(VIEW_AS_KEY);
    }
    setViewAsRoleState(role);
    // A role change alters what the server returns for /api/catalog and
    // friends; a full reload is the cleanest way to re-hydrate everything
    // (in particular the WASM store, which does per-record merge on boot).
    if (typeof window !== "undefined") window.location.reload();
  };

  // Effective actor combines the server's actor with any client-side
  // "view as" downgrade. Elevation attempts are ignored — a Publisher
  // pretending to be Admin gets Publisher.
  const effectiveActor: Actor | null = actor
    ? (viewAsRole && ROLE_ORDER[viewAsRole] < ROLE_ORDER[actor.role]
        ? { ...actor, role: viewAsRole }
        : actor)
    : null;

  return (
    <CurrentActorContext.Provider value={{
      actor: effectiveActor,
      loading,
      error,
      trueRole,
      viewAsRole,
      setViewAsRole,
    }}>
      {children}
    </CurrentActorContext.Provider>
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
 * Throwing variant of `withActor` — terser at the click-handler callsites
 * that the migration touches. The throw bubbles to the React ErrorBoundary
 * (page.tsx) rather than silently falling back to the synthetic admin on
 * an authenticated-but-error state. QE-recommended migration target.
 *
 * Usage:
 *   videoStore.mutate(id, r => r.approve(actorCommand(actorState)));
 *   videoStore.mutate(id, r => r.skip(actorCommand(actorState, { reason: "…" })));
 */
export function actorCommand(state: ActorState, extra: Record<string, unknown> = {}): string {
  const json = withActor(state, extra);
  if (json === null) {
    throw new Error(`Cannot perform action: ${state.error ?? "not authenticated"}`);
  }
  return json;
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
