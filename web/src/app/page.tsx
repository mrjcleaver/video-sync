/**
 * ADR-057 Option A — root landing.
 *
 * The daily-driver activity is Review + Curate, which lives at
 * /catalog. This root page just forwards the operator there.
 * Non-catalog routes (/import, /maintain, /shorts, /config,
 * /provenance) sit under the (app) route group with a shared
 * sidebar layout — see web/src/app/(app)/layout.tsx.
 */

import { redirect } from "next/navigation";

export default function RootPage() {
  redirect("/catalog");
}
