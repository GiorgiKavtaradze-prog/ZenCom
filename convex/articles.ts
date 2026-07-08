import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireAdmin, requireOrgMember } from "./lib/auth";
import { internal } from "./_generated/api";
import type { Id, Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Helpdesk article CRUD (admin-gated) + PUBLIC widget read surface.
//
// Re-index lifecycle: writes that change content (create / update / publish)
// rebuild `searchableText` synchronously in the mutation, then schedule the Node
// `articles.reindex` action (embeddings need the Node runtime + an external
// OpenAI call, which a mutation cannot do). The action re-chunks + re-embeds and
// REPLACES the article's knowledgeChunks rows (source:"article", articleId).
//
// Unpublishing/deleting purges the article's chunks so the AI agent never
// retrieves unpublished content. Chunk deletion cascades on article delete.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TITLE = 200;
const MAX_CATEGORY = 80;
const MAX_BODY = 200_000; // ~200 KB markdown; stays well under the 1-MiB doc cap
const REINDEX_MAX_TOKENS = 700;
const REINDEX_OVERLAP = 100;

// ── helpers ──────────────────────────────────────────────────────────────────

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Strip markdown to readable plaintext for the search index + embeddings.
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/[*_>#~`]/g, " ") // residual md punctuation
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

// Ensure a slug is unique within the workspace (append -2, -3, … on collision).
async function uniqueSlug(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  base: string,
  excludeId?: Id<"helpdeskArticles">,
): Promise<string> {
  const root = base || "article";
  let candidate = root;
  let n = 1;
  // Bounded loop — pathological collisions are not a real concern at MVP scale.
  while (true) {
    const existing = await ctx.db
      .query("helpdeskArticles")
      .withIndex("by_workspace_slug", (q) =>
        q.eq("workspaceId", workspaceId).eq("slug", candidate),
      )
      .unique();
    if (!existing || existing._id === excludeId) return candidate;
    n += 1;
    candidate = `${root}-${n}`;
  }
}

const articleDoc = v.object({
  _id: v.id("helpdeskArticles"),
  _creationTime: v.number(),
  workspaceId: v.id("workspaces"),
  title: v.string(),
  slug: v.string(),
  category: v.string(),
  bodyMarkdown: v.string(),
  excerpt: v.optional(v.string()),
  searchableText: v.string(),
  coverImageStorageId: v.optional(v.id("_storage")),
  status: v.union(v.literal("draft"), v.literal("published")),
  isPopular: v.boolean(),
  order: v.number(),
  authorClerkUserId: v.string(),
  updatedAt: v.number(),
});

// Public-facing projection (drops internal/admin-only fields + heavy body when
// not needed). Keeps coverImage as a storageId — the frontend resolves the URL.
const publicArticleSummary = v.object({
  _id: v.id("helpdeskArticles"),
  title: v.string(),
  slug: v.string(),
  category: v.string(),
  excerpt: v.optional(v.string()),
  coverImageStorageId: v.optional(v.id("_storage")),
  isPopular: v.boolean(),
  order: v.number(),
  updatedAt: v.number(),
});

function toPublicSummary(a: Doc<"helpdeskArticles">) {
  return {
    _id: a._id,
    title: a.title,
    slug: a.slug,
    category: a.category,
    excerpt: a.excerpt,
    coverImageStorageId: a.coverImageStorageId,
    isPopular: a.isPopular,
    order: a.order,
    updatedAt: a.updatedAt,
  };
}

// ── ADMIN CRUD ───────────────────────────────────────────────────────────────

export const list = query({
  args: {
    status: v.optional(v.union(v.literal("draft"), v.literal("published"))),
  },
  returns: v.array(articleDoc),
  handler: async (ctx, { status }) => {
    const { workspace } = await requireOrgMember(ctx);
    if (status) {
      return await ctx.db
        .query("helpdeskArticles")
        .withIndex("by_workspace_status", (q) =>
          q.eq("workspaceId", workspace._id).eq("status", status),
        )
        .order("asc")
        .collect();
    }
    return await ctx.db
      .query("helpdeskArticles")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .order("asc")
      .collect();
  },
});

export const get = query({
  args: { articleId: v.id("helpdeskArticles") },
  returns: v.union(articleDoc, v.null()),
  handler: async (ctx, { articleId }) => {
    const { workspace } = await requireOrgMember(ctx);
    const article = await ctx.db.get(articleId);
    if (!article || article.workspaceId !== workspace._id) return null;
    return article;
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    category: v.string(),
    bodyMarkdown: v.string(),
    excerpt: v.optional(v.string()),
    slug: v.optional(v.string()),
    coverImageStorageId: v.optional(v.id("_storage")),
    isPopular: v.optional(v.boolean()),
    publish: v.optional(v.boolean()),
  },
  returns: v.id("helpdeskArticles"),
  handler: async (ctx, args) => {
    const { workspace, identity } = await requireAdmin(ctx);

    const title = args.title.trim().slice(0, MAX_TITLE);
    const category = args.category.trim().slice(0, MAX_CATEGORY) || "General";
    const bodyMarkdown = args.bodyMarkdown.slice(0, MAX_BODY);
    if (title.length === 0) {
      throw new ConvexError({ code: "EMPTY_TITLE", message: "Title required." });
    }

    const slug = await uniqueSlug(
      ctx,
      workspace._id,
      args.slug ? slugify(args.slug) : slugify(title),
    );

    // Place new articles at the end of the order sequence.
    const last = await ctx.db
      .query("helpdeskArticles")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .order("desc")
      .first();
    const order = last ? last.order + 1 : 0;

    const status = args.publish ? "published" : "draft";
    const now = Date.now();
    const articleId = await ctx.db.insert("helpdeskArticles", {
      workspaceId: workspace._id,
      title,
      slug,
      category,
      bodyMarkdown,
      excerpt: args.excerpt?.slice(0, 500),
      searchableText: buildSearchableText(
        title,
        category,
        args.excerpt,
        bodyMarkdown,
      ),
      coverImageStorageId: args.coverImageStorageId,
      status,
      isPopular: args.isPopular ?? false,
      order,
      authorClerkUserId: identity.subject,
      updatedAt: now,
    });

    // Only published articles feed the AI knowledge base.
    if (status === "published") {
      await ctx.scheduler.runAfter(0, internal.articlesNode.reindex, { articleId });
    }
    return articleId;
  },
});

export const update = mutation({
  args: {
    articleId: v.id("helpdeskArticles"),
    title: v.optional(v.string()),
    category: v.optional(v.string()),
    bodyMarkdown: v.optional(v.string()),
    excerpt: v.optional(v.string()),
    coverImageStorageId: v.optional(v.id("_storage")),
    isPopular: v.optional(v.boolean()),
    order: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { workspace } = await requireAdmin(ctx);
    const article = await ctx.db.get(args.articleId);
    if (!article || article.workspaceId !== workspace._id) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Article not found.",
      });
    }

    const title =
      args.title !== undefined
        ? args.title.trim().slice(0, MAX_TITLE)
        : article.title;
    const category =
      args.category !== undefined
        ? args.category.trim().slice(0, MAX_CATEGORY) || "General"
        : article.category;
    const bodyMarkdown =
      args.bodyMarkdown !== undefined
        ? args.bodyMarkdown.slice(0, MAX_BODY)
        : article.bodyMarkdown;
    const excerpt =
      args.excerpt !== undefined ? args.excerpt.slice(0, 500) : article.excerpt;

    const contentChanged =
      args.title !== undefined ||
      args.category !== undefined ||
      args.bodyMarkdown !== undefined ||
      args.excerpt !== undefined;

    await ctx.db.patch(args.articleId, {
      title,
      category,
      bodyMarkdown,
      excerpt,
      coverImageStorageId:
        args.coverImageStorageId !== undefined
          ? args.coverImageStorageId
          : article.coverImageStorageId,
      isPopular:
        args.isPopular !== undefined ? args.isPopular : article.isPopular,
      order: args.order !== undefined ? args.order : article.order,
      searchableText: contentChanged
        ? buildSearchableText(title, category, excerpt, bodyMarkdown)
        : article.searchableText,
      updatedAt: Date.now(),
    });

    // Re-embed only if content changed AND the article is live in the KB.
    if (contentChanged && article.status === "published") {
      await ctx.scheduler.runAfter(0, internal.articlesNode.reindex, {
        articleId: args.articleId,
      });
    }
    return null;
  },
});

