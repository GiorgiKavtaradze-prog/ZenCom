import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { requireOrgMember } from "./lib/auth";
import { rateLimiter, rlKey } from "./lib/ratelimit";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 re-key: DASHBOARD (authed) conversation functions authorize via
// `requireOrgMember` and resolve the workspace by ORG, not by
// `ws.ownerClerkUserId === identity.subject`. The PUBLIC widget create path
// stays workspaceId-scoped and signature-unchanged (the live widget depends on
// `getOrCreateForVisitor`).
// ─────────────────────────────────────────────────────────────────────────────

// DASHBOARD (authed): list conversations for the caller's active-org workspace.
// `workspaceId` is still accepted (signature-compatible) but is cross-checked
// against the caller's org-resolved workspace — a member can only read their
// own org's conversations.
const conversationDoc = v.object({
  _id: v.id("conversations"),
  _creationTime: v.number(),
  workspaceId: v.id("workspaces"),
  visitorId: v.string(),
  visitorName: v.string(),
  lastMessageAt: v.number(),
  mode: v.optional(v.union(v.literal("ai"), v.literal("human"))),
  status: v.optional(v.union(v.literal("open"), v.literal("closed"))),
  assignedClerkUserId: v.optional(v.string()),
  assignedAt: v.optional(v.number()),
  lastVisitorMessageAt: v.optional(v.number()),
  lastReadByAgentAt: v.optional(v.number()),
  pendingAgentJobId: v.optional(v.id("_scheduled_functions")),
  agentRunEpoch: v.optional(v.number()),
  threadId: v.optional(v.string()),
});

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(conversationDoc),
  handler: async (ctx, { workspaceId }) => {
    const { workspace } = await requireOrgMember(ctx);
    if (workspace._id !== workspaceId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Not authorized for this workspace.",
      });
    }

    return await ctx.db
      .query("conversations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .order("desc")
      .collect();
  },
});

// WIDGET (public): list THIS visitor's conversations for the widget's chat
// history home. Scoped by (workspaceId, visitorId) — the visitorId is the
// localStorage-minted anonymous identity, so a visitor only ever sees their own
// threads. Returns a SAFE projection (no internal ids/assignment) plus a short
// preview of the last message and its author, newest first. Conversations with
// no messages yet (abandoned "new chat" drafts) are omitted so the list stays
// clean.
export const listForVisitor = query({
  args: { workspaceId: v.id("workspaces"), visitorId: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("conversations"),
      lastMessageAt: v.number(),
      status: v.union(v.literal("open"), v.literal("closed")),
      mode: v.union(v.literal("ai"), v.literal("human")),
      preview: v.string(),
      lastAuthor: v.union(
        v.literal("visitor"),
        v.literal("agent"),
        v.literal("system"),
      ),
    }),
  ),
  handler: async (ctx, { workspaceId, visitorId }) => {
    const ws = await ctx.db.get(workspaceId);
    if (!ws) throw new ConvexError({ code: "UNKNOWN_WORKSPACE" });

    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_workspace_visitor", (q) =>
        q.eq("workspaceId", workspaceId).eq("visitorId", visitorId),
      )
      .collect();

    convos.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

    const rows = await Promise.all(
      convos.slice(0, 20).map(async (c) => {
        const last = await ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
          .order("desc")
          .first();
        if (!last) return null; // skip empty drafts
        return {
          _id: c._id,
          lastMessageAt: c.lastMessageAt,
          status: c.status ?? ("open" as const),
          mode: c.mode ?? ("ai" as const),
          preview: last.body.slice(0, 140),
          lastAuthor: last.author,
        };
      }),
    );

    return rows.filter((r): r is NonNullable<typeof r> => r !== null);
  },
});

// WIDGET (public): start a NEW conversation for this visitor. Rate-limited
// (conversationCreate bucket) to backstop row churn. To avoid piling up empty
// drafts when a visitor taps "New conversation" repeatedly without sending, we
// reuse the visitor's most recent message-less conversation if one exists.
export const createForVisitor = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    visitorId: v.string(),
    visitorName: v.string(),
  },
  returns: v.id("conversations"),
  handler: async (ctx, { workspaceId, visitorId, visitorName }) => {
    const ws = await ctx.db.get(workspaceId);
    if (!ws) throw new ConvexError({ code: "UNKNOWN_WORKSPACE" });

    await rateLimiter.limit(ctx, "conversationCreate", {
      key: rlKey(workspaceId, visitorId),
      throws: true,
    });

    // Reuse an existing empty (no-message) conversation rather than churning a
    // new row — keeps the history list free of blank entries. A blank draft is
    // always the newest row, so only the most recent conversation needs probing;
    // this is bounded (avoids scanning a visitor's entire history on each call).
    const newest = await ctx.db
      .query("conversations")
      .withIndex("by_workspace_visitor", (q) =>
        q.eq("workspaceId", workspaceId).eq("visitorId", visitorId),
      )
      .order("desc")
      .first();
    if (newest) {
      const anyMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", newest._id))
        .first();
      if (!anyMsg) return newest._id;
    }

    const now = Date.now();
    return await ctx.db.insert("conversations", {
      workspaceId,
      visitorId,
      visitorName,
      lastMessageAt: now,
      mode: "ai", // default: AI answers first (set in code, schema stays optional)
      status: "open",
    });
  },
});

// WIDGET (public): find or create this visitor's MOST RECENT conversation.
// Retained for backward compatibility (e.g. proactive openers that want "the
// current chat"). Multi-conversation safe: returns the newest existing thread
// (no longer `.unique()`, which would throw once a visitor has several), else
// creates one. Validates the workspace exists.
export const getOrCreateForVisitor = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    visitorId: v.string(),
    visitorName: v.string(),
  },
  returns: v.id("conversations"),
  handler: async (ctx, { workspaceId, visitorId, visitorName }) => {
    const ws = await ctx.db.get(workspaceId);
    if (!ws) throw new ConvexError({ code: "UNKNOWN_WORKSPACE" });

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_workspace_visitor", (q) =>
        q.eq("workspaceId", workspaceId).eq("visitorId", visitorId),
      )
      .order("desc")
      .first();
    if (existing) return existing._id;

    const now = Date.now();
    return await ctx.db.insert("conversations", {
      workspaceId,
      visitorId,
      visitorName,
      lastMessageAt: now,
      mode: "ai", // default: AI answers first (set in code, schema stays optional)
      status: "open",
    });
  },
});
