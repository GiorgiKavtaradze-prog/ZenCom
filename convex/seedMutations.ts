// ─────────────────────────────────────────────────────────────────────────────
// Default-runtime (V8) internal mutations backing the demo seed (seed.ts).
//
// A Node action cannot touch ctx.db directly, so every DB write the seed needs
// is exposed here as an internalMutation. These are SEED-ONLY helpers — never
// part of the live app surface — and write to the real tenant tables exactly as
// the production paths would (same field shapes, same indexes).
//
// `searchableText` for articles is rebuilt here with the same stripMarkdown +
// buildSearchableText logic articles.ts uses, so the helpdesk search index over
// seeded articles behaves identically to hand-authored ones.
// ─────────────────────────────────────────────────────────────────────────────

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

// Mirror of articles.ts stripMarkdown / buildSearchableText (kept local to avoid
// importing the Node embedding file). Pure string ops — V8-safe.
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>#~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchableText(
  title: string,
  category: string,
  excerpt: string | undefined,
  bodyMarkdown: string,
): string {
  return [title, category, excerpt ?? "", stripMarkdown(bodyMarkdown)]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1_000_000);
}

// ── 1) Find-or-create workspace, member, idempotency gate, optional reset ────

export const prepare = internalMutation({
  args: {
    clerkOrgId: v.string(),
    clerkUserId: v.string(),
    ownerName: v.string(),
    workspaceName: v.string(),
    slug: v.string(),
    reset: v.boolean(),
  },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    alreadySeeded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Find-or-create the workspace keyed by clerkOrgId.
    let workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    let workspaceId: Id<"workspaces">;
    if (workspace) {
      workspaceId = workspace._id;
      // Keep name/slug/owner in sync (cheap, idempotent).
      await ctx.db.patch(workspaceId, {
        name: args.workspaceName,
        ownerClerkUserId: args.clerkUserId,
        slug: args.slug,
      });
    } else {
      workspaceId = await ctx.db.insert("workspaces", {
        name: args.workspaceName,
        ownerClerkUserId: args.clerkUserId,
        clerkOrgId: args.clerkOrgId,
        slug: args.slug,
      });
    }

    // Upsert the admin membership row.
    const member = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("clerkUserId", args.clerkUserId),
      )
      .unique();
    if (member) {
      await ctx.db.patch(member._id, {
        workspaceId,
        role: "admin",
        name: args.ownerName,
        status: "active",
      });
    } else {
      await ctx.db.insert("workspaceMembers", {
        workspaceId,
        clerkOrgId: args.clerkOrgId,
        clerkUserId: args.clerkUserId,
        role: "admin",
        name: args.ownerName,
        status: "active",
      });
    }

    // Idempotency probe: does the workspace already have conversations?
    const existingConv = await ctx.db
      .query("conversations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .first();
    const alreadySeeded = existingConv !== null;

    if (args.reset) {
      await wipeWorkspaceSeedData(ctx, workspaceId);
    }

    return { workspaceId, alreadySeeded };
  },
});

// Delete prior seeded conversations/messages/leads/articles/chunks/crawl jobs.
async function wipeWorkspaceSeedData(
  ctx: { db: any },
  workspaceId: Id<"workspaces">,
): Promise<void> {
  // Conversations + their messages.
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const conv of conversations) {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q: any) =>
        q.eq("conversationId", conv._id),
      )
      .collect();
    for (const m of msgs) await ctx.db.delete(m._id);
    await ctx.db.delete(conv._id);
  }

  // Leads.
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const l of leads) await ctx.db.delete(l._id);

  // Articles + their knowledge chunks.
  const articles = await ctx.db
    .query("helpdeskArticles")
    .withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const a of articles) {
    const chunks = await ctx.db
      .query("knowledgeChunks")
      .withIndex("by_article", (q: any) => q.eq("articleId", a._id))
      .collect();
    for (const c of chunks) await ctx.db.delete(c._id);
    await ctx.db.delete(a._id);
  }

  // Any remaining knowledge chunks for the workspace (e.g. crawl/file source).
  for (const source of ["crawl", "article", "file"] as const) {
    const rows = await ctx.db
      .query("knowledgeChunks")
      .withIndex("by_workspace_source", (q: any) =>
        q.eq("workspaceId", workspaceId).eq("source", source),
      )
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  }

  // Crawl jobs.
  const crawls = await ctx.db
    .query("crawlJobs")
    .withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const cj of crawls) await ctx.db.delete(cj._id);
}

