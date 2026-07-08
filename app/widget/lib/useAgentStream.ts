"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Token-streaming adapter for the anonymous widget.
//
// The Phase-4 PUBLIC query `api.agentStream.streamBody` is a `syncStreams`
// query keyed on `conversationId` (NOT `threadId`) and returns `{ streams }`.
// The @convex-dev/agent React hooks (`useStreamingUIMessages` / `useDeltaStreams`)
// reassemble token deltas into full-text UIMessages for us — they only read
// `args.threadId` to decide WHEN to reset their delta cursors, and otherwise
// spread `...args` straight into `useQuery`. So they work unchanged with our
// `{ conversationId }` arg at runtime; we just satisfy their TS `StreamQuery`
// shape (which wants a `threadId` key) with a small cast.
//
// We keep `streamBody` 100% stable (it's a PUBLIC fn) and do the adaptation
// purely on the client. The hook returns the in-flight assistant message(s)
// with `.text` (accumulated) + `.status` ("streaming" | "finished" | ...).
// Once run.ts finalises the mirrored `messages` row, the stream reports
// "finished" and `messages.list` becomes authoritative — no dual source.
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useStreamingUIMessages } from "@convex-dev/agent/react";
import type { UIMessage } from "@convex-dev/agent/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// Our streamBody is `{ conversationId, streamArgs } -> { streams }`. The hook's
// internal `StreamQuery` type (not re-exported) wants a `threadId` key, but at
// runtime `useDeltaStreams` only reads `args.threadId` to decide WHEN to reset
// its delta cursors and otherwise spreads `...args` straight into useQuery. So
// it works unchanged with our `{ conversationId }` arg; we cast to satisfy the
// compiler since the public type isn't exposed.
const streamBodyRef = api.agentStream.streamBody as any;

/**
 * Subscribe to the live token stream for a conversation's bridged agent thread.
 * Returns the in-flight assistant UIMessages (usually 0 or 1). Each has:
 *   - `.text`   : accumulated streamed text so far
 *   - `.status` : "streaming" while generating, "finished"/"aborted" when done
 * Returns `undefined` until the first stream-list response resolves.
 */
export function useAgentStream(
  conversationId: Id<"conversations"> | null,
  visitorId: string | null,
): UIMessage[] | undefined {
  return useStreamingUIMessages(
    streamBodyRef,
    conversationId && visitorId
      ? ({ conversationId, visitorId } as any)
      : "skip",
  );
}
