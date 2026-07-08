"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ClaimDebugPanel } from "@/components/claim-debug-panel";

// Live Convex-side view of the org claims via `debug.whoami`. Reactive, so it
// updates the instant the active org (and thus the JWT claims) changes.
export function DebugClaims() {
  const whoami = useQuery(api.debug.whoami);
  return <ClaimDebugPanel whoami={whoami} />;
}
