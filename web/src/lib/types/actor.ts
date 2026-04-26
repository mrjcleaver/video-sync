/**
 * Shared Role/Actor types — single source of truth for both server and client.
 * Imported by lib/auth.ts (server) and lib/useCurrentActor.tsx (client).
 */

export type Role = "Admin" | "Publisher" | "Viewer";

/** Server-side actor — includes the raw Google sub claim, never sent to clients. */
export interface Actor {
  user_id: string;
  role: Role;
  email: string;
  sub: string;
}

/** Client-side actor — same as server's but with `sub` stripped (ADR-036 §3). */
export type ClientActor = Omit<Actor, "sub">;
