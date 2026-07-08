import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireAdmin } from "./lib/auth";
import { internal } from "./_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// File storage entry points (admin-gated).
//
// Two upload purposes:
//   - "image"    : article cover images / widget logo. Validated MIME + size on
//                  finalize. SVG is REJECTED (XSS vector via embedded scripts).
//   - "document" : .md / .txt / .pdf knowledge-base sources. After upload, a Node
//                  action (filesNode.ingestDocument) parses the file to text,
//                  chunks + embeds it into knowledgeChunks (source:"file").
//
// generateUploadUrl returns a short-lived POST URL (Convex-managed). The client
// uploads directly, gets back a storageId, then calls the matching finalize
// mutation so the server can validate metadata BEFORE the id is persisted on a
// row. We never trust the client-declared content type alone — we re-read the
// stored blob's metadata server-side.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DOC_BYTES = 15 * 1024 * 1024; // 15 MB (raw upload; PDFs can be large)

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

// SVG is intentionally absent (script-injection risk). image/svg+xml is rejected.
const ALLOWED_DOC_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/pdf",
  "application/octet-stream", // some browsers send this for .md — extension-checked downstream
]);

// PUBLIC-to-admin: mint a one-shot upload URL. Caller must be an org admin.
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// Validate an uploaded IMAGE blob (size + MIME, SVG rejected) and return the id
// for the caller to persist onto an article/appearance row. Deletes the blob and
// throws on rejection so no orphan/invalid file lingers.
export const finalizeImageUpload = mutation({
  args: { storageId: v.id("_storage") },
  returns: v.object({
    storageId: v.id("_storage"),
    url: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { storageId }) => {
    await requireAdmin(ctx);
    const meta = await ctx.db.system.get(storageId);
    if (!meta) {
      throw new ConvexError({
        code: "UPLOAD_NOT_FOUND",
        message: "Uploaded file not found.",
      });
    }
    const contentType = (meta.contentType ?? "").toLowerCase();
    const isSvg =
      contentType.includes("svg") || contentType === "image/svg+xml";
    if (isSvg || !ALLOWED_IMAGE_TYPES.has(contentType)) {
      await ctx.storage.delete(storageId);
      throw new ConvexError({
        code: "INVALID_IMAGE_TYPE",
        message: `Unsupported image type: ${contentType || "unknown"}. SVG is not allowed.`,
      });
    }
    if (meta.size > MAX_IMAGE_BYTES) {
      await ctx.storage.delete(storageId);
      throw new ConvexError({
        code: "IMAGE_TOO_LARGE",
        message: `Image exceeds ${MAX_IMAGE_BYTES} bytes.`,
      });
    }
    const url = await ctx.storage.getUrl(storageId);
    return { storageId, url };
  },
});

// Validate an uploaded DOCUMENT blob (size + MIME) and kick off Node ingestion.
// Returns the crawl-less ingest immediately as scheduled work; the dashboard can
// poll knowledgeChunks/by_workspace_source to show progress.
export const finalizeDocumentUpload = mutation({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    title: v.optional(v.string()),
  },
  returns: v.object({ scheduled: v.boolean() }),
  handler: async (ctx, { storageId, fileName, title }) => {
    const { workspace } = await requireAdmin(ctx);
    const meta = await ctx.db.system.get(storageId);
    if (!meta) {
      throw new ConvexError({
        code: "UPLOAD_NOT_FOUND",
        message: "Uploaded file not found.",
      });
    }

    const name = fileName.toLowerCase();
    const ext = name.slice(name.lastIndexOf("."));
    const extOk = ext === ".md" || ext === ".txt" || ext === ".pdf";
    const contentType = (meta.contentType ?? "").toLowerCase();
    const typeOk = ALLOWED_DOC_TYPES.has(contentType) || contentType === "";

    if (!extOk || !typeOk) {
      await ctx.storage.delete(storageId);
      throw new ConvexError({
        code: "INVALID_DOC_TYPE",
        message:
          "Only .md, .txt, and .pdf documents are supported (SVG/HTML rejected).",
      });
    }
    if (meta.size > MAX_DOC_BYTES) {
      await ctx.storage.delete(storageId);
      throw new ConvexError({
        code: "DOC_TOO_LARGE",
        message: `Document exceeds ${MAX_DOC_BYTES} bytes.`,
      });
    }

    const kind = ext === ".pdf" ? "pdf" : "text";
    await ctx.scheduler.runAfter(0, internal.filesNode.ingestDocument, {
      workspaceId: workspace._id,
      storageId,
      kind,
      title: (title ?? fileName).slice(0, 200),
      sourceUrl: fileName.slice(0, 500),
    });
    return { scheduled: true };
  },
});

// Admin/dashboard helper: resolve a storage URL for display (cover images, logo).
export const getUrl = query({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { storageId }) => {
    await requireAdmin(ctx);
    return await ctx.storage.getUrl(storageId);
  },
});
