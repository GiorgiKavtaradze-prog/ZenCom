"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// Active-org guard for the dashboard (client side, reactive).
//
// Uses `getActiveWorkspace` (which wraps `requireOrgMember` and surfaces the
// typed NO_ACTIVE_ORG / NOT_AUTHENTICATED / WORKSPACE_NOT_FOUND codes as a
// discriminated result instead of throwing). If there is no active org the user
// is routed to /onboarding, where they create one (which turns on the org
// claims). WORKSPACE_NOT_FOUND (org active but workspace row not minted yet —
// webhook lag) is ALSO routed to /onboarding, which idempotently provisions it.
//
// While the query is loading we render a lightweight placeholder so the rest of
// the dashboard doesn't flash unauthorized content. Once `ok`, children render.
//
// Self-heal: WORKSPACE_NOT_FOUND means the org is active but its workspace row
// was never minted — typically because the `organization.created` Clerk webhook
// didn't land (e.g. the app ran while `convex dev` was down). Instead of
// bouncing to /onboarding, we idempotently re-provision in place via
// `createWorkspaceForOrg`; the reactive query then re-resolves to `ok` and the
// dashboard renders without a round-trip. NO_ACTIVE_ORG still routes to
// /onboarding since there's nothing to heal until the user picks/creates an org.
// ─────────────────────────────────────────────────────────────────────────────
export function OrgGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();

  // Skip the query until Convex actually has the Clerk token, otherwise it
  // resolves NOT_AUTHENTICATED on the first render before the token bridges.
  const active = useQuery(
    api.workspaces.getActiveWorkspace,
    isAuthenticated ? {} : "skip",
  );

  const provisionWorkspace = useMutation(api.onboarding.createWorkspaceForOrg);
  // Guards against firing the heal mutation repeatedly while it's in flight or
  // the reactive query is still catching up.
  const healingRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (active.ok) {
      // Reset so a later org switch into an unprovisioned org can heal again.
      healingRef.current = false;
      return;
    }
    if (active.code === "WORKSPACE_NOT_FOUND") {
      if (healingRef.current) return;
      healingRef.current = true;
      void provisionWorkspace().catch(() => {
        // Heal failed (e.g. the org claim dropped mid-flight) → fall back to the
        // onboarding flow, which surfaces the proper UI / retry.
        healingRef.current = false;
        router.replace("/onboarding");
      });
      return;
    }
    if (active.code === "NO_ACTIVE_ORG") {
      router.replace("/onboarding");
    }
    // NOT_AUTHENTICATED is handled by Clerk middleware (proxy.ts) redirecting to
    // sign-in; we don't bounce here to avoid a redirect loop during hydration.
  }, [active, provisionWorkspace, router]);

  // Auth still hydrating, or query in flight, or a redirect is imminent.
  if (authLoading || active === undefined || !active.ok) {
    return (
      <div className="grid min-h-[calc(100svh-53px)] place-items-center p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <Loader2 className="size-5 animate-spin" />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              Loading workspace
            </p>
            <p className="text-sm text-muted-foreground">
              Getting your dashboard ready…
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
