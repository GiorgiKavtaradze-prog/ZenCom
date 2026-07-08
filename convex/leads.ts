import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc } from "./_generated/dataModel";
import { requireOrgMember } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — DASHBOARD leads (authed). All functions are workspace-scoped via
// `requireOrgMember` (any active team member can view/manage leads — leads are
// not role-siloed in the MVP; mirrors inbox visibility). The HARD boundary is
// the caller's active-org workspace: no member can read another org's leads.
//
// Reads use the `by_workspace` index (ordered by createdAt desc) and never
// `.filter()` for the status narrowing — for a small lead volume we page the
// index and narrow in memory; the status filter is a UI convenience, not a hot
// query path. The CSV export query caps its scan to stay well under the
// per-function read limit.
// ─────────────────────────────────────────────────────────────────────────────

const leadStatus = v.union(
  v.literal("new"),
  v.literal("contacted"),
  v.literal("closed"),
);

const leadDoc = v.object({
  _id: v.id("leads"),
  _creationTime: v.number(),
  workspaceId: v.id("workspaces"),
  conversationId: v.optional(v.id("conversations")),
  visitorId: v.optional(v.string()),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  email: v.string(),
  phone: v.optional(v.string()),
  source: v.string(),
  status: leadStatus,
  createdAt: v.number(),
});

function toLeadDoc(row: Doc<"leads">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    visitorId: row.visitorId,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt,
  };
}

const CSV_EXPORT_CAP = 5000; // bounded scan; well under the ~16k read limit

// DASHBOARD (authed): paginated, newest-first list of leads for the caller's
// active-org workspace. Optional status / source filters and a free-text search
// over name + email are applied in-memory over the page (lead volume is small;
// this keeps a single index path). `status: undefined` = all statuses.
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(leadStatus),
    source: v.optional(v.string()),
    search: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(leadDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { paginationOpts, status, source, search }) => {
    const { workspace } = await requireOrgMember(ctx);

    // Route the status filter through an index so its pagination stays
    // consistent (page size + cursor agree, no dropped/empty pages). Source +
    // free-text search are applied in-memory over the page — lead volume per
    // workspace is small so this is bounded; with those filters very active a
    // page may return fewer rows than requested.
    const result = status
      ? await ctx.db
          .query("leads")
          .withIndex("by_workspace_status", (q) =>
            q.eq("workspaceId", workspace._id).eq("status", status),
          )
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("leads")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
          .order("desc")
          .paginate(paginationOpts);

    const needle = search?.trim().toLowerCase();
    const page = result.page
      .filter((row) => (source ? row.source === source : true))
      .filter((row) => {
        if (!needle) return true;
        const hay = [
          row.firstName ?? "",
          row.lastName ?? "",
          row.email,
          row.phone ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      })
      .map(toLeadDoc);

    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

// DASHBOARD (authed): load one lead, tenant-checked.
export const get = query({
  args: { leadId: v.id("leads") },
  returns: v.union(leadDoc, v.null()),
  handler: async (ctx, { leadId }) => {
    const { workspace } = await requireOrgMember(ctx);
    const row = await ctx.db.get(leadId);
    if (!row || row.workspaceId !== workspace._id) return null;
    return toLeadDoc(row);
  },
});

// DASHBOARD (authed): advance a lead's status (new → contacted → closed, or
// back). Tenant-checked.
export const updateStatus = mutation({
  args: {
    leadId: v.id("leads"),
    status: leadStatus,
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, { leadId, status }) => {
    const { workspace } = await requireOrgMember(ctx);
    const row = await ctx.db.get(leadId);
    if (!row || row.workspaceId !== workspace._id) {
      throw new ConvexError({
        code: "UNKNOWN_LEAD",
        message: "Lead not found.",
      });
    }
    await ctx.db.patch(leadId, { status });
    return { ok: true as const };
  },
});

// DASHBOARD (authed): rows for CSV export — newest-first, optionally filtered by
// status, capped at CSV_EXPORT_CAP rows. The client builds the CSV (and handles
// escaping/download); we just return the structured rows so a server change to
// the column set is a one-line edit here.
export const forExport = query({
  args: {
    status: v.optional(leadStatus),
  },
  returns: v.object({
    rows: v.array(leadDoc),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { status }) => {
    const { workspace } = await requireOrgMember(ctx);

    // Take one extra to detect truncation without a second query.
    const raw = await ctx.db
      .query("leads")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .order("desc")
      .take(CSV_EXPORT_CAP + 1);

    const truncated = raw.length > CSV_EXPORT_CAP;
    const rows = raw
      .slice(0, CSV_EXPORT_CAP)
      .filter((row) => (status ? row.status === status : true))
      .map(toLeadDoc);

    return { rows, truncated };
  },
});
