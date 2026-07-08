import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { requireOrgMember } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Tenant re-key (Phase 1): the auth boundary is now Clerk-org membership, NOT
// `ownerClerkUserId`. Workspace CREATION is owned by the organization.created
// webhook (convex/clerkWebhooks.ts) with `onboarding.createWorkspaceForOrg` as
// the idempotent self-service fallback. The old `ensureForCurrentUser` mutation
// is removed; the dashboard now uses the read-only resolvers below
// (`getActiveWorkspace` lives in lib/auth.ts as the canonical entry point).
// ─────────────────────────────────────────────────────────────────────────────

// Re-export the canonical dashboard entry point so existing imports of
// `api.workspaces.getActiveWorkspace` keep working.
export { getActiveWorkspace } from "./lib/auth";

// BACKWARD-COMPAT shim. The dashboard still calls `ensureForCurrentUser` on load
// (app/(app)/dashboard/page.tsx, setup/page.tsx). It now resolves on the ORG
// boundary instead of `ownerClerkUserId`: it returns the active org's workspace,
// idempotently minting it (+ the admin membership) if the webhook hasn't landed.
// TODO(human): migrate the dashboard to `getActiveWorkspace` (read-only) +
// `onboarding.createWorkspaceForOrg`, then delete this shim.
export const ensureForCurrentUser = mutation({
  args: {},
  returns: v.object({
    _id: v.id("workspaces"),
    _creationTime: v.number(),
    name: v.string(),
    clerkOrgId: v.optional(v.string()),
    slug: v.optional(v.string()),
    ownerClerkUserId: v.string(),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "NOT_AUTHENTICATED",
        message: "Not authenticated.",
      });
    }
    const claims = identity as unknown as Record<string, unknown>;
    const orgId = typeof claims.org_id === "string" ? claims.org_id : null;
    const orgSlug =
      typeof claims.org_slug === "string" ? claims.org_slug : undefined;
    if (!orgId) {
      // No active org → the dashboard must route to /onboarding. Surface the
      // typed code rather than silently creating an owner-keyed workspace.
      throw new ConvexError({
        code: "NO_ACTIVE_ORG",
        message: "No active organization on the session.",
      });
    }

    let ws = await ctx.db
      .query("workspaces")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", orgId))
      .unique();

    if (!ws) {
      const name =
        (typeof claims.org_name === "string" && claims.org_name) ||
        (typeof identity.name === "string" && identity.name) ||
        orgSlug ||
        "My workspace";
      const id = await ctx.db.insert("workspaces", {
        name,
        ownerClerkUserId: identity.subject,
        clerkOrgId: orgId,
        slug: orgSlug,
      });
      ws = (await ctx.db.get(id))!;

      // Seed the admin membership idempotently.
      const existingMember = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_org_user", (q) =>
          q.eq("clerkOrgId", orgId).eq("clerkUserId", identity.subject),
        )
        .unique();
      if (!existingMember) {
        await ctx.db.insert("workspaceMembers", {
          workspaceId: ws._id,
          clerkOrgId: orgId,
          clerkUserId: identity.subject,
          role: "admin",
          name:
            (typeof identity.name === "string" && identity.name) ||
            (typeof identity.email === "string" && identity.email) ||
            "Admin",
          email:
            typeof identity.email === "string" ? identity.email : undefined,
          status: "active",
        });
      }
    }

    return {
      _id: ws._id,
      _creationTime: ws._creationTime,
      name: ws.name,
      clerkOrgId: ws.clerkOrgId,
      slug: ws.slug,
      ownerClerkUserId: ws.ownerClerkUserId,
    };
  },
});

// Dashboard (authed): resolve the workspace for an explicit org id, asserting
// the caller is a member of THAT org (defense-in-depth; normally the caller's
// active org == this org). Returns null if no workspace exists for the org yet.
export const getByOrg = query({
  args: { clerkOrgId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("workspaces"),
      _creationTime: v.number(),
      name: v.string(),
      clerkOrgId: v.optional(v.string()),
      slug: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, { clerkOrgId }) => {
    const { identity } = await requireOrgMember(ctx);
    // Only let a caller read the org they are actively scoped to.
    if (identity.orgId !== clerkOrgId) {
      return null;
    }
    const ws = await ctx.db
      .query("workspaces")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", clerkOrgId))
      .unique();
    if (!ws) return null;
    return {
      _id: ws._id,
      _creationTime: ws._creationTime,
      name: ws.name,
      clerkOrgId: ws.clerkOrgId,
      slug: ws.slug,
    };
  },
});

// PUBLIC (widget): validate an app_id and surface the workspace name.
// Signature UNCHANGED — the live widget depends on this.
export const getPublic = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.object({ _id: v.id("workspaces"), name: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { workspaceId }) => {
    const ws = await ctx.db.get(workspaceId);
    if (!ws) return null;
    // Leak guard: never expose ownerClerkUserId / clerkOrgId on the public path.
    return { _id: ws._id, name: ws.name };
  },
});
