"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// Heartbeat cadence (ms). The component treats a user as offline once it stops
// hearing heartbeats for ~2.5x this interval, so 10s is responsive but cheap.
const HEARTBEAT_INTERVAL_MS = 10_000;

export type RosterEntry = {
  clerkUserId: string;
  online: boolean;
  lastDisconnected: number;
  name?: string;
  avatarUrl?: string;
  typingConversationId?: Id<"conversations">;
  activeConversationId?: Id<"conversations">;
};

// Mint a stable per-tab session id (survives re-renders, distinct per tab).
function useSessionId(): string {
  const ref = useRef<string | null>(null);
  if (ref.current === null) {
    ref.current =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
  }
  return ref.current;
}

/**
 * Drives the authed dashboard presence loop:
 *  - heartbeats every HEARTBEAT_INTERVAL_MS into the workspace room
 *  - attaches the active/typing conversation context so teammates can see it
 *  - returns the live roster (resolved names/avatars + typing flags)
 *
 * `activeConversationId` / `typingConversationId` are optional context broadcast
 * to teammates. They re-broadcast immediately when they change (no waiting for
 * the next interval tick) so "X is typing" feels live.
 */
export function usePresence(opts?: {
  enabled?: boolean;
  activeConversationId?: Id<"conversations"> | null;
  typingConversationId?: Id<"conversations"> | null;
}): {
  roster: RosterEntry[];
  onlineCount: number;
} {
  const enabled = opts?.enabled ?? true;
  const sessionId = useSessionId();
  const heartbeat = useMutation(api.presence.heartbeat);
  const disconnect = useMutation(api.presence.disconnect);

  const [roomToken, setRoomToken] = useState<string | null>(null);
  const sessionTokenRef = useRef<string | null>(null);

  const data = useMemo(() => {
    const d: {
      typingConversationId?: Id<"conversations">;
      activeConversationId?: Id<"conversations">;
    } = {};
    if (opts?.typingConversationId)
      d.typingConversationId = opts.typingConversationId;
    if (opts?.activeConversationId)
      d.activeConversationId = opts.activeConversationId;
    return d;
  }, [opts?.typingConversationId, opts?.activeConversationId]);

  // Heartbeat loop. Re-pings immediately whenever the broadcast `data` changes
  // (active/typing context) and then on a fixed interval.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const ping = async () => {
      try {
        const tokens = await heartbeat({
          sessionId,
          interval: HEARTBEAT_INTERVAL_MS,
          data: Object.keys(data).length > 0 ? data : undefined,
        });
        if (cancelled) return;
        sessionTokenRef.current = tokens.sessionToken;
        setRoomToken(tokens.roomToken);
      } catch {
        // Transient auth/token hiccup — the next interval retries.
      }
    };

    void ping();
    const id = setInterval(() => void ping(), HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, heartbeat, sessionId, data]);

  // Graceful leave on tab close (best-effort).
  useEffect(() => {
    if (!enabled) return;
    const onLeave = () => {
      const token = sessionTokenRef.current;
      if (token) void disconnect({ sessionToken: token });
    };
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [enabled, disconnect]);

  const roster = useQuery(
    api.presence.list,
    enabled && roomToken ? { roomToken } : "skip",
  );

  const entries: RosterEntry[] = roster ?? [];
  const onlineCount = entries.filter((r) => r.online).length;
  return { roster: entries, onlineCount };
}
