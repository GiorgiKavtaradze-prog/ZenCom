"use node";

// ─────────────────────────────────────────────────────────────────────────────
// Node-runtime document ingestion: download an uploaded blob from Convex storage,
// extract plaintext (.pdf via `unpdf`, .md/.txt directly), chunk + embed, and
// persist to knowledgeChunks (source:"file"). Scheduled by files.finalizeDocumentUpload.
//
// `unpdf` is a serverless-friendly PDF text extractor (bundled WASM-free build).
// It is declared in convex.json node.externalPackages so Convex installs it in
// the action's Node environment rather than tree-shaking it into the V8 bundle.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createHash } from "node:crypto";
import { chunkText, estimateTokens } from "./chunking";
import { embedTexts } from "./embeddings";

const MAX_TOKENS = 700;
const OVERLAP = 100;
// Cap chunks per document so a single 15 MB PDF can't schedule an unbounded
// embedding spend or exceed the action's write budget. Excess is truncated.
const MAX_CHUNKS_PER_DOC = 400;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // Lazy import keeps the dependency out of any non-PDF code path + the bundle.
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

export const ingestDocument = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    storageId: v.id("_storage"),
    kind: v.union(v.literal("pdf"), v.literal("text")),
    title: v.string(),
    sourceUrl: v.optional(v.string()),
  },
  returns: v.object({ inserted: v.number(), skipped: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ inserted: number; skipped: number }> => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) {
      throw new Error("Uploaded document blob no longer exists in storage.");
    }
    const buffer = await blob.arrayBuffer();

    let raw: string;
    if (args.kind === "pdf") {
      raw = await extractPdfText(new Uint8Array(buffer));
    } else {
      raw = new TextDecoder("utf-8").decode(buffer);
    }

    const header = `${args.title}\n`;
    const pieces = chunkText(`${header}\n${raw}`, {
      maxTokens: MAX_TOKENS,
      overlap: OVERLAP,
    }).slice(0, MAX_CHUNKS_PER_DOC);

    if (pieces.length === 0) {
      return { inserted: 0, skipped: 0 };
    }

    const embeddings = await embedTexts(pieces);
    const chunks = pieces.map((text, i) => ({
      text,
      embedding: embeddings[i],
      tokenCount: estimateTokens(text),
      contentHash: sha256(text),
    }));

    const result = await ctx.runMutation(internal.kb.insertChunks, {
      workspaceId: args.workspaceId,
      source: "file" as const,
      title: args.title,
      sourceUrl: args.sourceUrl,
      chunks,
    });
    return { inserted: result.inserted, skipped: result.skipped };
  },
});
