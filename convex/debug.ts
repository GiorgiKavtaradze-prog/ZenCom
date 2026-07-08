import { query } from "./_generated/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Empirical claim-propagation check (Phase 0, highest integration risk).
//
// Clerk only emits the org claims (`org_id`/`org_role`/`org_slug`) into the JWT
// when the org is the session's ACTIVE org. Call this from an authed dashboard
// context and confirm `hasActiveOrg === true` with non-null `orgId`/`orgRole`
// BEFORE building anything on top of the org-scoped auth boundary.
//
// The custom claims are read by key off the identity (they are not first-class
// UserIdentity fields).
// ─────────────────────────────────────────────────────────────────────────────
export const whoami = query({
  args: {},
  returns: v.object({
    authenticated: v.boolean(),
    subject: v.union(v.string(), v.null()),
    orgId: v.union(v.string(), v.null()),
    orgRole: v.union(v.string(), v.null()),
    orgSlug: v.union(v.string(), v.null()),
    hasActiveOrg: v.boolean(),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        authenticated: false,
        subject: null,
        orgId: null,
        orgRole: null,
        orgSlug: null,
        hasActiveOrg: false,
      };
    }

    const claims = identity as unknown as Record<string, unknown>;
    const orgId = typeof claims.org_id === "string" ? claims.org_id : null;
    const orgRole =
      typeof claims.org_role === "string" ? claims.org_role : null;
    const orgSlug =
      typeof claims.org_slug === "string" ? claims.org_slug : null;

    return {
      authenticated: true,
      subject: identity.subject,
      orgId,
      orgRole,
      orgSlug,
      hasActiveOrg: orgId !== null,
    };
  },
});
