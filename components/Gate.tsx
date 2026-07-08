"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useEntitlements } from "@/lib/entitlement";
import type { Feature, PlanSlug } from "@/convex/lib/plans";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ─────────────────────────────────────────────────────────────────────────────
// <Gate> — reusable client-side feature/plan gate.
//
// Renders `children` only when the active org has the given `feature` (or
// `plan`). Otherwise renders `fallback` (defaults to a small upgrade prompt
// linking to /pricing). Use for UI-level hiding only — Convex + Clerk enforce
// the real boundary.
//
//   <Gate feature="website_crawl">
//     <CrawlButton />
//   </Gate>
//
//   <Gate plan="pro" fallback={<Locked />}>
//     <ProSettings />
//   </Gate>
// ─────────────────────────────────────────────────────────────────────────────

type GateProps = {
  feature?: Feature;
  plan?: PlanSlug;
  children: ReactNode;
  /** Shown when the entitlement is missing. Defaults to an upgrade prompt. */
  fallback?: ReactNode;
  /** Shown while Clerk is still hydrating. Defaults to a skeleton. */
  loading?: ReactNode;
};

export function Gate({
  feature,
  plan,
  children,
  fallback,
  loading,
}: GateProps) {
  const { isLoaded, hasFeature, hasPlan } = useEntitlements();

  if (!isLoaded) {
    return <>{loading ?? <Skeleton className="h-9 w-32" />}</>;
  }

  const allowed = feature
    ? hasFeature(feature)
    : plan
      ? hasPlan(plan)
      : false;

  if (allowed) return <>{children}</>;

  return <>{fallback ?? <UpgradePrompt />}</>;
}

function UpgradePrompt() {
  return (
    <div className="text-muted-foreground flex items-center gap-3 text-sm">
      <span>This is a paid feature.</span>
      <Button asChild size="sm" className="bg-brand text-brand-fg hover:bg-brand/90">
        <Link href="/pricing">Upgrade</Link>
      </Button>
    </div>
  );
}
