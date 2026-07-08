import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  getPlan,
  planFeatures,
  planLimits,
  DEFAULT_PLAN_SLUG,
  type Feature,
  type PlanLimits,
} from "./plans";

// ─────────────────────────────────────────────────────────────────────────────
// Entitlements: read the mirrored `subscriptions` + `usage` for a workspace and
// reserve/refund AI-message quota.
//
// Quota uses RESERVE-THEN-CONFIRM (Reconciled-Conflict #14 / P2). The AI reply
// runs in a non-transactional action, so `messages.sendFromVisitor` (a mutation)
// RESERVES quota (increments `usage.aiMessages`) before scheduling the job, and
// `agent/run.ts` REFUNDS (compensating decrement) on action failure.
//
// The usage bucket is keyed on the billing-period anniversary
// (`subscriptions.currentPeriodStart`), NOT a calendar month — this aligns the
// quota window to the billing window. The bucket auto-creates on first reserve;
// there is no cron.
// ─────────────────────────────────────────────────────────────────────────────

export type Entitlement = {
  // null subscription ⇒ treat as Free (no row yet / brand-new org).
  planSlug: string;
  status: Doc<"subscriptions">["status"] | "none";
  active: boolean; // status === "active" (or implicit Free)
  features: Feature[];
  limits: PlanLimits;
  // The billing-period start that keys the usage bucket. Falls back to the
  // workspace creation time when no subscription period is known yet, so a
  // Free org still gets a stable, single bucket.
  periodStart: number;
  currentPeriodEnd: number | null;
};

// Read the subscription mirror for a workspace and resolve the effective plan.
// Absent subscription ⇒ implicit Free, active. We snapshot limits/features from
// the stored row when present (so a mid-cycle plan-def change does not re-gate),
// falling back to the canonical plan definition by slug.
export async function getEntitlement(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
): Promise<Entitlement> {
  // Tolerate a transient/operational duplicate (>1 row for a workspace) instead
  // of throwing on EVERY entitlement read (which would take down billing + the
  // AI path for the tenant). Prefer an active row, else the most recently updated.
  const subs = await ctx.db
    .query("subscriptions")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .collect();
  const sub =
    subs.length <= 1
      ? (subs[0] ?? null)
      : [...subs].sort((a, b) => {
          const aActive = a.status === "active" ? 1 : 0;
          const bActive = b.status === "active" ? 1 : 0;
          if (aActive !== bActive) return bActive - aActive;
          return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
        })[0];

  if (!sub) {
    const plan = getPlan(DEFAULT_PLAN_SLUG);
    return {
      planSlug: plan.slug,
      status: "none",
      active: true, // implicit Free is usable
      features: plan.features,
      limits: plan.limits,
      periodStart: workspace._creationTime,
      currentPeriodEnd: null,
    };
  }

  // Prefer the snapshotted limits/features on the row; fall back to plan-by-slug
  // if a webhook wrote a partial row. Only keep feature strings we recognize.
  const limits: PlanLimits = sub.limits ?? planLimits(sub.planSlug);
  const known = new Set<string>(planFeatures(sub.planSlug));
  const snapshotted = (sub.features ?? []).filter((f): f is Feature =>
    known.has(f),
  );
  const features: Feature[] =
    snapshotted.length > 0 ? snapshotted : planFeatures(sub.planSlug);

  return {
    planSlug: sub.planSlug,
    status: sub.status,
    active: sub.status === "active",
    features,
    limits,
    periodStart: sub.currentPeriodStart ?? workspace._creationTime,
    currentPeriodEnd: sub.currentPeriodEnd ?? null,
  };
}

export function hasFeature(ent: Entitlement, feature: Feature): boolean {
  return ent.features.includes(feature);
}

// Read the current usage bucket for the entitlement's billing period.
// Returns null if the bucket has not been created yet.
async function readUsageBucket(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  periodStart: number,
): Promise<Doc<"usage"> | null> {
  return await ctx.db
    .query("usage")
    .withIndex("by_workspace_period", (q) =>
      q.eq("workspaceId", workspaceId).eq("periodStart", periodStart),
    )
    .unique();
}

export type AiQuotaStatus = {
  used: number;
  limit: number;
  remaining: number;
  periodStart: number;
};

// Read-only quota status (for dashboard display + pre-checks).
export async function getAiQuota(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
): Promise<AiQuotaStatus> {
  const ent = await getEntitlement(ctx, workspace);
  const bucket = await readUsageBucket(ctx, workspace._id, ent.periodStart);
  const used = bucket?.aiMessages ?? 0;
  const limit = ent.limits.aiMessagesPerMonth;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    periodStart: ent.periodStart,
  };
}

// Pure predicate: can this workspace spend one more AI message right now?
// (status active + has the ai_messages feature + under the period cap.)
export async function canSendAiMessage(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
): Promise<{ ok: boolean; reason?: string; quota: AiQuotaStatus }> {
  const ent = await getEntitlement(ctx, workspace);
  const quota = await getAiQuota(ctx, workspace);
  if (!ent.active) {
    return { ok: false, reason: "subscription_inactive", quota };
  }
  if (!hasFeature(ent, "ai_messages")) {
    return { ok: false, reason: "feature_unavailable", quota };
  }
  if (quota.remaining <= 0) {
    return { ok: false, reason: "quota_exhausted", quota };
  }
  return { ok: true, quota };
}

/**
 * RESERVE one AI message (increment the billing-period usage bucket), creating
 * the bucket on first use. Returns `{ ok: false }` (does NOT throw) when the
 * caller is over quota / inactive, so the widget mutation can degrade
 * gracefully ("an agent will follow up") instead of erroring the visitor.
 *
 * Call this from `messages.sendFromVisitor` BEFORE scheduling the agent action.
 */
export async function reserveAiMessage(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
): Promise<
  | { ok: true; periodStart: number }
  | { ok: false; reason: string; quota: AiQuotaStatus }
> {
  const check = await canSendAiMessage(ctx, workspace);
  if (!check.ok) {
    return { ok: false, reason: check.reason ?? "denied", quota: check.quota };
  }

  const ent = await getEntitlement(ctx, workspace);
  const bucket = await readUsageBucket(ctx, workspace._id, ent.periodStart);

  if (bucket) {
    await ctx.db.patch(bucket._id, { aiMessages: bucket.aiMessages + 1 });
  } else {
    await ctx.db.insert("usage", {
      workspaceId: workspace._id,
      clerkOrgId: workspace.clerkOrgId ?? "",
      periodStart: ent.periodStart,
      aiMessages: 1,
      kbDocuments: 0,
    });
  }
  return { ok: true, periodStart: ent.periodStart };
}

/**
 * REFUND one AI message (compensating decrement) for a given period bucket.
 * Called by `agent/run.ts` when the action fails after a reservation. Floors at
 * 0 and is a safe no-op if the bucket is missing. Idempotency is the caller's
 * responsibility (refund exactly once per failed reservation).
 */
export async function refundAiMessage(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  periodStart: number,
): Promise<void> {
  const bucket = await readUsageBucket(ctx, workspaceId, periodStart);
  if (!bucket) return;
  await ctx.db.patch(bucket._id, {
    aiMessages: Math.max(0, bucket.aiMessages - 1),
  });
}

// Throwing variant for internal/admin paths that should hard-fail rather than
// degrade (e.g. a future admin "test the agent" action).
export async function assertCanSendAiMessage(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
): Promise<void> {
  const check = await canSendAiMessage(ctx, workspace);
  if (!check.ok) {
    throw new ConvexError({
      code: "QUOTA_DENIED",
      reason: check.reason ?? "denied",
    });
  }
}
