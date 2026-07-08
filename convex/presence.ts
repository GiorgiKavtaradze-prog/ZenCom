import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { Presence } from "@convex-dev/presence";
import { requireOrgMember } from "./lib/auth";
import type { Doc } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Presence (wraps @convex-dev/presence, registered as
// components.presence in convex.config.ts).
//
// VERIFIED against the component's client API (node_modules/@convex-dev/presence
// dist/client/index.d.ts):
//   heartbeat(ctx, roomId, userId, sessionId, interval)
//       → { roomToken, sessionToken }   (mutation)
//   list(ctx, roomToken, limit?)
//       → [{ userId, online, lastDisconnected, data? }]   (query)
//   listRoom(ctx, roomId, onlineOnly?, limit?)
//       → [{ userId, online, lastDisconnected }]   (query; raw roomId, NO token)
//   updateRoomUser(ctx, roomId, userId, data?)   (mutation)
//   disconnect(ctx, sessionToken)   (mutation)
//
// ROOM MODEL: the room id is the `workspaceId` string. Every agent in a
// workspace shares one room, so `list`/`listRoom` is the team roster. Per-user
// `data` carries the optional typing/active-conversation context.
//
// TWO READ PATHS:
//   1. AUTHED dashboard — agents call `heartbeat` (mutation), then `list`
//      (query) with the returned roomToken. Standard component flow; the
//      roomToken keeps the subscription cache shared across all agents.
//   2. PUBLIC widget roster — the anonymous widget NEVER heartbeats and has no
//      roomToken. It calls `publicRoster(workspaceId)`, which uses the
//      `listRoom(roomId)` helper (raw roomId, no token) and projects a SAFE
//      shape: member display name + avatar + online bool ONLY. No clerk ids, no
//      emails, no session/room tokens leave the server.
// ─────────────────────────────────────────────────────────────────────────────

export const presence = new Presence(components.presence);

// ── AUTHED dashboard presence ────────────────────────────────────────────────

// heartbeat: an authed agent reports they're online in their workspace room.
// The widget surface never calls this — it's gated behind org membership. The
// `sessionId` is a per-tab id minted client-side; `interval` is the client's
// heartbeat cadence (ms). Optional `data` carries typing/active-conversation
// context surfaced to teammates (NOT to the public widget).
export const heartbeat = mutation({
  args: {
    sessionId: v.string(),
    interval: v.number(),
    data: v.optional(
      v.object({
        typingConversationId: v.optional(v.id("conversations")),
        activeConversationId: v.optional(v.id("conversations")),
      }),
    ),
  },
  returns: v.object({ roomToken: v.string(), sessionToken: v.string() }),
  handler: async (ctx, { sessionId, interval, data }) => {
    const member = await requireOrgMember(ctx);
    const roomId = member.workspace._id; // room = workspace
    const userId = member.identity.subject; // Clerk user id

    const tokens = await presence.heartbeat(
      ctx,
      roomId,
      userId,
      sessionId,
      interval,
    );

    // Attach per-user typing/active context for teammates (best-effort).
    if (data) {
      await presence.updateRoomUser(ctx, roomId, userId, data);
    }
    return tokens;
  },
});

// list: AUTHED roster for the dashboard, keyed by the roomToken from heartbeat.
// Returns the component's full per-user state (incl. clerkUserId + arbitrary
// `data`) — safe here because the caller is an authed org member. We enrich each
// online member with their mirrored name/avatar for the dashboard "who's online".
export const list = query({
  args: { roomToken: v.string() },
  returns: v.array(
    v.object({
      clerkUserId: v.string(),
      online: v.boolean(),
      lastDisconnected: v.number(),
      name: v.optional(v.string()),
      avatarUrl: v.optional(v.string()),
      typingConversationId: v.optional(v.id("conversations")),
      activeConversationId: v.optional(v.id("conversations")),
    }),
  ),
  handler: async (ctx, { roomToken }) => {
    const member = await requireOrgMember(ctx);
    const presenceRows = await presence.list(ctx, roomToken);

    // Resolve display info from the workspace member mirror (one small fetch).
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", member.workspace._id),
      )
      .collect();
    const byId = new Map<string, Doc<"workspaceMembers">>(
      members.map((m) => [m.clerkUserId, m]),
    );

    return await Promise.all(
      presenceRows.map(async (row) => {
        const data = (row.data ?? {}) as {
          typingConversationId?: string;
          activeConversationId?: string;
        };
        const m = byId.get(row.userId);
        // Admin-set custom avatar overrides the Clerk image URL.
        const customAvatarUrl = m?.customAvatarStorageId
          ? await ctx.storage.getUrl(m.customAvatarStorageId)
          : null;
        return {
          clerkUserId: row.userId,
          online: row.online,
          lastDisconnected: row.lastDisconnected,
          name: m?.name,
          avatarUrl: customAvatarUrl ?? m?.imageUrl,
          typingConversationId: data.typingConversationId as
            | Doc<"conversations">["_id"]
            | undefined,
          activeConversationId: data.activeConversationId as
            | Doc<"conversations">["_id"]
            | undefined,
        };
      }),
    );
  },
});

