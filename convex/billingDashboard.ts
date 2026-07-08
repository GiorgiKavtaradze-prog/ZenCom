import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireAdmin } from "./lib/auth";
import { getEntitlement, getAiQuota } from "./lib/entitlements";

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard-facing billing overview (Phase 2 billing UI).
//
// Read-only, ADMIN-GATED (requireAdmin) snapshot the Billing page renders:
//   - current plan slug + name + display status (from the mirrored
//     `subscriptions` row, falling back to implicit Free)
//   - seats used (count of active `workspaceMembers`) vs the plan seat limit
//   - AI messages used vs the monthly quota for the current billing period
//   - the billing-period window (so the page can show "resets on …")
//
// The dashboard ALSO uses Clerk `has({ plan | feature })` client-side for the
// live entitlement (session-token source of truth); this query supplies the
// metered counters Clerk does not track (seats-used, ai-messages-used) plus the
// mirrored period window. Both are shown together so a just-completed checkout
// (reflected in `has()` before the webhook mirror catches up) degrades cleanly.
//
// NOTE: this is intentionally a SEPARATE file from the future `convex/billing.ts`
// (reserved for the webhook plan/status mapping) so the two never collide.
// ─────────────────────────────────────────────────────────────────────────────

export const getBillingOverview = query({
  args: {},
  returns: v.object({
    planSlug: v.string(),
    // human display status: "active" | "past_due" | "canceled" | "ended" |
    // "incomplete" | "expired" | "none" (implicit Free, no mirror row yet).
    status: v.string(),
    active: v.boolean(),
    features: v.array(v.string()),
    seats: v.object({
      used: v.number(),
      limit: v.number(),
    }),
    aiMessages: v.object({
      used: v.number(),
      limit: v.number(),
      remaining: v.number(),
    }),
    period: v.object({
      start: v.number(),
      end: v.union(v.number(), v.null()),
    }),
    role: v.union(v.literal("admin"), v.literal("support")),
  }),
  handler: async (ctx) => {
    // Admin-gated: only org admins can view billing. Throws FORBIDDEN otherwise,
    // which the client surfaces as an "admins only" empty state.
    const { workspace, role } = await requireAdmin(ctx);

    const ent = await getEntitlement(ctx, workspace);
    const quota = await getAiQuota(ctx, workspace);

    // Seats used = active members mirrored from Clerk (webhook-synced). Clerk is
    // the enforcement boundary at invite time; this count is for display only.
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();
    const seatsUsed = members.filter((m) => m.status === "active").length;

    return {
      planSlug: ent.planSlug,
      status: ent.status,
      active: ent.active,
      features: ent.features,
      seats: {
        used: seatsUsed,
        limit: ent.limits.seats,
      },
      aiMessages: {
        used: quota.used,
        limit: quota.limit,
        remaining: quota.remaining,
      },
      period: {
        start: ent.periodStart,
        end: ent.currentPeriodEnd,
      },
      role,
    };
  },
});
