/**
 * ADR-077 §5 (Drive half) — translate a declared `share_scope` into a
 * Drive permission, and read an observed scope back out of one.
 *
 * Both directions live here so they cannot drift: a read-back that
 * disagrees with what apply actually did would make §6's conformance
 * measurement lie in the most confusing way possible — reporting a
 * mismatch on a file that is set correctly.
 *
 * Until this shipped, /api/drive/publish set no permissions at all, so a
 * declared `org_restricted` or `anyone_with_link` was silently ignored and
 * the file simply inherited its folder's sharing.
 */

/** The scopes a series can declare (ADR-075's DestinationSpec). */
export type DriveShareScope = "inherit" | "org_restricted" | "anyone_with_link";

/**
 * What we can actually observe on a file. A superset of the declarable
 * scopes: `restricted` is a real state (only named people can open it)
 * that no series can ask for, and `inherit` is NOT observable — a file
 * whose permissions came from its folder still reports those permissions,
 * so reading back an `inherit` file yields whatever the folder conferred.
 * That is the useful answer, not a limitation.
 */
export type ObservedDriveScope = "org_restricted" | "anyone_with_link" | "restricted";

/** Minimal shape of a Drive permission, as returned by files.get. */
export interface DrivePermission {
  type?: string | null;
  role?: string | null;
  domain?: string | null;
}

/**
 * The permission to create for a declared scope, or `null` when the scope
 * asks for nothing to be set.
 *
 * `inherit` deliberately returns null: the file keeps whatever the target
 * folder confers. Creating an explicit permission to mimic the folder
 * would freeze the file's sharing at publish time and stop it tracking a
 * later change to the folder — the opposite of "inherit".
 */
export function permissionForScope(
  scope: DriveShareScope,
  orgDomain: string | undefined,
): DrivePermission | null {
  switch (scope) {
    case "inherit":
      return null;
    case "anyone_with_link":
      return { type: "anyone", role: "reader" };
    case "org_restricted":
      if (!orgDomain) {
        throw new Error(
          "share_scope 'org_restricted' needs the Workspace domain — set WS_DOMAIN on the service.",
        );
      }
      return { type: "domain", role: "reader", domain: orgDomain };
  }
}

/**
 * Reduce a file's permission list to a single observed scope.
 *
 * Ordered widest-first: a file readable by anyone is `anyone_with_link`
 * even if it also carries a domain grant, because the widest grant is what
 * determines who can actually reach it. Reporting the narrower one would
 * understate the exposure, which is the wrong way to be wrong.
 */
export function scopeFromPermissions(
  permissions: DrivePermission[] | undefined | null,
): ObservedDriveScope {
  const perms = permissions ?? [];
  if (perms.some(p => p.type === "anyone")) return "anyone_with_link";
  if (perms.some(p => p.type === "domain")) return "org_restricted";
  return "restricted";
}

/**
 * Whether an observed scope satisfies what was declared — §6's
 * conformance question for a Drive destination.
 *
 * `inherit` is always satisfied: the series asked for the folder's
 * sharing, and whatever the file inherited IS the folder's sharing. The
 * observed value is still worth recording so an operator can see what
 * that turned out to be.
 */
export function scopeSatisfiesDeclared(
  declared: DriveShareScope,
  observed: ObservedDriveScope,
): boolean {
  if (declared === "inherit") return true;
  return declared === observed;
}
