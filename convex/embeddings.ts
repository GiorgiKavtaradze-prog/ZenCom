"use node";

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI embeddings (text-embedding-3-small → 1536 dims, LOCKED to match the
// knowledgeChunks.by_embedding vector index).
//
// IMPORTANT GUARD: the OPENAI_API_KEY is read at CALL TIME, never at import. No
// top-level OpenAI client is constructed, so `convex dev` push / bundle / CI
// import never triggers a live API call. If the key is absent when `embedTexts`
// is actually invoked, we throw a clear ConvexError so the dashboard can surface
// "AI not configured" instead of a cryptic SDK error.
//
// Routing: we build the provider with `createOpenAI({ apiKey })` so requests go
// DIRECTLY to api.openai.com — NOT through the Vercel AI Gateway (which the bare
// "openai/..." model-string form would use and which needs its own credential).
// ─────────────────────────────────────────────────────────────────────────────

import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { ConvexError, v } from "convex/values";
import { internalAction } from "./_generated/server";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

// OpenAI's embeddings endpoint accepts many inputs per request; cap our batch so
// a single call stays well under request-size limits and within the action's
// memory/time budget. embedMany also auto-chunks, but we keep an explicit cap.
const MAX_BATCH = 96;

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new ConvexError({
      code: "OPENAI_NOT_CONFIGURED",
      message:
        "OPENAI_API_KEY is not set on the Convex deployment. KB embedding is unavailable until it is configured.",
    });
  }
  return key;
}

/**
 * Embed an array of texts into 1536-dim vectors. Order-preserving. Batches
 * internally. Reusable from any Node action in this project (file/crawl/article
 * ingestion all call this directly in-process — no extra action hop).
 *
 * Throws OPENAI_NOT_CONFIGURED (at call time) if the key is missing.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = getApiKey();
  const openai = createOpenAI({ apiKey });
  const model = openai.textEmbeddingModel(EMBEDDING_MODEL);

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const { embeddings } = await embedMany({
      model,
      values: batch,
      // text-embedding-3-small is natively 1536; no dimension override needed.
      maxRetries: 2,
    });
    for (const e of embeddings) {
      if (e.length !== EMBEDDING_DIMENSIONS) {
        throw new ConvexError({
          code: "EMBEDDING_DIM_MISMATCH",
          message: `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${e.length}.`,
        });
      }
      out.push(e as number[]);
    }
  }
  return out;
}

// Internal action wrapper so non-Node functions (e.g. a default-runtime mutation
// that can't import this Node file) can embed via `ctx.runAction`. Most callers
// in this project are themselves Node actions and use `embedTexts` directly.
export const embed = internalAction({
  args: { texts: v.array(v.string()) },
  returns: v.array(v.array(v.float64())),
  handler: async (_ctx, { texts }) => {
    return await embedTexts(texts);
  },
});
