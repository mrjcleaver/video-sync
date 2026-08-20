/**
 * Shared Role/Actor types — single source of truth for both server and client.
 * Imported by lib/auth.ts (server) and lib/useCurrentActor.tsx (client).
 */

/**
 * Roles ordered from lowest to highest capability. ADR-065 inserts
 * `Contributor` between Viewer and Publisher — Contributor can Import
 * (write) but only sees their own records. Publisher supersedes.
 */
export type Role = "Admin" | "Publisher" | "Contributor" | "Viewer";

/** Server-side actor — includes the raw Google sub claim, never sent to clients. */
export interface Actor {
  user_id: string;
  role: Role;
  email: string;
  sub: string;
  /** ADR-076 §8.b — set when the request was authenticated via an MCP
   *  bearer token that carries a `name` field. The audit log emits
   *  this instead of `actor_email` so machine consumers (e.g. the
   *  agentics.org public site) show up under their token's label
   *  rather than the operator who minted the token. */
  token_name?: string;
  /** ADR-076 §8.c — free-text consumer label from the X-Consumer
   *  request header. Purely observability; no authorisation weight. */
  consumer_ua?: string;
}

/** Client-side actor — same as server's but with `sub` stripped (ADR-036 §3).
 *  `true_role` is the server-derived ceiling; `role` may be a demoted "view as"
 *  role per ADR-065. Clients that need the ceiling to render the role
 *  selector read `true_role`; everything else reads `role`. */
export type ClientActor = Omit<Actor, "sub"> & { true_role?: Role };
