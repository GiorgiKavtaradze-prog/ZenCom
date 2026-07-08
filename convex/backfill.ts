import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 idempotent, prod-safe backfill: attach pre-existing owner-keyed
// workspaces (created before the org re-key) to a Clerk org.
//
// Dev is near-greenfield, so this is a SAFE NO-OP when nothing needs attaching:
// any workspace that already has `clerkOrgId` set is skipped. Conversations are
// implicitly attached because they reference `workspaceId` (unchanged) — once
// the workspace has `clerkOrgId`, `requireOrgMember`'s `by_org` lookup resolves
// the same workspace, so existing widget conversations keep loading.
//
// Because creating a Clerk org requires the Clerk backend SDK (an external call
// not available inside a Convex mutation), the actual org id is supplied by the
// caller. Run order in practice:
//   1. `listOrphans` (dry-run) → see what would be attached.
//   2. For each orphan, create/identify the Clerk org out-of-band, then call
//      `attachWorkspaceToOrg` with the mapping. Idempotent + re-runnable.
//
// internalMutation only — never client-reachable.
// ─────────────────────────────────────────────────────────────────────────────

// Dry-run: list owner-keyed workspaces that still lack a `clerkOrgId`. Returns
// an empty array when there is nothing to backfill (the common dev case).
export const listOrphans = internalMutation({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("workspaces"),
      name: v.string(),
      ownerClerkUserId: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const all = await ctx.db.query("workspaces").collect();
    return all
      .filter((w) => !w.clerkOrgId)
      .map((w) => ({
        _id: w._id,
        name: w.name,
        ownerClerkUserId: w.ownerClerkUserId,
      }));
  },
});

// Idempotent attach: set `clerkOrgId` (+ optional slug) on one workspace and
// seed the admin membership + default widget rows if absent. Safe to re-run:
// - if the workspace already has THIS clerkOrgId, it's a no-op patch;
// - if it has a DIFFERENT clerkOrgId, we refuse (avoid silently re-tenanting);
// - membership / widget rows are created only when missing.
export const attachWorkspaceToOrg = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    clerkOrgId: v.string(),
    slug: v.optional(v.string()),
    adminClerkUserId: v.optional(v.string()), // defaults to ownerClerkUserId
    adminName: v.optional(v.string()),
    adminEmail: v.optional(v.string()),
  },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    attached: v.boolean(), // true if this call set clerkOrgId (vs already set)
    memberSeeded: v.boolean(),
    widgetSeeded: v.boolean(),
    skippedReason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const ws = await ctx.db.get(args.workspaceId);
    if (!ws) {
      return {
        workspaceId: args.workspaceId,
        attached: false,
        memberSeeded: false,
        widgetSeeded: false,
        skippedReason: "workspace_not_found",
      };
    }

    if (ws.clerkOrgId && ws.clerkOrgId !== args.clerkOrgId) {
      // Already tenanted to a different org → refuse to re-key silently.
      return {
        workspaceId: args.workspaceId,
        attached: false,
        memberSeeded: false,
        widgetSeeded: false,
        skippedReason: "already_attached_to_other_org",
      };
    }

    let attached = false;
    if (!ws.clerkOrgId) {
      await ctx.db.patch(args.workspaceId, {
        clerkOrgId: args.clerkOrgId,
        slug: args.slug ?? ws.slug,
      });
      attached = true;
    }

    // Seed admin membership if absent (idempotent by org+user).
    const adminUserId = args.adminClerkUserId ?? ws.ownerClerkUserId;
    let memberSeeded = false;
    if (adminUserId) {
      const existingMember = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_org_user", (q) =>
          q.eq("clerkOrgId", args.clerkOrgId).eq("clerkUserId", adminUserId),
        )
        .unique();
      if (!existingMember) {
        await ctx.db.insert("workspaceMembers", {
          workspaceId: args.workspaceId,
          clerkOrgId: args.clerkOrgId,
          clerkUserId: adminUserId,
          role: "admin",
          name: args.adminName ?? ws.name ?? "Admin",
          email: args.adminEmail,
          status: "active",
        });
        memberSeeded = true;
      }
    }

    // Seed default widget rows if absent (one per workspace).
    let widgetSeeded = false;
    const appearance = await ctx.db
      .query("widgetAppearance")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", args.workspaceId),
      )
      .unique();
    if (!appearance) {
      await ctx.db.insert("widgetAppearance", {
        workspaceId: args.workspaceId,
        themeColor: "#4f46e5",
        buttonColor: "#4f46e5",
        cornerRadius: 16,
        title: ws.name ?? "Chat with us",
        titleColor: "#ffffff",
        position: "bottom-right",
        bottomMargin: 20,
        sideMargin: 20,
        notificationSound: true,
      });
      widgetSeeded = true;
    }
    const settings = await ctx.db
      .query("widgetSettings")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", args.workspaceId),
      )
      .unique();
    if (!settings) {
      await ctx.db.insert("widgetSettings", {
        workspaceId: args.workspaceId,
        proactiveMessage: {
          enabled: false,
          delaySeconds: 15,
          text: "Hi there! 👋 Need a hand with anything?",
        },
        leadCapture: {
          enabled: false,
          requiredFields: ["email"],
        },
        faqEnabled: true,
      });
      widgetSeeded = true;
    }

    return {
      workspaceId: args.workspaceId,
      attached,
      memberSeeded,
      widgetSeeded,
    };
  },
});
