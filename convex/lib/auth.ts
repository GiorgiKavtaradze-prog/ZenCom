import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Centralized org-scoped auth boundary (Reconciled-Conflict #4 + #11).
//
// The tenant key is the Clerk Organization id, surfaced on the JWT as the
// custom claim `org_id` (mapped from {{org.id}} in the `convex` JWT template).
// `org_role` ({{org.role}}) carries the full role string (e.g. "org:admin").
//
// Clerk only emits org claims when the org is the session's ACTIVE org. A user
// signed in with no active org gets null claims → we throw a typed
// NO_ACTIVE_ORG error the dashboard catches and redirects to /onboarding.
//
// These claims are CUSTOM (not first-class identity fields), so we read them by
// key off the identity object. `getUserIdentity()` returns them as top-level
// properties named after the claim keys.
// ─────────────────────────────────────────────────────────────────────────────

export type AppRole = "admin" | "support";

export type OrgMemberContext = {
  identity: {
    subject: string; // Clerk user id
    orgId: string; // Clerk organization id (the tenant key)
    orgRole: string; // raw Clerk role string, e.g. "org:admin"
    orgSlug: string | null;
    name: string | null;
    email: string | null;
  };
  workspace: Doc<"workspaces">;
  role: AppRole;
};

// Typed error data for the NO_ACTIVE_ORG branch. The dashboard inspects
// `error.data.code === "NO_ACTIVE_ORG"` to route org-less users to /onboarding.
export type AuthErrorCode =
  | "NOT_AUTHENTICATED"
  | "NO_ACTIVE_ORG"
  | "WORKSPACE_NOT_FOUND"
  | "NOT_A_MEMBER"
  | "FORBIDDEN";

function authError(code: AuthErrorCode, message: string): ConvexError<{
  code: AuthErrorCode;
  message: string;
}> {
  return new ConvexError({ code, message });
}

// Read the custom org claims off the Clerk identity. They are not part of the
// base UserIdentity type, so we widen to a record and pull them by key.
function readOrgClaims(identity: Record<string, unknown>): {
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
} {
  const orgId = typeof identity.org_id === "string" ? identity.org_id : null;
  const orgRole =
    typeof identity.org_role === "string" ? identity.org_role : null;
  const orgSlug =
    typeof identity.org_slug === "string" ? identity.org_slug : null;
  return { orgId, orgRole, orgSlug };
}

// Map the raw Clerk role string to our coarse app role. Clerk's default admin
// role is "org:admin"; everything else (incl. "org:support", custom roles) is
// treated as support. (Reconciled-Conflict #11.)
export function mapRole(rawOrgRole: string | null): AppRole {
  return rawOrgRole === "org:admin" ? "admin" : "support";
}

/**
 * Resolve the active org from the JWT, load its workspace via `by_org`, and
 * load the caller's mirrored membership role. Throws typed errors:
 *   - NOT_AUTHENTICATED  : no identity at all (not signed in)
 *   - NO_ACTIVE_ORG      : signed in, but no active org → dashboard → /onboarding
 *   - WORKSPACE_NOT_FOUND : org exists but the workspace row hasn't been minted
 *                           yet (webhook lag) → caller can retry / run onboarding
 *
 * Role precedence: the mirrored `workspaceMembers.role` (webhook-synced) is the
 * source of truth when present; otherwise we fall back to the JWT `org_role`
 * claim so the very first admin works before the membership webhook lands.
 */
export async function requireOrgMember(
  ctx: QueryCtx,
): Promise<OrgMemberContext> {
  const rawIdentity = await ctx.auth.getUserIdentity();
  if (!rawIdentity) {
    throw authError("NOT_AUTHENTICATED", "Not authenticated.");
  }

  const claims = readOrgClaims(rawIdentity as unknown as Record<string, unknown>);
  if (!claims.orgId) {
    throw authError(
      "NO_ACTIVE_ORG",
      "No active organization on the session. Select or create one.",
    );
  }

  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_org", (q) => q.eq("clerkOrgId", claims.orgId!))
    .unique();
  if (!workspace) {
    throw authError(
      "WORKSPACE_NOT_FOUND",
      "No workspace exists for this organization yet.",
    );
  }

  // Prefer the mirrored membership role; fall back to the JWT claim.
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_org_user", (q) =>
      q.eq("clerkOrgId", claims.orgId!).eq("clerkUserId", rawIdentity.subject),
    )
    .unique();

  const role: AppRole =
    membership && membership.status === "active"
      ? membership.role
      : mapRole(claims.orgRole);

  return {
    identity: {
      subject: rawIdentity.subject,
      orgId: claims.orgId,
      orgRole: claims.orgRole ?? "",
      orgSlug: claims.orgSlug,
      name: (rawIdentity.name as string | undefined) ?? null,
      email: (rawIdentity.email as string | undefined) ?? null,
    },
    workspace,
    role,
  };
}

/**
 * Like `requireOrgMember`, but additionally asserts the caller is an admin.
 * Throws FORBIDDEN otherwise. Used for appearance/settings/KB CRUD/upload-URL/
 * member/billing mutations.
 */
export async function requireAdmin(ctx: QueryCtx): Promise<OrgMemberContext> {
  const member = await requireOrgMember(ctx);
  if (member.role !== "admin") {
    throw authError("FORBIDDEN", "Admin role required for this action.");
  }
  return member;
}

// Dashboard entry point: read-only active-workspace resolver. Returns the
// workspace + caller role, or a discriminated `error` for the org-less /
// not-yet-provisioned states so the client can route without try/catch.
export const getActiveWorkspace = query({
  args: {},
  returns: v.union(
    v.object({
      ok: v.literal(true),
      workspace: v.object({
        _id: v.id("workspaces"),
        _creationTime: v.number(),
        name: v.string(),
        clerkOrgId: v.optional(v.string()),
        slug: v.optional(v.string()),
      }),
      role: v.union(v.literal("admin"), v.literal("support")),
      orgId: v.string(),
    }),
    v.object({
      ok: v.literal(false),
      code: v.union(
        v.literal("NOT_AUTHENTICATED"),
        v.literal("NO_ACTIVE_ORG"),
        v.literal("WORKSPACE_NOT_FOUND"),
      ),
    }),
  ),
  handler: async (ctx) => {
    try {
      const { workspace, role, identity } = await requireOrgMember(ctx);
      return {
        ok: true as const,
        workspace: {
          _id: workspace._id,
          _creationTime: workspace._creationTime,
          name: workspace.name,
          clerkOrgId: workspace.clerkOrgId,
          slug: workspace.slug,
        },
        role,
        orgId: identity.orgId,
      };
    } catch (err) {
      if (err instanceof ConvexError) {
        const code = (err.data as { code?: string }).code;
        if (code === "NOT_AUTHENTICATED") {
          return { ok: false as const, code: "NOT_AUTHENTICATED" as const };
        }
        if (code === "NO_ACTIVE_ORG") {
          return { ok: false as const, code: "NO_ACTIVE_ORG" as const };
        }
        if (code === "WORKSPACE_NOT_FOUND") {
          return { ok: false as const, code: "WORKSPACE_NOT_FOUND" as const };
        }
      }
      throw err;
    }
  },
});
