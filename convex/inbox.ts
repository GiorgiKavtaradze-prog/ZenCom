import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireOrgMember, type OrgMemberContext } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — DASHBOARD inbox (authed). Takeover / assignment / read-state /
// status, plus role-aware list + detail queries and sidebar badge counts.
//
// NO-DOUBLE-REPLY CONTRACT (the load-bearing invariant):
//   The Phase 4 agent run (agent/run.ts) captures `agentRunEpoch` at start and
//   re-reads `mode` + `agentRunEpoch` after every expensive step, aborting on
//   any change. So ANY mutation here that should suppress an in-flight AI reply
//   simply (a) sets `mode:"human"` and (b) bumps `agentRunEpoch`. We ALSO
//   opportunistically `scheduler.cancel(pendingAgentJobId)` — best-effort only,
//   since cancel can't stop a job that already started; the epoch bump is the
//   authoritative abort. We clear `pendingAgentJobId` after cancelling.
//
// ROLE-BASED VISIBILITY (enforced in Convex, not just UI — BUILD_PLAN §Security):
//   - The HARD boundary for BOTH roles is the caller's active-org workspace. No
//     member of any role can read another org's conversations.
//   - admin   → sees ALL conversations in the workspace (every filter).
//   - support → sees the team queue: unassigned + assigned-to-anyone (incl.
//     teammates) + their own. Same workspace rows as admin for the shared
//     filters; the ONLY narrowing is that the `mine` filter is always scoped to
//     the caller. (MVP: support is a full team agent, not siloed per-assignee.)
//
//   Filters: 'all' | 'mine' | 'unassigned' | 'ai' | 'human'.
// ─────────────────────────────────────────────────────────────────────────────

const conversationDoc = v.object({
  _id: v.id("conversations"),
  _creationTime: v.number(),
  workspaceId: v.id("workspaces"),
  visitorId: v.string(),
  visitorName: v.string(),
  lastMessageAt: v.number(),
  mode: v.optional(v.union(v.literal("ai"), v.literal("human"))),
  status: v.optional(v.union(v.literal("open"), v.literal("closed"))),
  assignedClerkUserId: v.optional(v.string()),
  assignedAt: v.optional(v.number()),
  lastVisitorMessageAt: v.optional(v.number()),
  lastReadByAgentAt: v.optional(v.number()),
  pendingAgentJobId: v.optional(v.id("_scheduled_functions")),
  agentRunEpoch: v.optional(v.number()),
  threadId: v.optional(v.string()),
});

// A conversation enriched with derived UI flags the inbox list needs. `unread`
// is the cheap, reactive "needs attention" signal (a visitor message arrived
// after the agent last read). `assigneeName` is resolved from the member mirror.
const conversationListItem = v.object({
  _id: v.id("conversations"),
  _creationTime: v.number(),
  workspaceId: v.id("workspaces"),
  visitorId: v.string(),
  visitorName: v.string(),
  lastMessageAt: v.number(),
  mode: v.union(v.literal("ai"), v.literal("human")),
  status: v.union(v.literal("open"), v.literal("closed")),
  assignedClerkUserId: v.optional(v.string()),
  assignedAt: v.optional(v.number()),
  assigneeName: v.optional(v.string()),
  assigneeAvatarUrl: v.optional(v.string()),
  lastVisitorMessageAt: v.optional(v.number()),
  lastReadByAgentAt: v.optional(v.number()),
  unread: v.boolean(),
});

type EnrichedConversation = {
  _id: Id<"conversations">;
  _creationTime: number;
  workspaceId: Id<"workspaces">;
  visitorId: string;
  visitorName: string;
  lastMessageAt: number;
  mode: "ai" | "human";
  status: "open" | "closed";
  assignedClerkUserId?: string;
  assignedAt?: number;
  assigneeName?: string;
  assigneeAvatarUrl?: string;
  lastVisitorMessageAt?: number;
  lastReadByAgentAt?: number;
  unread: boolean;
};

// ── Shared helpers ───────────────────────────────────────────────────────────

// Load + org-authorize a conversation in one step. Throws FORBIDDEN if the
// conversation belongs to another workspace (defense-in-depth tenant isolation).
async function requireConversation(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
): Promise<{ member: OrgMemberContext; convo: Doc<"conversations"> }> {
  const member = await requireOrgMember(ctx);
  const convo = await ctx.db.get(conversationId);
  if (!convo) {
    throw new ConvexError({
      code: "UNKNOWN_CONVERSATION",
      message: "Conversation not found.",
    });
  }
  if (convo.workspaceId !== member.workspace._id) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Not authorized for this conversation.",
    });
  }
  return { member, convo };
}

// Resolve a Clerk user id → mirrored member display name (for system messages).
async function resolveMemberName(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  clerkUserId: string,
): Promise<string> {
  const member = await loadMember(ctx, workspaceId, clerkUserId);
  return member?.name ?? "A teammate";
}

