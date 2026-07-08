"use node";

// ─────────────────────────────────────────────────────────────────────────────
// Node-runtime re-index action for helpdesk articles. Lives in its OWN file
// because "use node" files cannot also export queries/mutations (those stay in
// articles.ts). Scheduled by the article CRUD mutations after a content change.
//
// Flow: read the article (internal query) → strip+chunk → embed (OpenAI) →
// write the new chunk set (internal mutation that re-checks published status).
// If OpenAI is not configured, the action throws OPENAI_NOT_CONFIGURED; the
// scheduler records the failure and the article's old chunks remain (we only
// REPLACE on a successful embed, so the KB never ends up empty on a transient
// embedding outage).
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createHash } from "node:crypto";
import { chunkText, estimateTokens } from "./chunking";
import { embedTexts } from "./embeddings";

const MAX_TOKENS = 700;
const OVERLAP = 100;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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

export const reindex = internalAction({
  args: { articleId: v.id("helpdeskArticles") },
  returns: v.null(),
  handler: async (ctx, { articleId }) => {
    const article = await ctx.runQuery(internal.articles.getForReindex, {
      articleId,
    });
    // Article deleted or unpublished between scheduling and running → nothing to
    // index. The purge path handles chunk removal in those cases.
    if (!article || article.status !== "published") return null;

    // Prepend the title/category so each chunk carries topical context for
    // retrieval (the body alone can be ambiguous).
    const header = `${article.title}\n${article.category}\n${article.excerpt ?? ""}`;
    const plain = `${header}\n\n${stripMarkdown(article.bodyMarkdown)}`;
    const pieces = chunkText(plain, { maxTokens: MAX_TOKENS, overlap: OVERLAP });

    if (pieces.length === 0) {
      // No embeddable content → clear any stale chunks and stop.
      await ctx.runMutation(internal.articles.purgeChunks, { articleId });
      return null;
    }

    const embeddings = await embedTexts(pieces);
    const chunks = pieces.map((text, i) => ({
      text,
      embedding: embeddings[i],
      tokenCount: estimateTokens(text),
      contentHash: sha256(text),
    }));

    await ctx.runMutation(internal.articles.writeChunks, { articleId, chunks });
    return null;
  },
});
