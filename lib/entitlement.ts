"use client";

import { useAuth } from "@clerk/nextjs";
import type { Feature, PlanSlug } from "@/convex/lib/plans";

// ─────────────────────────────────────────────────────────────────────────────
// Client-side entitlement helpers (UI gating only).
//
// These wrap Clerk's `has()` (from `useAuth()`), which reads the active session
// claims — no network request. They are the source of truth for HIDING UI; the
// real enforcement lives in Convex (`convex/lib/entitlements.ts`) and Clerk's
// native seat caps. Never trust a client gate for authorization.
//
// `has()` is `undefined` until Clerk hydrates, so every helper returns `false`
// (deny / loading) until `isLoaded`. Pair with a skeleton if you need to avoid
// a flash of the locked state.
// ─────────────────────────────────────────────────────────────────────────────

export type Entitlements = {
  isLoaded: boolean;
  /** True only once Clerk has hydrated AND an org is active. */
  hasFeature: (feature: Feature) => boolean;
  hasPlan: (plan: PlanSlug) => boolean;
};

export function useEntitlements(): Entitlements {
  const { has, isLoaded, orgId } = useAuth();

  return {
    isLoaded,
    hasFeature: (feature: Feature) =>
      isLoaded && !!orgId && (has?.({ feature }) ?? false),
    hasPlan: (plan: PlanSlug) =>
      isLoaded && !!orgId && (has?.({ plan }) ?? false),
  };
}

// Convenience single-feature hook for inline conditionals.
export function useHasFeature(feature: Feature): {
  isLoaded: boolean;
  allowed: boolean;
} {
  const { hasFeature, isLoaded } = useEntitlements();
  return { isLoaded, allowed: hasFeature(feature) };
}