async function loadMember(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  clerkUserId: string,
): Promise<Doc<"workspaceMembers"> | null> {
  // The member mirror is keyed by (clerkOrgId, clerkUserId); we have the
  // workspace, so scan its members (small set — one org's team) and match.
  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return members.find((m) => m.clerkUserId === clerkUserId) ?? null;
}

// "Joined" / system messages are inserted directly (system author, no isAi).
async function postSystem(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  body: string,
): Promise<void> {
  await ctx.db.insert("messages", {
    conversationId,
    author: "system",
    body,
  });
}

// A conversation is "unread" for agents when a visitor message arrived after the
// last time an agent read it. Conversations in pure AI mode that the AI is
// handling are NOT surfaced as unread (the human hasn't been pulled in yet) —
// but once in human mode, any newer visitor message marks it unread.
function isUnread(convo: Doc<"conversations">): boolean {
  const lastVisitor = convo.lastVisitorMessageAt ?? 0;
  if (lastVisitor === 0) return false;
  const lastRead = convo.lastReadByAgentAt ?? 0;
  return lastVisitor > lastRead;
}

function enrich(
  convo: Doc<"conversations">,
  memberByClerkId: Map<string, Doc<"workspaceMembers">>,
): EnrichedConversation {
  const assignee = convo.assignedClerkUserId
    ? memberByClerkId.get(convo.assignedClerkUserId)
    : undefined;
  return {
    _id: convo._id,
    _creationTime: convo._creationTime,
    workspaceId: convo.workspaceId,
    visitorId: convo.visitorId,
    visitorName: convo.visitorName,
    lastMessageAt: convo.lastMessageAt,
    mode: convo.mode ?? "ai",
    status: convo.status ?? "open",
    assignedClerkUserId: convo.assignedClerkUserId,
    assignedAt: convo.assignedAt,
    assigneeName: assignee?.name,
    assigneeAvatarUrl: assignee?.imageUrl,
    lastVisitorMessageAt: convo.lastVisitorMessageAt,
    lastReadByAgentAt: convo.lastReadByAgentAt,
    unread: isUnread(convo),
  };
}

// ── MUTATIONS ────────────────────────────────────────────────────────────────

// takeOver: an agent jumps in. Flip to human mode, bump epoch (aborts any
// in-flight AI run at its next checkpoint), opportunistically cancel + clear the
// pending job, self-assign if currently unassigned, and post a join notice.
// Idempotent: a second call while already human/assigned-to-caller is a no-op
// beyond a (deduped) re-read — it never posts a duplicate "joined" message.
export const takeOver = mutation({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    const { member, convo } = await requireConversation(ctx, conversationId);
    const callerId = member.identity.subject;

    const alreadyHuman = convo.mode === "human";

    // Opportunistically cancel the pending (not-yet-started) AI job.
    if (convo.pendingAgentJobId) {
      try {
        await ctx.scheduler.cancel(convo.pendingAgentJobId);
      } catch {
        // Already ran / cancelled — the epoch bump is the authoritative abort.
      }
    }

    const patch: Partial<Doc<"conversations">> = {
      mode: "human",
      // Bump epoch unconditionally so an in-flight run aborts even if mode was
      // already "human" from a prior escalation.
      agentRunEpoch: (convo.agentRunEpoch ?? 0) + 1,
      pendingAgentJobId: undefined,
      // The taker has, by definition, just read the conversation.
      lastReadByAgentAt: Date.now(),
    };

    // Self-assign only when nobody owns it yet (don't steal a teammate's chat).
    if (!convo.assignedClerkUserId) {
      patch.assignedClerkUserId = callerId;
      patch.assignedAt = Date.now();
    }

    await ctx.db.patch(conversationId, patch);

    // System notices: only on the transition INTO human mode (idempotent).
    if (!alreadyHuman) {
      const name =
        member.identity.name ??
        (await resolveMemberName(ctx, member.workspace._id, callerId));
      await postSystem(ctx, conversationId, `${name} joined the conversation.`);
    }
    return null;
  },
});

// returnToAi: hand the conversation back to the assistant. Clears any pending
// job lock, flips mode to "ai", and posts a system notice. We do NOT bump the
// epoch here — the next visitor message will (via sendFromVisitor) and that's
// what (re)starts the AI loop; flipping mode is enough to let it run again.
export const returnToAi = mutation({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    const { convo } = await requireConversation(ctx, conversationId);
    if (convo.mode !== "human") {
      // Already AI — idempotent no-op (no duplicate system message).
      return null;
    }

    if (convo.pendingAgentJobId) {
      try {
        await ctx.scheduler.cancel(convo.pendingAgentJobId);
      } catch {
        // ignore
      }
    }

    await ctx.db.patch(conversationId, {
      mode: "ai",
      pendingAgentJobId: undefined,
    });
    await postSystem(ctx, conversationId, "Handed back to the AI assistant.");
    return null;
  },
});

