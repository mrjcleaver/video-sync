/**
 * ADR-057 Option A — root landing.
 *
 * Operators reported Overview (calendar / sync-status view) as
 * "the first place I tend to look". Root forwards there. The
 * card-list view lives at /catalog (one click away in the
 * sidebar); other activities at their own routes under the
 * (app) route group — see web/src/app/(app)/layout.tsx.
 */

import { redirect } from "next/navigation";

export default function RootPage() {
  redirect("/overview");
}
