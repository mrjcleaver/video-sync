"use client";

import type { ReactNode } from "react";
import { CurrentActorProvider } from "../lib/useCurrentActor";

/**
 * Client-side provider tree. Renders inside the (server-side) RootLayout
 * so every page's components — including the top-level Dashboard — can
 * call client-side hooks like useCurrentActor().
 */
export function Providers({ children }: { children: ReactNode }) {
  return <CurrentActorProvider>{children}</CurrentActorProvider>;
}