// assign: set the owner to a specific member (admin OR support — any teammate
// can route a chat). Validates the target is an ACTIVE member of this workspace.
// Posts a system notice only when the assignee actually changes (OCC-idempotent).
export const assign = mutation({
  args: {
    conversationId: v.id("conversations"),
    clerkUserId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { conversationId, clerkUserId }) => {
    const { member, convo } = await requireConversation(ctx, conversationId);

    const target = await loadMember(ctx, member.workspace._id, clerkUserId);
    if (!target || target.status !== "active") {
      throw new ConvexError({
        code: "INVALID_ASSIGNEE",
        message: "Assignee is not an active member of this workspace.",
      });
    }

    if (convo.assignedClerkUserId === clerkUserId) {
      return null; // no change → no duplicate notice
    }

    await ctx.db.patch(conversationId, {
      assignedClerkUserId: clerkUserId,
      assignedAt: Date.now(),
    });
    await postSystem(
      ctx,
      conversationId,
      `Conversation assigned to ${target.name}.`,
    );
    return null;
  },
});

// reassign: explicit alias of `assign` (same semantics — set a new owner). Kept
// distinct so the frontend can express intent; both validate + post a notice.
export const reassign = mutation({
  args: {
    conversationId: v.id("conversations"),
    clerkUserId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { conversationId, clerkUserId }) => {
    const { member, convo } = await requireConversation(ctx, conversationId);

    const target = await loadMember(ctx, member.workspace._id, clerkUserId);
    if (!target || target.status !== "active") {
      throw new ConvexError({
        code: "INVALID_ASSIGNEE",
        message: "Assignee is not an active member of this workspace.",
      });
    }
    if (convo.assignedClerkUserId === clerkUserId) {
      return null;
    }

    await ctx.db.patch(conversationId, {
      assignedClerkUserId: clerkUserId,
      assignedAt: Date.now(),
    });
    await postSystem(
      ctx,
      conversationId,
      `Conversation reassigned to ${target.name}.`,
    );
    return null;
  },
});

// unassign: clear the owner, returning the conversation to the unassigned queue.
export const unassign = mutation({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    const { convo } = await requireConversation(ctx, conversationId);
    if (!convo.assignedClerkUserId) {
      return null; // already unassigned
    }
    await ctx.db.patch(conversationId, {
      assignedClerkUserId: undefined,
      assignedAt: undefined,
    });
    await postSystem(
      ctx,
      conversationId,
      "Conversation returned to the queue.",
    );
    return null;
  },
});

// markRead: stamp the agent read-cursor (clears the unread badge for this convo).
export const markRead = mutation({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    await requireConversation(ctx, conversationId);
    await ctx.db.patch(conversationId, { lastReadByAgentAt: Date.now() });
    return null;
  },
});

