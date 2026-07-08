// ─────────────────────────────────────────────────────────────────────────────
// Default-runtime (V8) helpers for the Node run action (run.ts). The run action
// is "use node" and cannot touch ctx.db; all transactional state lives here.
//
// Every mutation that should not act on a STALE run takes `expectedEpoch` and
// no-ops if the conversation's `agentRunEpoch` has moved (a takeover or a newer
// visitor message bumped it). This — together with the run action's re-reads —
// is the epoch/mode abort that prevents double or stale replies.
//
// All `internal*`. Reserve/refund delegate to lib/entitlements (the canonical
// reserve-then-confirm path).
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { reserveAiMessage, refundAiMessage } from "../lib/entitlements";

const citationValidator = v.array(
  v.object({
    chunkId: v.optional(v.id("knowledgeChunks")),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
  }),
);

const upgradeCardValidator = v.object({
  title: v.string(),
  description: v.string(),
  ctaLabel: v.string(),
  url: v.string(),
});

// Load everything the run action needs in one round-trip: the conversation
// fields it guards on, its workspace, and the most recent visitor message body
// (the prompt). Returns null if the conversation or workspace is missing.
export const loadForRun = internalQuery({
  args: { conversationId: v.id("conversations") },
  returns: v.union(
    v.object({
      mode: v.optional(v.union(v.literal("ai"), v.literal("human"))),
      agentRunEpoch: v.optional(v.number()),
      threadId: v.optional(v.string()),
      lastVisitorBody: v.optional(v.string()),
      workspace: v.union(
        v.object({
          _id: v.id("workspaces"),
          name: v.string(),
        }),
        v.null(),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, { conversationId }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) return null;
    const ws = await ctx.db.get(convo.workspaceId);

    // Most recent visitor message = the prompt to answer.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .order("desc")
      .take(20);
    const lastVisitor = recent.find((m) => m.author === "visitor");

    return {
      mode: convo.mode,
      agentRunEpoch: convo.agentRunEpoch,
      threadId: convo.threadId,
      lastVisitorBody: lastVisitor?.body,
      workspace: ws ? { _id: ws._id, name: ws.name } : null,
    };
  },
});

// Lightweight re-read for the abort checkpoints.
export const checkRunState = internalQuery({
  args: { conversationId: v.id("conversations") },
  returns: v.union(
    v.object({
      mode: v.optional(v.union(v.literal("ai"), v.literal("human"))),
      agentRunEpoch: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, { conversationId }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) return null;
    return { mode: convo.mode, agentRunEpoch: convo.agentRunEpoch };
  },
});

// Reserve one AI message, but only if this run is still current + AI mode.
// Returns `{ ok:false, reason:"superseded" }` when the epoch/mode moved so the
// run action can abort WITHOUT posting a quota system message.
export const reserveQuota = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    expectedEpoch: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), periodStart: v.number() }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, { conversationId, expectedEpoch }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) return { ok: false as const, reason: "superseded" };
    if ((convo.mode ?? "ai") !== "ai")
      return { ok: false as const, reason: "superseded" };
    if ((convo.agentRunEpoch ?? 0) !== expectedEpoch)
      return { ok: false as const, reason: "superseded" };

    const ws = await ctx.db.get(convo.workspaceId);
    if (!ws) return { ok: false as const, reason: "superseded" };

    const res = await reserveAiMessage(ctx, ws);
    if (!res.ok) return { ok: false as const, reason: res.reason };
    return { ok: true as const, periodStart: res.periodStart };
  },
});

export const refundQuota = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    periodStart: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { conversationId, periodStart }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) return null;
    await refundAiMessage(ctx, convo.workspaceId, periodStart);
    return null;
  },
});

// Persist the agent thread bridge — only if still current (don't write a thread
// id onto a conversation a human already took over).
export const setThreadId = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    threadId: v.string(),
    expectedEpoch: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { conversationId, threadId, expectedEpoch }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) return null;
    if ((convo.agentRunEpoch ?? 0) !== expectedEpoch) return null;
    // Don't clobber an existing thread.
    if (convo.threadId) return null;
    await ctx.db.patch(conversationId, { threadId });
    return null;
  },
});

// Insert the streaming placeholder (`pending: true`) the transcript subscribers
// already render as a typing bubble. Guarded by epoch/mode so we never inject a
// placeholder into a human-owned conversation.
export const insertPendingAgentMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    expectedEpoch: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), messageId: v.id("messages") }),
    v.object({ ok: v.literal(false) }),
  ),
  handler: async (ctx, { conversationId, expectedEpoch }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) return { ok: false as const };
    if ((convo.mode ?? "ai") !== "ai") return { ok: false as const };
    if ((convo.agentRunEpoch ?? 0) !== expectedEpoch)
      return { ok: false as const };

    const messageId = await ctx.db.insert("messages", {
      conversationId,
      author: "agent",
      body: "",
      isAi: true,
      pending: true,
    });
    return { ok: true as const, messageId };
  },
});

// Finalize: mirror the assistant's full text + citations onto the placeholder
// row and clear `pending`. This is the canonical transcript entry.
export const finalizeAgentMessage = internalMutation({
  args: {
    messageId: v.id("messages"),
    conversationId: v.id("conversations"),
    body: v.string(),
    citations: citationValidator,
    upgradeCard: v.optional(upgradeCardValidator),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { messageId, conversationId, body, citations, upgradeCard },
  ) => {
    const msg = await ctx.db.get(messageId);
    if (!msg) return null; // placeholder was discarded by a takeover
    await ctx.db.patch(messageId, {
      body,
      pending: false,
      citations: citations.length > 0 ? citations : undefined,
      upgradeCard,
    });
    await ctx.db.patch(conversationId, { lastMessageAt: Date.now() });
    return null;
  },
});

// Remove a placeholder when a takeover landed mid-generation (no AI message
// should appear after a human takes over).
export const discardPending = internalMutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, { messageId }) => {
    const msg = await ctx.db.get(messageId);
    if (msg && msg.pending) await ctx.db.delete(messageId);
    return null;
  },
});

// Error cleanup: drop any leftover pending agent placeholder for this run so the
// widget doesn't show a stuck typing bubble. Epoch-guarded.
export const cleanupOnError = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    expectedEpoch: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { conversationId, expectedEpoch }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) return null;
    if ((convo.agentRunEpoch ?? 0) !== expectedEpoch) return null;
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .order("desc")
      .take(5);
    for (const m of recent) {
      if (m.author === "agent" && m.pending) {
        await ctx.db.delete(m._id);
      }
    }
    return null;
  },
});

// Post a system message (graceful degradation / no-AI fallback). Epoch-guarded
// so a late fallback doesn't appear after a takeover. Clears any pending
// placeholder first.
export const postSystem = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    expectedEpoch: v.number(),
    body: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { conversationId, expectedEpoch, body }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) return null;
    if ((convo.agentRunEpoch ?? 0) !== expectedEpoch) return null;

    // Drop any pending placeholder so we don't strand a typing bubble.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .order("desc")
      .take(5);
    for (const m of recent) {
      if (m.author === "agent" && m.pending) await ctx.db.delete(m._id);
    }

    await ctx.db.insert("messages", {
      conversationId,
      author: "system",
      body,
    });
    await ctx.db.patch(conversationId, { lastMessageAt: Date.now() });
    return null;
  },
});

// Re-export the Doc type usage to satisfy lint (kept for clarity in handlers).
export type _LeadDoc = Doc<"leads">;