// ── 2) Billing mirror + usage meter + widget config ──────────────────────────

export const config = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    clerkOrgId: v.string(),
    planSlug: v.string(),
    features: v.array(v.string()),
    limits: v.object({
      aiMessagesPerMonth: v.number(),
      kbDocuments: v.number(),
      crawlPages: v.number(),
      seats: v.number(),
    }),
    periodStart: v.number(),
    periodEnd: v.number(),
    aiMessagesUsed: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    // subscriptions (one per workspace) — upsert.
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    const subFields = {
      workspaceId: args.workspaceId,
      clerkOrgId: args.clerkOrgId,
      subscriptionId: `seed_sub_${args.workspaceId}`,
      planSlug: args.planSlug,
      status: "active" as const,
      seats: args.limits.seats,
      features: args.features,
      limits: args.limits,
      currentPeriodStart: args.periodStart,
      currentPeriodEnd: args.periodEnd,
      updatedAt: now,
    };
    if (sub) {
      await ctx.db.patch(sub._id, subFields);
    } else {
      await ctx.db.insert("subscriptions", subFields);
    }

    // usage (keyed by workspace + periodStart) — upsert.
    const usage = await ctx.db
      .query("usage")
      .withIndex("by_workspace_period", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("periodStart", args.periodStart),
      )
      .unique();
    const usageFields = {
      workspaceId: args.workspaceId,
      clerkOrgId: args.clerkOrgId,
      periodStart: args.periodStart,
      aiMessages: args.aiMessagesUsed,
      kbDocuments: 6,
    };
    if (usage) {
      await ctx.db.patch(usage._id, usageFields);
    } else {
      await ctx.db.insert("usage", usageFields);
    }

    // widgetAppearance — upsert.
    const appearance = await ctx.db
      .query("widgetAppearance")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    const appearanceFields = {
      workspaceId: args.workspaceId,
      themeColor: "#4F46E5",
      buttonColor: "#4F46E5",
      titleColor: "#FFFFFF",
      cornerRadius: 16,
      title: "Chat with us",
      position: "bottom-right" as const,
      bottomMargin: 20,
      sideMargin: 20,
      notificationSound: true,
    };
    if (appearance) {
      await ctx.db.patch(appearance._id, appearanceFields);
    } else {
      await ctx.db.insert("widgetAppearance", appearanceFields);
    }

    // widgetSettings — upsert.
    const settings = await ctx.db
      .query("widgetSettings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    const settingsFields = {
      workspaceId: args.workspaceId,
      proactiveMessage: {
        enabled: true,
        delaySeconds: 20,
        text: "👋 Hey! Need help getting set up? Ask me anything.",
      },
      leadCapture: {
        enabled: true,
        requiredFields: ["firstName", "email"] as Array<
          "firstName" | "lastName" | "email" | "phone"
        >,
      },
      faqEnabled: true,
    };
    if (settings) {
      await ctx.db.patch(settings._id, settingsFields);
    } else {
      await ctx.db.insert("widgetSettings", settingsFields);
    }

    return null;
  },
});

// ── 3) Articles + their knowledge chunks ─────────────────────────────────────

export const insertArticle = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    clerkUserId: v.string(),
    title: v.string(),
    slug: v.string(),
    category: v.string(),
    excerpt: v.string(),
    bodyMarkdown: v.string(),
    isPopular: v.boolean(),
    order: v.number(),
  },
  returns: v.id("helpdeskArticles"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("helpdeskArticles", {
      workspaceId: args.workspaceId,
      title: args.title,
      slug: args.slug,
      category: args.category,
      bodyMarkdown: args.bodyMarkdown,
      excerpt: args.excerpt,
      searchableText: buildSearchableText(
        args.title,
        args.category,
        args.excerpt,
        args.bodyMarkdown,
      ),
      status: "published",
      isPopular: args.isPopular,
      order: args.order,
      authorClerkUserId: args.clerkUserId,
      updatedAt: now,
    });
  },
});