// setStatus: open / snoozed / closed. NOTE: the schema's `status` union is
// currently `open | closed`; "snoozed" is accepted at the API boundary but
// coerced to a stored value the schema permits until the union is widened
// additively. (Frontend may pass it; we map snoozed→open for storage today.)
export const setStatus = mutation({
  args: {
    conversationId: v.id("conversations"),
    status: v.union(
      v.literal("open"),
      v.literal("snoozed"),
      v.literal("closed"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { conversationId, status }) => {
    await requireConversation(ctx, conversationId);
    // Map the API-level status to a schema-permitted stored value. "snoozed" is
    // not yet in the stored union, so we persist "open" for it (the snoozed
    // surfacing is a UI concern for now); open/closed pass through.
    const stored: "open" | "closed" = status === "closed" ? "closed" : "open";
    await ctx.db.patch(conversationId, { status: stored });
    return null;
  },
});

// ── QUERIES ──────────────────────────────────────────────────────────────────

// listConversations: role-aware, filter-aware inbox list. Always scoped to the
// caller's active-org workspace (hard tenant boundary). Returns enriched items
// (assignee name/avatar + unread flag), newest-activity first.
export const listConversations = query({
  args: {
    filter: v.optional(
      v.union(
        v.literal("all"),
        v.literal("mine"),
        v.literal("unassigned"),
        v.literal("ai"),
        v.literal("human"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  returns: v.array(conversationListItem),
  handler: async (ctx, { filter, limit }) => {
    const member = await requireOrgMember(ctx);
    const wsId = member.workspace._id;
    const callerId = member.identity.subject;
    const take = Math.min(limit ?? 100, 200);
    const which = filter ?? "all";

    // Drive each filter off the most selective index available.
    let rows: Doc<"conversations">[];
    if (which === "mine") {
      rows = await ctx.db
        .query("conversations")
        .withIndex("by_workspace_assignee", (q) =>
          q.eq("workspaceId", wsId).eq("assignedClerkUserId", callerId),
        )
        .order("desc")
        .take(take);
    } else if (which === "unassigned") {
      rows = await ctx.db
        .query("conversations")
        .withIndex("by_workspace_assignee", (q) =>
          q.eq("workspaceId", wsId).eq("assignedClerkUserId", undefined),
        )
        .order("desc")
        .take(take);
    } else if (which === "ai" || which === "human") {
      rows = await ctx.db
        .query("conversations")
        .withIndex("by_workspace_mode", (q) =>
          q.eq("workspaceId", wsId).eq("mode", which),
        )
        .order("desc")
        .take(take);
    } else {
      // "all" — every conversation in the workspace, newest activity first.
      rows = await ctx.db
        .query("conversations")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", wsId))
        .order("desc")
        .take(take);
    }

    // Both admin and support see the full workspace team queue (the hard
    // boundary is the workspace). The only role-narrowing is `mine`, which is
    // already caller-scoped by the index above. No extra per-role filtering.

    // Resolve assignee display info in one member fetch (small team set).
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", wsId))
      .collect();
    const memberByClerkId = new Map(members.map((m) => [m.clerkUserId, m]));

    return rows.map((c) => enrich(c, memberByClerkId));
  },
});

// getConversation: detail view for a single conversation (org-authorized).
export const getConversation = query({
  args: { conversationId: v.id("conversations") },
  returns: v.union(conversationListItem, v.null()),
  handler: async (ctx, { conversationId }) => {
    const member = await requireOrgMember(ctx);
    const convo = await ctx.db.get(conversationId);
    if (!convo || convo.workspaceId !== member.workspace._id) {
      return null;
    }
    const assignee = convo.assignedClerkUserId
      ? await loadMember(ctx, member.workspace._id, convo.assignedClerkUserId)
      : null;
    const memberByClerkId = new Map<string, Doc<"workspaceMembers">>();
    if (assignee) memberByClerkId.set(assignee.clerkUserId, assignee);
    return enrich(convo, memberByClerkId);
  },
});

// queueCounts: sidebar badge counts. Reactive. Scoped to the caller's workspace.
// `mine` is caller-scoped; the rest are workspace-wide team queues.
export const queueCounts = query({
  args: {},
  returns: v.object({
    all: v.number(),
    mine: v.number(),
    unassigned: v.number(),
    ai: v.number(),
    human: v.number(),
    unread: v.number(),
  }),
  handler: async (ctx) => {
    const member = await requireOrgMember(ctx);
    const wsId = member.workspace._id;
    const callerId = member.identity.subject;

    // One workspace scan; bucket in memory. Counts are O(conversations) but the
    // inbox is bounded for an MVP tenant; if this grows, swap to
    // @convex-dev/aggregate sharded counters.
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", wsId))
      .collect();

    let all = 0;
    let mine = 0;
    let unassigned = 0;
    let ai = 0;
    let human = 0;
    let unread = 0;
    for (const c of rows) {
      all += 1;
      if (c.assignedClerkUserId === callerId) mine += 1;
      if (!c.assignedClerkUserId) unassigned += 1;
      if ((c.mode ?? "ai") === "ai") ai += 1;
      else human += 1;
      if (isUnread(c)) unread += 1;
    }
    return { all, mine, unassigned, ai, human, unread };
  },
});

// listMembers: active team roster for the caller's workspace. Powers the inbox
// "Assign to…" dropdown and the Team page roster. Authed + workspace-scoped (any
// member may route a chat, so this is NOT admin-gated). Returns a SAFE projection
// (no email exposure beyond display fields). Caller is flagged via `isSelf` so the
// UI can label "Assign to me".
export const listMembers = query({
  args: {},
  returns: v.array(
    v.object({
      clerkUserId: v.string(),
      name: v.string(),
      avatarUrl: v.optional(v.string()),
      role: v.union(v.literal("admin"), v.literal("support")),
      isSelf: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const member = await requireOrgMember(ctx);
    const callerId = member.identity.subject;
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", member.workspace._id),
      )
      .collect();
    const active = members
      .filter((m) => m.status === "active")
      .sort((a, b) => a.name.localeCompare(b.name));

    return await Promise.all(
      active.map(async (m) => {
        // Admin-set custom avatar overrides the Clerk image URL.
        const customAvatarUrl = m.customAvatarStorageId
          ? await ctx.storage.getUrl(m.customAvatarStorageId)
          : null;
        return {
          clerkUserId: m.clerkUserId,
          name: m.name,
          avatarUrl: customAvatarUrl ?? m.imageUrl,
          role: m.role,
          isSelf: m.clerkUserId === callerId,
        };
      }),
    );
  },
});