export const setPublished = mutation({
  args: {
    articleId: v.id("helpdeskArticles"),
    published: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { articleId, published }) => {
    const { workspace } = await requireAdmin(ctx);
    const article = await ctx.db.get(articleId);
    if (!article || article.workspaceId !== workspace._id) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Article not found.",
      });
    }
    const status = published ? "published" : "draft";
    if (status === article.status) return null;

    await ctx.db.patch(articleId, { status, updatedAt: Date.now() });

    if (published) {
      await ctx.scheduler.runAfter(0, internal.articlesNode.reindex, { articleId });
    } else {
      // Pull the article out of the AI knowledge base immediately.
      await ctx.scheduler.runAfter(0, internal.articles.purgeChunks, {
        articleId,
      });
    }
    return null;
  },
});

export const remove = mutation({
  args: { articleId: v.id("helpdeskArticles") },
  returns: v.null(),
  handler: async (ctx, { articleId }) => {
    const { workspace } = await requireAdmin(ctx);
    const article = await ctx.db.get(articleId);
    if (!article || article.workspaceId !== workspace._id) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Article not found.",
      });
    }
    await ctx.db.delete(articleId);
    // Cascade-delete the cover image + KB chunks (chunks via scheduled sweep so
    // a large set never blows the per-mutation write budget).
    if (article.coverImageStorageId) {
      await ctx.storage.delete(article.coverImageStorageId);
    }
    await ctx.scheduler.runAfter(0, internal.articles.purgeChunks, {
      articleId,
    });
    return null;
  },
});

