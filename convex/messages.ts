import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { requireOrgMember } from "./lib/auth";
import { rateLimiter, rlKey } from "./lib/ratelimit";
import { internal } from "./_generated/api";

// Debounce window: coalesces rapid successive visitor messages into a single
// agent run (the scheduled job for an earlier message is cancelled when a newer
// one arrives — see below). ~1.2s balances perceived latency vs coalescing.
const AGENT_DEBOUNCE_MS = 1200;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 re-key + abuse controls.
//
// - `list`           : used by BOTH widget + dashboard. Reactive. PUBLIC,
//                      signature-unchanged.
// - `sendFromVisitor`: PUBLIC widget write. Signature-unchanged. Now rate-limited
//                      per (workspaceId, visitorId) + body-length bounded. (AI
//                      quota reserve + agent scheduling land in Phase 4/5.)
// - `sendFromAgent`  : DASHBOARD (authed). Re-keyed from `ws.ownerClerkUserId`
//                      to `requireOrgMember`; stamps `authorClerkUserId`.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BODY_LEN = 4000; // server-side bound on visitor free-text

const messageDoc = v.object({
  _id: v.id("messages"),
  _creationTime: v.number(),
  conversationId: v.id("conversations"),
  author: v.union(
    v.literal("visitor"),
    v.literal("agent"),
    v.literal("system"),
  ),
  body: v.string(),
  isAi: v.optional(v.boolean()),
  authorClerkUserId: v.optional(v.string()),
  pending: v.optional(v.boolean()),
  citations: v.optional(
    v.array(
      v.object({
        chunkId: v.optional(v.id("knowledgeChunks")),
        title: v.optional(v.string()),
        url: v.optional(v.string()),
      }),
    ),
  ),
});

// PUBLIC: list a conversation's messages (widget + dashboard subscribe). Reactive.
// Ownership is enforced per audience to prevent cross-visitor / cross-tenant
// transcript reads (IDOR): anonymous widget callers pass their minted
// `visitorId` (must match the conversation's visitor); authed dashboard callers
// omit it and are authorized via org membership.
export const list = query({
  args: {
    conversationId: v.id("conversations"),
    visitorId: v.optional(v.string()),
  },
  returns: v.array(messageDoc),
  handler: async (ctx, { conversationId, visitorId }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) return [];

    if (visitorId !== undefined) {
      // Widget path — bind the read to the conversation's visitor.
      if (convo.visitorId !== visitorId) return [];
    } else {
      // Dashboard path — must be an active member of the conversation's org.
      const { workspace } = await requireOrgMember(ctx);
      if (convo.workspaceId !== workspace._id) return [];
    }

    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .order("asc")
      .collect();
  },
});

// PUBLIC (widget): a visitor sends a message. Signature UNCHANGED. Rate-limited
// per (workspaceId, visitorId) + body-bounded BEFORE any write.
export const sendFromVisitor = mutation({
  args: {
    conversationId: v.id("conversations"),
    visitorId: v.string(),
    body: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { conversationId, visitorId, body }) => {
    const convo = await ctx.db.get(conversationId);
    if (!convo) throw new ConvexError({ code: "UNKNOWN_CONVERSATION" });

    // Ownership: the caller must be the conversation's visitor. Without this,
    // anyone holding a conversationId could inject messages into another
    // visitor's thread and burn the owning tenant's AI quota (IDOR).
    if (convo.visitorId !== visitorId) {
      throw new ConvexError({ code: "FORBIDDEN" });
    }

    // Server-side bound on free-text (prevents 1-MiB doc / storage abuse).
    const trimmed = body.slice(0, MAX_BODY_LEN);
    if (trimmed.trim().length === 0) {
      throw new ConvexError({ code: "EMPTY_BODY" });
    }

    // Abuse control: token-bucket per (workspace, visitor). Throws a
    // RateLimitError when exceeded (the widget surfaces a "slow down" notice).
    await rateLimiter.limit(ctx, "widgetMessage", {
      key: rlKey(convo.workspaceId, visitorId),
      throws: true,
    });

    const now = Date.now();
    await ctx.db.insert("messages", {
      conversationId,
      author: "visitor",
      body: trimmed,
    });

    // ── AI trigger (Phase 4) ────────────────────────────────────────────────
    // Only when the conversation is in AI mode. We:
    //   1. bump agentRunEpoch — invalidates any in-flight run (run.ts re-reads
    //      the epoch at each checkpoint and aborts on mismatch). This is the
    //      AUTHORITATIVE no-double-reply guard.
    //   2. opportunistically cancel any still-pending (not-yet-started)
    //      scheduled run — best-effort only; cancel can't stop a job that
    //      already started, which is why the epoch check is authoritative.
    //   3. schedule a fresh debounced run and store its job id.
    // Quota is RESERVED inside the run action (reserve-then-confirm), not here,
    // so a coalesced/cancelled run never leaks a reservation.
    const isAiMode = (convo.mode ?? "ai") === "ai";
    if (isAiMode) {
      const nextEpoch = (convo.agentRunEpoch ?? 0) + 1;

      // Opportunistic cancel of the superseded pending job.
      if (convo.pendingAgentJobId) {
        try {
          await ctx.scheduler.cancel(convo.pendingAgentJobId);
        } catch {
          // Already ran / already cancelled — the epoch bump handles it.
        }
      }

      const jobId = await ctx.scheduler.runAfter(
        AGENT_DEBOUNCE_MS,
        internal.agent.run.respondToVisitorMessage,
        { conversationId },
      );

      await ctx.db.patch(conversationId, {
        lastMessageAt: now,
        lastVisitorMessageAt: now,
        agentRunEpoch: nextEpoch,
        pendingAgentJobId: jobId,
      });
    } else {
      await ctx.db.patch(conversationId, {
        lastMessageAt: now,
        lastVisitorMessageAt: now,
      });
    }
    return null;
  },
});

// DASHBOARD (authed): an agent replies. Re-keyed to org membership — any active
// member of the conversation's org may reply (agents are limited to reply /
// takeover / self-assign elsewhere).
export const sendFromAgent = mutation({
  args: { conversationId: v.id("conversations"), body: v.string() },
  returns: v.null(),
  handler: async (ctx, { conversationId, body }) => {
    const { workspace, identity } = await requireOrgMember(ctx);

    const convo = await ctx.db.get(conversationId);
    if (!convo) throw new ConvexError({ code: "UNKNOWN_CONVERSATION" });
    if (convo.workspaceId !== workspace._id) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Not authorized for this conversation.",
      });
    }

    const trimmed = body.slice(0, MAX_BODY_LEN);
    if (trimmed.trim().length === 0) {
      throw new ConvexError({ code: "EMPTY_BODY" });
    }

    await ctx.db.insert("messages", {
      conversationId,
      author: "agent",
      body: trimmed,
      isAi: false, // human-authored
      authorClerkUserId: identity.subject,
    });
    await ctx.db.patch(conversationId, { lastMessageAt: Date.now() });
    return null;
  },
});
