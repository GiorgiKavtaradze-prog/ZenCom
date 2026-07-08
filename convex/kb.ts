import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { requireOrgMember } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Shared knowledge-base persistence + read surface.
//
// `insertChunks` is the single internal write path for file + crawl ingestion
// (article ingestion uses articles.writeChunks because it REPLACES by articleId).
// It dedupes within the workspace on contentHash (skip already-present chunks),
// so re-crawling / re-uploading the same content is idempotent and cheap.
//
// Default-runtime mutation so both Node actions (filesNode, crawler) can call it
// via ctx.runMutation without importing any Node deps.
// ─────────────────────────────────────────────────────────────────────────────

const chunkInput = v.object({
  text: v.string(),
  embedding: v.array(v.float64()),
  tokenCount: v.number(),
  contentHash: v.string(),
});

export const insertChunks = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    source: v.union(v.literal("file"), v.literal("crawl")),
    title: v.string(),
    sourceUrl: v.optional(v.string()),
    crawlJobId: v.optional(v.id("crawlJobs")),
    chunks: v.array(chunkInput),
  },
  returns: v.object({ inserted: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    let inserted = 0;
    let skipped = 0;
    // chunkIndex is monotonic within this insert batch; for dedupe across
    // ingests we key on (workspaceId, contentHash).
    let nextIndex = 0;
    for (const chunk of args.chunks) {
      const dup = await ctx.db
        .query("knowledgeChunks")
        .withIndex("by_workspace_hash", (q) =>
          q
            .eq("workspaceId", args.workspaceId)
            .eq("contentHash", chunk.contentHash),
        )
        .first();
      if (dup) {
        skipped += 1;
        continue;
      }
      await ctx.db.insert("knowledgeChunks", {
        workspaceId: args.workspaceId,
        source: args.source,
        crawlJobId: args.crawlJobId,
        sourceUrl: args.sourceUrl,
        title: args.title,
        text: chunk.text,
        chunkIndex: nextIndex,
        tokenCount: chunk.tokenCount,
        contentHash: chunk.contentHash,
        embedding: chunk.embedding,
      });
      nextIndex += 1;
      inserted += 1;
    }
    return { inserted, skipped };
  },
});

// Internal: load chunk text/metadata for a set of vector-search hit ids. Used by
// the AI agent retrieval path (Phase 4) — kept here so the read projection lives
// next to the write path. Workspace ownership is re-checked by the caller via
// the vectorSearch workspaceId filter; we still drop the raw embedding.
export const getChunksByIds = internalQuery({
  args: { ids: v.array(v.id("knowledgeChunks")) },
  returns: v.array(
    v.object({
      _id: v.id("knowledgeChunks"),
      workspaceId: v.id("workspaces"),
      source: v.union(
        v.literal("crawl"),
        v.literal("article"),
        v.literal("file"),
      ),
      articleId: v.optional(v.id("helpdeskArticles")),
      sourceUrl: v.optional(v.string()),
      title: v.string(),
      text: v.string(),
    }),
  ),
  handler: async (ctx, { ids }) => {
    const out = [];
    for (const id of ids) {
      const chunk = await ctx.db.get(id);
      if (!chunk) continue;
      out.push({
        _id: chunk._id,
        workspaceId: chunk.workspaceId,
        source: chunk.source,
        articleId: chunk.articleId,
        sourceUrl: chunk.sourceUrl,
        title: chunk.title,
        text: chunk.text,
      });
    }
    return out;
  },
});

// Dashboard (authed): KB source inventory + counts for the setup screen.
export const stats = query({
  args: {},
  returns: v.object({
    article: v.number(),
    file: v.number(),
    crawl: v.number(),
    total: v.number(),
  }),
  handler: async (ctx) => {
    const { workspace } = await requireOrgMember(ctx);
    const counts = { article: 0, file: 0, crawl: 0 };
    // Bounded scan per source via the by_workspace_source index. Capped so the
    // dashboard stat never blows the read budget on a huge KB (display "500+").
    for (const source of ["article", "file", "crawl"] as const) {
      const rows = await ctx.db
        .query("knowledgeChunks")
        .withIndex("by_workspace_source", (q) =>
          q.eq("workspaceId", workspace._id).eq("source", source),
        )
        .take(2000);
      counts[source] = rows.length;
    }
    return {
      ...counts,
      total: counts.article + counts.file + counts.crawl,
    };
  },
});

// Dashboard (authed): the ingested non-article KB source inventory, grouped so
// the Knowledge UI can list each crawl/file source with a chunk count and offer
// delete / re-crawl. Crawl chunks group by crawlJobId; file chunks group by
// (title + sourceUrl). Article chunks are managed from the Articles tab, so they
// are intentionally excluded here. Bounded scan per source (display "many" past
// the cap) keeps the read budget safe on a large KB.
export const listSources = query({
  args: {},
  returns: v.array(
    v.object({
      key: v.string(),
      source: v.union(v.literal("crawl"), v.literal("file")),
      title: v.string(),
      sourceUrl: v.optional(v.string()),
      crawlJobId: v.optional(v.id("crawlJobs")),
      chunkCount: v.number(),
      lastUpdated: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const { workspace } = await requireOrgMember(ctx);
    const groups = new Map<
      string,
      {
        key: string;
        source: "crawl" | "file";
        title: string;
        sourceUrl?: string;
        crawlJobId?: import("./_generated/dataModel").Id<"crawlJobs">;
        chunkCount: number;
        lastUpdated: number;
      }
    >();

    for (const source of ["crawl", "file"] as const) {
      const rows = await ctx.db
        .query("knowledgeChunks")
        .withIndex("by_workspace_source", (q) =>
          q.eq("workspaceId", workspace._id).eq("source", source),
        )
        .take(4000);
      for (const r of rows) {
        const key =
          source === "crawl"
            ? `crawl:${r.crawlJobId ?? r.title}`
            : `file:${r.title}:${r.sourceUrl ?? ""}`;
        const existing = groups.get(key);
        if (existing) {
          existing.chunkCount += 1;
          existing.lastUpdated = Math.max(
            existing.lastUpdated,
            r._creationTime,
          );
        } else {
          groups.set(key, {
            key,
            source,
            title: r.title,
            sourceUrl: r.sourceUrl,
            crawlJobId: r.crawlJobId,
            chunkCount: 1,
            lastUpdated: r._creationTime,
          });
        }
      }
    }

    return [...groups.values()].sort((a, b) => b.lastUpdated - a.lastUpdated);
  },
});