export const reorder = mutation({
  args: {
    items: v.array(
      v.object({ articleId: v.id("helpdeskArticles"), order: v.number() }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { items }) => {
    const { workspace } = await requireAdmin(ctx);
    for (const { articleId, order } of items) {
      const article = await ctx.db.get(articleId);
      if (!article || article.workspaceId !== workspace._id) continue;
      await ctx.db.patch(articleId, { order, updatedAt: Date.now() });
    }
    return null;
  },
});

// ── INTERNAL RE-INDEX / PURGE (default-runtime mutations) ────────────────────

// Delete all knowledgeChunks for an article (idempotent; small batches).
export const purgeChunks = internalMutation({
  args: { articleId: v.id("helpdeskArticles") },
  returns: v.null(),
  handler: async (ctx, { articleId }) => {
    const chunks = await ctx.db
      .query("knowledgeChunks")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    for (const c of chunks) {
      await ctx.db.delete(c._id);
    }
    return null;
  },
});

// Replace an article's chunk set with freshly-embedded ones. Called by the
// `reindex` Node action after it computes embeddings. Verifies the article still
// exists + is still published before writing (avoids resurrecting deleted KB).
export const writeChunks = internalMutation({
  args: {
    articleId: v.id("helpdeskArticles"),
    chunks: v.array(
      v.object({
        text: v.string(),
        embedding: v.array(v.float64()),
        tokenCount: v.number(),
        contentHash: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { articleId, chunks }) => {
    const article = await ctx.db.get(articleId);
    if (!article || article.status !== "published") return null;

    // Clear existing chunks, then insert the new set.
    const existing = await ctx.db
      .query("knowledgeChunks")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    for (const c of existing) {
      await ctx.db.delete(c._id);
    }
    let i = 0;
    for (const chunk of chunks) {
      await ctx.db.insert("knowledgeChunks", {
        workspaceId: article.workspaceId,
        source: "article",
        articleId,
        title: article.title,
        text: chunk.text,
        chunkIndex: i,
        tokenCount: chunk.tokenCount,
        contentHash: chunk.contentHash,
        embedding: chunk.embedding,
      });
      i += 1;
    }
    return null;
  },
});

// Internal reader: fetch an article's re-index inputs for the Node action.
export const getForReindex = internalQuery({
  args: { articleId: v.id("helpdeskArticles") },
  returns: v.union(
    v.object({
      title: v.string(),
      category: v.string(),
      bodyMarkdown: v.string(),
      excerpt: v.optional(v.string()),
      status: v.union(v.literal("draft"), v.literal("published")),
    }),
    v.null(),
  ),
  handler: async (ctx, { articleId }) => {
    const article = await ctx.db.get(articleId);
    if (!article) return null;
    return {
      title: article.title,
      category: article.category,
      bodyMarkdown: article.bodyMarkdown,
      excerpt: article.excerpt,
      status: article.status,
    };
  },
});

// ── PUBLIC WIDGET READ SURFACE (workspace-scoped, published only) ────────────

export const listPopular = query({
  args: { workspaceId: v.id("workspaces"), limit: v.optional(v.number()) },
  returns: v.array(publicArticleSummary),
  handler: async (ctx, { workspaceId, limit }) => {
    const rows = await ctx.db
      .query("helpdeskArticles")
      .withIndex("by_workspace_popular", (q) =>
        q.eq("workspaceId", workspaceId).eq("isPopular", true),
      )
      .order("asc")
      .take(Math.min(limit ?? 10, 50));
    return rows
      .filter((a) => a.status === "published")
      .map(toPublicSummary);
  },
});

export const listByCategory = query({
  args: {
    workspaceId: v.id("workspaces"),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(publicArticleSummary),
  handler: async (ctx, { workspaceId, category, limit }) => {
    const cap = Math.min(limit ?? 100, 200);
    if (category) {
      const rows = await ctx.db
        .query("helpdeskArticles")
        .withIndex("by_workspace_category", (q) =>
          q.eq("workspaceId", workspaceId).eq("category", category),
        )
        .order("asc")
        .take(cap);
      return rows
        .filter((a) => a.status === "published")
        .map(toPublicSummary);
    }
    // No category → all published, ordered. Filter on the status-narrowed index.
    const rows = await ctx.db
      .query("helpdeskArticles")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("status", "published"),
      )
      .order("asc")
      .take(cap);
    return rows.map(toPublicSummary);
  },
});

// List the distinct published categories for a workspace (for the widget's KB
// home). Small N (helpdesk categories), so a single indexed scan is fine.
export const listCategories = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(v.object({ category: v.string(), count: v.number() })),
  handler: async (ctx, { workspaceId }) => {
    const rows = await ctx.db
      .query("helpdeskArticles")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("status", "published"),
      )
      .take(500);
    const counts = new Map<string, number>();
    for (const a of rows) {
      counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => a.category.localeCompare(b.category));
  },
});

export const getBySlug = query({
  args: { workspaceId: v.id("workspaces"), slug: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("helpdeskArticles"),
      title: v.string(),
      slug: v.string(),
      category: v.string(),
      bodyMarkdown: v.string(),
      excerpt: v.optional(v.string()),
      coverImageStorageId: v.optional(v.id("_storage")),
      isPopular: v.boolean(),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { workspaceId, slug }) => {
    const article = await ctx.db
      .query("helpdeskArticles")
      .withIndex("by_workspace_slug", (q) =>
        q.eq("workspaceId", workspaceId).eq("slug", slug),
      )
      .unique();
    if (!article || article.status !== "published") return null;
    return {
      _id: article._id,
      title: article.title,
      slug: article.slug,
      category: article.category,
      bodyMarkdown: article.bodyMarkdown,
      excerpt: article.excerpt,
      coverImageStorageId: article.coverImageStorageId,
      isPopular: article.isPopular,
      updatedAt: article.updatedAt,
    };
  },
});

export const searchArticles = query({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(publicArticleSummary),
  handler: async (ctx, { workspaceId, query: term, category, limit }) => {
    const trimmed = term.trim().slice(0, 200);
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
      .take(Math.min(limit ?? 10, 25));
    return rows.map(toPublicSummary);
  },
});
