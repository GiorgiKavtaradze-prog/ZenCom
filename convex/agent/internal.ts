// ─────────────────────────────────────────────────────────────────────────────
// Default-runtime (V8) queries/mutations that the Node agent tools call via
// ctx.runQuery / ctx.runMutation. Keeping the DB work here means the "use node"
// tool/run files never import `ctx.db` and never need a Node runtime for plain
// reads/writes.
//
// All are `internal*` — never client-callable. Every one is workspaceId-scoped
// (the caller is the trusted run action, which resolved the workspace from the
// conversation), and args/returns are fully validated.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

const articleSummary = v.object({
  _id: v.id("helpdeskArticles"),
  title: v.string(),
  slug: v.string(),
  category: v.string(),
  excerpt: v.optional(v.string()),
});

function toArticleSummary(a: Doc<"helpdeskArticles">) {
  return {
    _id: a._id,
    title: a.title,
    slug: a.slug,
    category: a.category,
    excerpt: a.excerpt,
  };
}

// Full-text helpdesk search (published-only), workspace-scoped. Backs both
// search_helpdesk_articles and suggest_articles tools.
export const searchHelpdesk = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(articleSummary),
  handler: async (ctx, { workspaceId, query, category, limit }) => {
    const trimmed = query.trim().slice(0, 200);
    if (trimmed.length === 0) return [];
    const rows = await ctx.db
      .query("helpdeskArticles")
      .withSearchIndex("search_articles", (q) => {
        let s = q
          .search("searchableText", trimmed)
          .eq("workspaceId", workspaceId)
          .eq("status", "published");
        if (category) s = s.eq("category", category);
        return s;
      })
      .take(Math.min(limit ?? 5, 10));
    return rows.map(toArticleSummary);
  },
});

// Popular ("FAQ") published articles for this workspace.
export const getFaq = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  returns: v.array(articleSummary),
  handler: async (ctx, { workspaceId, limit }) => {
    const rows = await ctx.db
      .query("helpdeskArticles")
      .withIndex("by_workspace_popular", (q) =>
        q.eq("workspaceId", workspaceId).eq("isPopular", true),
      )
      .take(50);
    return rows
      .filter((a) => a.status === "published")
      .slice(0, Math.min(limit ?? 5, 10))
      .map(toArticleSummary);
  },
});

// Insert a lead from a captured contact. Deduped by (workspace, visitor) when a
// visitorId is known; otherwise by (workspace, email) to avoid flooding. The
// run action resolves the conversation's visitorId and passes it through.
export const captureLead = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    conversationId: v.id("conversations"),
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
  },
  returns: v.object({ leadId: v.id("leads"), deduped: v.boolean() }),
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.conversationId);
    // Server-resolve the visitorId from the conversation (never model text).
    const visitorId = convo?.visitorId;

    // Dedupe: prefer visitor; fall back to email within the workspace.
    let existing = null;
    if (visitorId) {
      existing = await ctx.db
        .query("leads")
        .withIndex("by_workspace_visitor", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("visitorId", visitorId),
        )
        .first();
    }
    if (!existing) {
      existing = await ctx.db
        .query("leads")
        .withIndex("by_workspace_email", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("email", args.email),
        )
        .first();
    }
    if (existing) {
      // Backfill name/conversation on the existing lead if newly provided.
      const patch: Partial<Doc<"leads">> = {};
      if (args.firstName && !existing.firstName)
        patch.firstName = args.firstName;
      if (args.lastName && !existing.lastName) patch.lastName = args.lastName;
      if (!existing.conversationId)
        patch.conversationId = args.conversationId;
      if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
      return { leadId: existing._id, deduped: true };
    }

    const leadId = await ctx.db.insert("leads", {
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      visitorId,
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      source: "widget",
      status: "new",
      createdAt: Date.now(),
    });
    return { leadId, deduped: false };
  },
});

// Flip the conversation to human mode and post a system message — but ONLY if
// the run is still current (epoch match) and still in AI mode. This is the
// authoritative guard against a stale/late tool call escalating after a takeover
// or a newer visitor message already bumped the epoch.
export const escalateToHuman = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    workspaceId: v.id("workspaces"),
    expectedEpoch: v.number(),
    reason: v.optional(v.string()),
  },
  returns: v.object({ escalated: v.boolean() }),
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.conversationId);
    if (!convo || convo.workspaceId !== args.workspaceId) {
      return { escalated: false };
    }
    // Stale run or already human → no-op (idempotent, no double system message).
    if ((convo.agentRunEpoch ?? 0) !== args.expectedEpoch) {
      return { escalated: false };
    }
    if (convo.mode === "human") {
      return { escalated: false };
    }

    await ctx.db.patch(args.conversationId, {
      mode: "human",
      // Bump epoch so the in-flight run aborts at its next checkpoint.
      agentRunEpoch: (convo.agentRunEpoch ?? 0) + 1,
    });
    await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      author: "system",
      body: "This conversation has been escalated to a human agent. A team member will follow up shortly.",
    });
    return { escalated: true };
  },
});
