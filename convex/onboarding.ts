import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Idempotent self-service workspace provisioning for the active org.
//
// The AUTHORITATIVE creator of workspaces is the `organization.created` webhook
// (Reconciled-Conflict #4). This mutation is the belt-and-suspenders path the
// dashboard can call when a freshly-created org's webhook hasn't landed yet (or
// in dev where the webhook may not be wired): given the active org on the JWT,
// it creates the `workspaces` row keyed by `clerkOrgId` + the admin
// `workspaceMembers` row if absent. Safe to call repeatedly.
//
// Reads org claims by key off the identity (custom JWT claims).
// ─────────────────────────────────────────────────────────────────────────────
export const createWorkspaceForOrg = mutation({
  args: {},
  returns: v.object({
    _id: v.id("workspaces"),
    _creationTime: v.number(),
    name: v.string(),
    clerkOrgId: v.optional(v.string()),
    slug: v.optional(v.string()),
    created: v.boolean(), // true if this call minted the workspace row
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
      throw new ConvexError({
        code: "NO_ACTIVE_ORG",
        message: "No active organization on the session.",
      });
    }

    // Idempotent: reuse the existing workspace for this org if present.
    let workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", orgId))
      .unique();

    let created = false;
    if (!workspace) {
      const name =
        (typeof claims.org_name === "string" && claims.org_name) ||
        (typeof identity.name === "string" && identity.name) ||
        orgSlug ||
        "My workspace";
      const id = await ctx.db.insert("workspaces", {
        name,
        ownerClerkUserId: identity.subject, // creator convenience, NOT the auth boundary
        clerkOrgId: orgId,
        slug: orgSlug,
      });
      workspace = (await ctx.db.get(id))!;
      created = true;
    }

    // Ensure an admin membership row for the caller (idempotent by org+user).
    const existingMember = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("clerkOrgId", orgId).eq("clerkUserId", identity.subject),
      )
      .unique();

    if (!existingMember) {
      await ctx.db.insert("workspaceMembers", {
        workspaceId: workspace._id,
        clerkOrgId: orgId,
        clerkUserId: identity.subject,
        // The self-provisioning caller minted (or owns) the org → seed as admin.
        // The membership webhook reconciles the authoritative role afterward.
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

    return {
      _id: workspace._id,
      _creationTime: workspace._creationTime,
      name: workspace.name,
      clerkOrgId: workspace.clerkOrgId,
      slug: workspace.slug,
      created,
    };
  },
});
