/**
 * ADR-077 §5 (Drive half) — share-scope apply/read-back mapping.
 *
 * Apply and read-back live in one module precisely so they can't drift; a
 * read-back that disagreed with what apply did would make §6's conformance
 * report flag correctly-configured files as mismatched.
 */

import { describe, it, expect } from "vitest";
import {
  permissionForScope,
  scopeFromPermissions,
  scopeSatisfiesDeclared,
} from "../src/lib/publish/driveShareScope";

describe("permissionForScope", () => {
  it("creates nothing for inherit", () => {
    // Mimicking the folder with an explicit grant would freeze the file's
    // sharing at publish time — the opposite of inheriting.
    expect(permissionForScope("inherit", "agentics.org")).toBeNull();
  });

  it("grants anyone reader for anyone_with_link", () => {
    expect(permissionForScope("anyone_with_link", "agentics.org"))
      .toEqual({ type: "anyone", role: "reader" });
  });

  it("grants the org domain reader for org_restricted", () => {
    expect(permissionForScope("org_restricted", "agentics.org"))
      .toEqual({ type: "domain", role: "reader", domain: "agentics.org" });
  });

  it("refuses org_restricted without a configured domain", () => {
    // Silently falling back to folder-inherited sharing here is how a
    // declared restriction becomes a no-op.
    expect(() => permissionForScope("org_restricted", undefined))
      .toThrow(/WS_DOMAIN/);
  });

  it("does not need a domain for the other scopes", () => {
    expect(() => permissionForScope("inherit", undefined)).not.toThrow();
    expect(() => permissionForScope("anyone_with_link", undefined)).not.toThrow();
  });
});

describe("scopeFromPermissions", () => {
  it("reads anyone as anyone_with_link", () => {
    expect(scopeFromPermissions([{ type: "anyone", role: "reader" }])).toBe("anyone_with_link");
  });

  it("reads a domain grant as org_restricted", () => {
    expect(scopeFromPermissions([{ type: "domain", role: "reader", domain: "agentics.org" }]))
      .toBe("org_restricted");
  });

  it("reads named-users-only as restricted", () => {
    expect(scopeFromPermissions([{ type: "user", role: "writer" }])).toBe("restricted");
  });

  it("treats no permissions and missing permissions as restricted", () => {
    expect(scopeFromPermissions([])).toBe("restricted");
    expect(scopeFromPermissions(undefined)).toBe("restricted");
    expect(scopeFromPermissions(null)).toBe("restricted");
  });

  it("reports the WIDEST grant when several overlap", () => {
    // Understating exposure is the wrong way to be wrong: a file readable
    // by anyone is public even if it also carries a narrower domain grant.
    expect(scopeFromPermissions([
      { type: "user", role: "writer" },
      { type: "domain", role: "reader", domain: "agentics.org" },
      { type: "anyone", role: "reader" },
    ])).toBe("anyone_with_link");
  });
});

describe("scopeSatisfiesDeclared", () => {
  it("counts inherit as always satisfied", () => {
    // The series asked for the folder's sharing; whatever was inherited IS
    // the folder's sharing. The observed value is still recorded so an
    // operator can see what that turned out to be.
    expect(scopeSatisfiesDeclared("inherit", "restricted")).toBe(true);
    expect(scopeSatisfiesDeclared("inherit", "anyone_with_link")).toBe(true);
  });

  it("requires an exact match for an explicit scope", () => {
    expect(scopeSatisfiesDeclared("org_restricted", "org_restricted")).toBe(true);
    expect(scopeSatisfiesDeclared("org_restricted", "restricted")).toBe(false);
    expect(scopeSatisfiesDeclared("anyone_with_link", "org_restricted")).toBe(false);
  });

  it("flags a file that is wider than declared", () => {
    // The case worth catching: a chapter's members-only archive that is
    // actually readable by anyone with the link.
    expect(scopeSatisfiesDeclared("org_restricted", "anyone_with_link")).toBe(false);
  });
});
