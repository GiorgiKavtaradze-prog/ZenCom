"use client";

import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { CheckoutButton } from "@clerk/nextjs/experimental";
import {
  ArrowUpRight,
  Check,
  CreditCard,
  Lock,
  Sparkles,
  ShieldAlert,
  Users,
  Zap,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  FEATURE_LABELS,
  PLAN_DISPLAY,
  planName,
  statusLabel,
} from "@/lib/planDisplay";
import type { Feature } from "@/convex/lib/plans";

// Clerk plan ids for the bespoke <CheckoutButton> (dev vs prod differ — sourced
// from env, never hardcoded). When unset, the Upgrade CTA falls back to /pricing.
const PLAN_CHECKOUT_IDS: Record<"pro" | "scale", string | undefined> = {
  pro: process.env.NEXT_PUBLIC_CLERK_PLAN_PRO_ID,
  scale: process.env.NEXT_PUBLIC_CLERK_PLAN_SCALE_ID,
};

// ─────────────────────────────────────────────────────────────────────────────
// Billing dashboard (Phase 2). Admin-gated:
//   - the Convex `billingDashboard.getBillingOverview` query throws FORBIDDEN
//     for non-admins (server-side boundary);
//   - client-side we ALSO read Clerk `has({ plan })` so the live entitlement is
//     reflected immediately after checkout (before the webhook mirror lands).
// Shows: current plan + status, seats used vs limit, AI messages used vs quota,
// feature list, and an Upgrade CTA → /pricing.
// ─────────────────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { isAuthenticated } = useConvexAuth();
  const { has, isLoaded: clerkLoaded, orgRole } = useAuth();

  // Admin gate (client side): the Convex query throws FORBIDDEN for non-admins,
  // and a thrown query crashes the render tree — so we only ISSUE the query for
  // admins (skip otherwise) and show an admins-only notice for support members.
  // Convex still enforces server-side; this just avoids the error boundary.
  const isAdmin = orgRole === "org:admin";

  const overview = useQuery(
    api.billingDashboard.getBillingOverview,
    isAuthenticated && clerkLoaded && isAdmin ? {} : "skip",
  );

  if (clerkLoaded && !isAdmin) {
    return (
      <div className="mx-auto w-full max-w-2xl p-6 lg:p-8">
        <div className="rounded-2xl border bg-card p-10 text-center shadow-card">
          <div className="bg-muted text-muted-foreground mx-auto flex size-12 items-center justify-center rounded-2xl">
            <Lock className="size-6" />
          </div>
          <h2 className="mt-5 text-lg font-medium tracking-tight">
            Admins only
          </h2>
          <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-sm leading-relaxed">
            Only organization admins can view and manage billing. Ask an admin
            on your team if you need to change the plan.
          </p>
        </div>
      </div>
    );
  }

  const loading = overview === undefined || !clerkLoaded;

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6 lg:p-8">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-10 w-36 rounded-lg" />
        </div>
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-56 w-full rounded-2xl" />
      </div>
    );
  }

  // Prefer the live Clerk plan when it differs from the (possibly lagging)
  // mirror — checkout updates session claims before the webhook writes.
  const livePlanSlug =
    (["scale", "pro", "free_org"] as const).find((slug) =>
      has?.({ plan: slug }),
    ) ?? overview.planSlug;

  const display = PLAN_DISPLAY[livePlanSlug as keyof typeof PLAN_DISPLAY];
  const isFree = livePlanSlug === "free_org";

  // Next tier to upsell to (Free → Pro → Scale; Scale is the top tier).
  const upgrade =
    livePlanSlug === "free_org"
      ? { label: "Upgrade to Pro", planId: PLAN_CHECKOUT_IDS.pro }
      : livePlanSlug === "pro"
        ? { label: "Upgrade to Scale", planId: PLAN_CHECKOUT_IDS.scale }
        : null;

  const upgradeButton =
    upgrade && upgrade.planId ? (
      // Clerk's in-app checkout drawer for an organization payer. Opens
      // directly from the dashboard — no detour to /pricing. After a
      // successful subscription Clerk redirects back here.
      <CheckoutButton
        planId={upgrade.planId}
        planPeriod="month"
        for="organization"
        newSubscriptionRedirectUrl="/dashboard/billing"
      >
        <Button className="from-brand to-brand-2 bg-gradient-to-br text-white shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95">
          {upgrade.label}
          <ArrowUpRight className="size-4" />
        </Button>
      </CheckoutButton>
    ) : (
      // Top tier (Scale) or plan ids not configured → see all plans.
      <Button
        asChild
        className="from-brand to-brand-2 bg-gradient-to-br text-white shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95"
      >
        <Link href="/pricing">
          {isFree ? "Upgrade" : "Change plan"}
          <ArrowUpRight className="size-4" />
        </Link>
      </Button>
    );

  const featureKeys = Object.keys(FEATURE_LABELS) as Feature[];
  const includedCount = featureKeys.filter((f) =>
    overview.features.includes(f),
  ).length;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6 lg:p-8">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your organization’s plan, seats, and usage.
          </p>
        </div>
        {upgradeButton}
      </div>

      {/* Past-due / inactive banner */}
      {!overview.active && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-3 rounded-xl border p-4 text-sm">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-medium">
              Your subscription is {statusLabel(overview.status).toLowerCase()}
            </p>
            <p className="text-destructive/80 mt-0.5">
              Update your billing details to keep AI replies running for your
              team.
            </p>
          </div>
        </div>
      )}

      {/* Current plan + usage */}
      <div className="bg-card relative overflow-hidden rounded-2xl border shadow-card">
        {/* Brand glow accent */}
        <div
          aria-hidden
          className="bg-brand/10 pointer-events-none absolute -right-16 -top-16 size-44 rounded-full blur-3xl"
        />

        <div className="relative flex flex-wrap items-start justify-between gap-4 border-b p-6">
          <div className="flex items-center gap-4">
            <div className="from-brand to-brand-2 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-[0_8px_24px_-8px_var(--brand)]">
              <CreditCard className="size-6" />
            </div>
            <div>
              <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Current plan
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold tracking-tight">
                  {planName(livePlanSlug)}
                </h2>
                <StatusBadge
                  status={overview.status}
                  active={overview.active}
                />
              </div>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tracking-tight tabular-nums">
              {display?.priceMonthly === 0 ? "Free" : `$${display?.priceMonthly}`}
            </p>
            <p className="text-muted-foreground text-xs">
              {display?.priceMonthly === 0 ? "forever" : "per month"}
            </p>
          </div>
        </div>

        <div className="relative grid gap-4 p-6 sm:grid-cols-2">
          <UsageMeter
            icon={Users}
            label="Seats"
            used={overview.seats.used}
            limit={overview.seats.limit}
            unit="member"
          />
          <UsageMeter
            icon={Zap}
            label="AI messages"
            used={overview.aiMessages.used}
            limit={overview.aiMessages.limit}
            unit="message"
            periodEnd={overview.period.end}
          />
        </div>
      </div>

      {/* Features */}
      <Card className="shadow-card">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Plan features</CardTitle>
              <CardDescription>
                What’s available on your current plan.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="font-normal tabular-nums">
              {includedCount} of {featureKeys.length} included
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2">
            {featureKeys.map((feature) => {
              const included = overview.features.includes(feature);
              return (
                <li
                  key={feature}
                  className="bg-card flex items-center gap-3 p-3.5 text-sm"
                >
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
                      included
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {included ? (
                      <Check className="size-4" />
                    ) : (
                      <Lock className="size-3.5" />
                    )}
                  </span>
                  <span
                    className={
                      included
                        ? "font-medium"
                        : "text-muted-foreground"
                    }
                  >
                    {FEATURE_LABELS[feature]}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {/* Upgrade card */}
      {upgrade ? (
        <div className="bg-ink relative overflow-hidden rounded-2xl border border-transparent p-6 text-white shadow-elevated sm:p-8">
          <div
            aria-hidden
            className="bg-brand/30 pointer-events-none absolute -left-10 -top-16 size-56 rounded-full blur-[90px]"
          />
          <div
            aria-hidden
            className="bg-brand-2/25 pointer-events-none absolute -bottom-20 right-0 size-56 rounded-full blur-[90px]"
          />
          <div className="relative flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div className="max-w-md">
              <span className="bg-white/10 text-brand-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold backdrop-blur">
                <Sparkles className="size-3.5" />
                Get more
              </span>
              <h3 className="mt-4 text-xl font-semibold tracking-tight">
                {upgrade.label}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-white/65">
                Unlock higher quotas, more seats, and every feature. Upgrade in
                a few clicks — no migration needed.
              </p>
            </div>
            <div className="shrink-0">{upgradeButton}</div>
          </div>
        </div>
      ) : (
        <div className="from-brand/5 to-brand-2/5 relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 sm:p-8">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-4">
              <div className="bg-brand/10 text-brand flex size-10 items-center justify-center rounded-xl">
                <Sparkles className="size-5" />
              </div>
              <div>
                <h3 className="font-medium tracking-tight">
                  You’re on the top plan
                </h3>
                <p className="text-muted-foreground mt-0.5 text-sm">
                  Need a custom plan or more than{" "}
                  {PLAN_DISPLAY.scale.def.limits.seats} seats? Let’s talk.
                </p>
              </div>
            </div>
            <Button variant="outline" asChild className="shrink-0">
              <Link href="/pricing">
                See all plans
                <ArrowUpRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, active }: { status: string; active: boolean }) {
  if (active) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 font-normal text-emerald-600"
      >
        <span className="mr-1.5 size-1.5 rounded-full bg-emerald-500" />
        {statusLabel(status)}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="font-normal">
      {statusLabel(status)}
    </Badge>
  );
}

function UsageMeter({
  icon: Icon,
  label,
  used,
  limit,
  unit,
  periodEnd,
}: {
  icon: typeof Users;
  label: string;
  used: number;
  limit: number;
  unit: string;
  periodEnd?: number | null;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over = used >= limit && limit > 0;
  const high = pct >= 80 && !over;

  // Color the bar by utilization: brand normally, amber when nearly full,
  // destructive once the quota is hit. Full literal class strings (no string
  // interpolation) so Tailwind's scanner picks them up.
  const indicatorColor = over
    ? "[&_[data-slot=progress-indicator]]:bg-destructive"
    : high
      ? "[&_[data-slot=progress-indicator]]:bg-amber-500"
      : "[&_[data-slot=progress-indicator]]:bg-brand";

  return (
    <div className="bg-muted/40 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`flex size-7 items-center justify-center rounded-lg ${
              over
                ? "bg-destructive/10 text-destructive"
                : "bg-brand/10 text-brand"
            }`}
          >
            <Icon className="size-4" />
          </span>
          <span className="text-sm font-medium">{label}</span>
        </div>
        <span className="text-muted-foreground text-sm tabular-nums">
          <span className="text-foreground font-semibold">
            {used.toLocaleString()}
          </span>{" "}
          / {limit.toLocaleString()}
        </span>
      </div>

      <Progress
        value={pct}
        className={`mt-4 h-2 ${indicatorColor}`}
        aria-label={`${label} usage`}
      />

      <p className="text-muted-foreground mt-2.5 text-xs">
        {Math.max(0, limit - used).toLocaleString()} {unit}
        {limit - used === 1 ? "" : "s"} remaining
        {periodEnd
          ? ` · resets ${new Date(periodEnd).toLocaleDateString()}`
          : ""}
      </p>
    </div>
  );
}