export const writeArticleChunks = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    articleId: v.id("helpdeskArticles"),
    title: v.string(),
    chunks: v.array(
      v.object({
        text: v.string(),
        embedding: v.array(v.float64()),
        tokenCount: v.number(),
        contentHash: v.string(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    let i = 0;
    for (const chunk of args.chunks) {
      await ctx.db.insert("knowledgeChunks", {
        workspaceId: args.workspaceId,
        source: "article",
        articleId: args.articleId,
        title: args.title,
        text: chunk.text,
        chunkIndex: i,
        tokenCount: chunk.tokenCount,
        contentHash: chunk.contentHash,
        embedding: chunk.embedding,
      });
      i += 1;
    }
    return i;
  },
});

// ── 4) Conversations + messages ──────────────────────────────────────────────

const messageInput = v.object({
  author: v.union(
    v.literal("visitor"),
    v.literal("agent"),
    v.literal("system"),
  ),
  body: v.string(),
  isAi: v.boolean(),
  createdAt: v.number(),
  citations: v.optional(
    v.array(
      v.object({
        articleId: v.id("helpdeskArticles"),
        title: v.string(),
        slug: v.string(),
      }),
    ),
  ),
});

export const writeConversations = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    assigneeClerkUserId: v.string(),
    conversations: v.array(
      v.object({
        visitorName: v.string(),
        mode: v.union(v.literal("ai"), v.literal("human")),
        status: v.union(v.literal("open"), v.literal("closed")),
        assignToSonny: v.boolean(),
        messages: v.array(messageInput),
      }),
    ),
  },
  returns: v.object({
    conversationIds: v.array(v.id("conversations")),
    conversationCount: v.number(),
    messageCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const conversationIds: Id<"conversations">[] = [];
    let messageCount = 0;

    for (let ci = 0; ci < args.conversations.length; ci++) {
      const conv = args.conversations[ci];
      const visitorId = `seed_visitor_${args.workspaceId}_${ci}`;

      // Derive timing from the message stream.
      const times = conv.messages.map((m) => m.createdAt);
      const lastMessageAt = times.length ? Math.max(...times) : Date.now();
      const visitorTimes = conv.messages
        .filter((m) => m.author === "visitor")
        .map((m) => m.createdAt);
      const lastVisitorMessageAt = visitorTimes.length
        ? Math.max(...visitorTimes)
        : undefined;

      const conversationId = await ctx.db.insert("conversations", {
        workspaceId: args.workspaceId,
        visitorId,
        visitorName: conv.visitorName,
        lastMessageAt,
        mode: conv.mode,
        status: conv.status,
        assignedClerkUserId: conv.assignToSonny
          ? args.assigneeClerkUserId
          : undefined,
        assignedAt: conv.assignToSonny
          ? // first system "joined" message time, else first message time
            (conv.messages.find((m) => m.author === "system")?.createdAt ??
            times[0])
          : undefined,
        lastVisitorMessageAt,
        lastReadByAgentAt: conv.assignToSonny ? lastMessageAt : undefined,
      });
      conversationIds.push(conversationId);

      for (const m of conv.messages) {
        await ctx.db.insert("messages", {
          conversationId,
          author: m.author,
          body: m.body,
          isAi: m.author === "agent" ? m.isAi : undefined,
          authorClerkUserId:
            m.author === "agent" && !m.isAi
              ? args.assigneeClerkUserId
              : undefined,
          citations:
            m.citations && m.citations.length > 0
              ? m.citations.map((c) => ({
                  title: c.title,
                  url: `/help/${c.slug}`,
                }))
              : undefined,
        });
        messageCount += 1;
      }
    }

    return {
      conversationIds,
      conversationCount: conversationIds.length,
      messageCount,
    };
  },
});

// ── 5) Leads ─────────────────────────────────────────────────────────────────

export const writeLeads = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    conversationIds: v.array(v.id("conversations")),
    leads: v.array(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.string(),
        status: v.union(
          v.literal("new"),
          v.literal("contacted"),
          v.literal("closed"),
        ),
        createdAt: v.number(),
        conversationIndex: v.optional(v.number()),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    let count = 0;
    for (const lead of args.leads) {
      const conversationId =
        lead.conversationIndex !== undefined
          ? args.conversationIds[lead.conversationIndex]
          : undefined;
      await ctx.db.insert("leads", {
        workspaceId: args.workspaceId,
        conversationId,
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email,
        source: "widget",
        status: lead.status,
        createdAt: lead.createdAt,
      });
      count += 1;
    }
    return count;
  },
});

// ── 6) Completed crawl job ───────────────────────────────────────────────────

export const writeCrawlJob = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    rootUrl: v.string(),
    startedAt: v.number(),
    finishedAt: v.number(),
  },
  returns: v.id("crawlJobs"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("crawlJobs", {
      workspaceId: args.workspaceId,
      rootUrl: args.rootUrl,
      status: "completed",
      maxPages: 50,
      maxDepth: 2,
      pagesDiscovered: 18,
      pagesCrawled: 18,
      chunksCreated: 0,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
    });
  },
});
