import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireOrgMember } from "./lib/auth";
import type { Doc } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Notification surfacing (reactive). These are READ-ONLY badge/feed
// queries the dashboard subscribes to for live attention signals:
//   - new UNASSIGNED conversations needing pickup,
//   - recently captured LEADS,
//   - the caller's unread + assigned-to-me counts.
//
// All are scoped to the caller's active-org workspace (hard tenant boundary via
// requireOrgMember). No mutations here — actual email/push delivery
// (onNewLead/onAssigned) is a documented fast-follow (BUILD_PLAN §Observability).
// ─────────────────────────────────────────────────────────────────────────────

const RECENT_LIMIT = 10;

// A conversation appears "unread" for agents when a visitor message arrived
// after the agent read-cursor (shared definition with inbox.ts).
function isUnread(convo: Doc<"conversations">): boolean {
  const lastVisitor = convo.lastVisitorMessageAt ?? 0;
  if (lastVisitor === 0) return false;
  return lastVisitor > (convo.lastReadByAgentAt ?? 0);
}

// countsForMember: the single badge query the dashboard sidebar/header polls.
// Reactive — recomputes live as conversations/leads change. Combines the queue
// signals an agent cares about into one subscription.
export const countsForMember = query({
  args: {},
  returns: v.object({
    unassignedOpen: v.number(), // open + unassigned (needs pickup)
    assignedToMe: v.number(), // conversations I own
    unread: v.number(), // conversations with a newer visitor msg than my read
    newLeads: v.number(), // leads in status "new"
  }),
  handler: async (ctx) => {
    const member = await requireOrgMember(ctx);
    const wsId = member.workspace._id;
    const callerId = member.identity.subject;

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", wsId))
      .collect();

    let unassignedOpen = 0;
    let assignedToMe = 0;
    let unread = 0;
    for (const c of conversations) {
      const status = c.status ?? "open";
      if (!c.assignedClerkUserId && status === "open") unassignedOpen += 1;
      if (c.assignedClerkUserId === callerId) assignedToMe += 1;
      if (isUnread(c)) unread += 1;
    }

    // New leads for this workspace — counted off a status-scoped index so the
    // badge reflects ALL "new" leads (not just those among the newest 200 by
    // date, which could hide older un-actioned leads). Bounded to 100 for a badge.
    const newLeadRows = await ctx.db
      .query("leads")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", wsId).eq("status", "new"),
      )
      .take(100);
    const newLeads = newLeadRows.length;

    return { unassignedOpen, assignedToMe, unread, newLeads };
  },
});

// recentUnassigned: the live feed of conversations awaiting pickup, newest
// first. Drives a "new conversations" notification panel. Uses the
// by_workspace_assignee index (assignedClerkUserId = undefined ⇒ unassigned).
export const recentUnassigned = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("conversations"),
      _creationTime: v.number(),
      visitorName: v.string(),
      lastMessageAt: v.number(),
      mode: v.union(v.literal("ai"), v.literal("human")),
      status: v.union(v.literal("open"), v.literal("closed")),
      unread: v.boolean(),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const member = await requireOrgMember(ctx);
    const take = Math.min(limit ?? RECENT_LIMIT, 50);

    // Over-fetch then drop closed in JS (a closed unassigned conversation isn't
    // "awaiting pickup"). Keeps this feed consistent with the unassignedOpen
    // badge without a table-scanning .filter. (undefined status ⇒ open.)
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_workspace_assignee", (q) =>
        q
          .eq("workspaceId", member.workspace._id)
          .eq("assignedClerkUserId", undefined),
      )
      .order("desc")
      .take(take * 4);

    return rows
      .filter((c) => (c.status ?? "open") !== "closed")
      .slice(0, take)
      .map((c) => ({
      _id: c._id,
      _creationTime: c._creationTime,
      visitorName: c.visitorName,
      lastMessageAt: c.lastMessageAt,
      mode: c.mode ?? "ai",
      status: c.status ?? "open",
      unread: isUnread(c),
    }));
  },
});

// recentLeads: the live feed of newly captured leads, newest first. Drives a
// "new leads" notification panel + the dashboard lead ticker.
export const recentLeads = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("leads"),
      _creationTime: v.number(),
      firstName: v.optional(v.string()),
      lastName: v.optional(v.string()),
      email: v.string(),
      source: v.string(),
      status: v.union(
        v.literal("new"),
        v.literal("contacted"),
        v.literal("closed"),
      ),
      createdAt: v.number(),
      conversationId: v.optional(v.id("conversations")),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const member = await requireOrgMember(ctx);
    const take = Math.min(limit ?? RECENT_LIMIT, 50);

    // by_workspace index is keyed [workspaceId, createdAt] → newest first.
    const rows = await ctx.db
      .query("leads")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", member.workspace._id),
      )
      .order("desc")
      .take(take);

    return rows.map((l) => ({
      _id: l._id,
      _creationTime: l._creationTime,
      firstName: l.firstName,
      lastName: l.lastName,
      email: l.email,
      source: l.source,
      status: l.status,
      createdAt: l.createdAt,
      conversationId: l.conversationId,
    }));
  },
});