// disconnect: graceful leave. Called over HTTP via sendBeacon on tab close (no
// auth context available there — the sessionToken is the capability). Mirrors
// the component's recommended unauthenticated disconnect path.
export const disconnect = mutation({
  args: { sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionToken }) => {
    await presence.disconnect(ctx, sessionToken);
    return null;
  },
});

// ── PUBLIC widget roster projection ──────────────────────────────────────────

// publicRoster: SAFE team roster for the ANONYMOUS widget header. Validates the
// workspace exists (never trust a client workspaceId blindly), then projects the
// presence room down to display name + avatar + online bool ONLY. NO clerk ids,
// NO emails, NO tokens. Uses `listRoom(roomId)` (raw roomId helper) since the
// anonymous widget has no roomToken. Online status reflects whether ANY agent in
// the workspace is currently present — drives the widget's "We're online" badge.
export const publicRoster = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    anyOnline: v.boolean(),
    members: v.array(
      v.object({
        name: v.string(),
        avatarUrl: v.optional(v.string()),
        online: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, { workspaceId }) => {
    const ws = await ctx.db.get(workspaceId);
    if (!ws) {
      throw new ConvexError({ code: "UNKNOWN_WORKSPACE" });
    }

    // All agents currently/recently present in the workspace room.
    const presenceRows = await presence.listRoom(ctx, workspaceId, false, 20);
    const onlineByClerkId = new Map<string, boolean>(
      presenceRows.map((r) => [r.userId, r.online]),
    );

    // Project the active member mirror to a SAFE shape. We show active members
    // (the public-facing team), tagging online status from presence. Members
    // never seen by presence are shown as offline (the widget still renders the
    // team avatars; the "online" dot lights only for present agents).
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();

    // Project + order first (online members first, then by name), then resolve
    // storage URLs only for the (≤8) members we actually return. A member's
    // admin-set custom avatar overrides the Clerk image URL.
    const ordered = members
      .filter((m) => m.status === "active")
      .map((m) => ({
        member: m,
        online: onlineByClerkId.get(m.clerkUserId) ?? false,
      }))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.member.name.localeCompare(b.member.name);
      })
      .slice(0, 8);

    const roster = await Promise.all(
      ordered.map(async ({ member: m, online }) => {
        const customAvatarUrl = m.customAvatarStorageId
          ? await ctx.storage.getUrl(m.customAvatarStorageId)
          : null;
        return {
          name: m.name,
          avatarUrl: customAvatarUrl ?? m.imageUrl,
          online,
        };
      }),
    );

    const anyOnline = roster.some((m) => m.online);
    return { anyOnline, members: roster };
  },
});
