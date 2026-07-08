// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC streaming read for the widget (Phase 6 will consume).
//
// The agent component persists per-token stream deltas (run.ts passes
// `saveStreamDeltas: true`). This query bridges them to the anonymous widget:
// given a `conversationId` (validated via ctx.db.get — never trust a raw client
// id), it resolves the bridged `threadId` and returns the agent's streaming
// assistant message + deltas via the standalone `syncStreams(ctx, component,…)`.
//
// The widget subscribes to BOTH:
//   - messages.list           → the canonical transcript (mirrored final text).
//   - agentStream.streamBody  → live token deltas DURING generation.
// They coexist: deltas animate the in-flight reply; once run.ts finalizes the
// `pending` `messages` row, the transcript shows the settled message and the
// stream for that thread reports "finished". `messages` is authoritative; the
// stream is a transient overlay — no dual source-of-truth conflict.
//
// VERIFIED API (0.6.3): the package root exports a standalone
// `syncStreams(ctx, component, { threadId, streamArgs, includeStatuses })`
// (no Agent instance / no languageModel needed for reads), plus `vStreamArgs`
// (args validator) and `vStreamMessagesReturnValue` (return validator) — the
// exact contract the React `useStreamingThreadMessages` / `syncStreams` hooks
// expect.
//
// DEFAULT runtime (V8): reads only via the component, no Node deps, no API key —
// safe to bundle/push without OPENAI_API_KEY and cheap to keep reactive.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { query } from "./_generated/server";
import { components } from "./_generated/api";
import { syncStreams, vStreamArgs } from "@convex-dev/agent";
import { vStreamMessage, vStreamDelta } from "@convex-dev/agent/validators";

// Return validator matching the bare `SyncStreamsReturnValue`:
//   { kind: "list", messages: StreamMessage[] }
// | { kind: "deltas", deltas: StreamDelta[] }
// | undefined
// built from the component's own exported part validators.
const vSyncStreamsResult = v.union(
  v.object({ kind: v.literal("list"), messages: v.array(vStreamMessage) }),
  v.object({ kind: v.literal("deltas"), deltas: v.array(vStreamDelta) }),
);

// An EMPTY result that still matches the requested `streamArgs.kind`. The
// React hook (`useDeltaStreams`) reads `streamList.streams.messages`
// unconditionally once the query resolves, so returning `{ streams: undefined }`
// for the no-thread case crashes it ("Cannot read properties of undefined
// (reading 'messages')"). For a `list` request we must hand back an empty
// `messages` array (and likewise empty `deltas` for a `deltas` request); only a
// genuinely missing `streamArgs` maps to `undefined`, which the hook tolerates.
function emptyStreamsResult(
  streamArgs: typeof vStreamArgs.type,
): { kind: "list"; messages: [] } | { kind: "deltas"; deltas: [] } | undefined {
  if (!streamArgs) return undefined;
  return streamArgs.kind === "list"
    ? { kind: "list", messages: [] }
    : { kind: "deltas", deltas: [] };
}

// Public: stream deltas for the conversation's bridged agent thread.
// When there is no thread yet (AI hasn't run) we return an EMPTY stream result
// shaped to the requested kind so the widget renders nothing until generation
// starts — without violating the hook's `streams.messages` access contract.
export const streamBody = query({
  args: {
    conversationId: v.id("conversations"),
    visitorId: v.string(),
    streamArgs: vStreamArgs,
  },
  returns: v.object({
    streams: v.optional(vSyncStreamsResult),
  }),
  handler: async (ctx, { conversationId, visitorId, streamArgs }) => {
    // Validate existence AND ownership — the anonymous caller must be the
    // conversation's visitor, otherwise we'd stream another visitor's in-flight
    // reply (IDOR). No thread yet → empty stream shaped to the requested kind.
    const convo = await ctx.db.get(conversationId);
    if (!convo || !convo.threadId || convo.visitorId !== visitorId) {
      return { streams: emptyStreamsResult(streamArgs) };
    }

    const streams = await syncStreams(ctx, components.agent, {
      threadId: convo.threadId,
      streamArgs,
      // Surface in-progress + just-finished streams; the widget settles on the
      // mirrored messages row once finished.
      includeStatuses: ["streaming", "finished"],
    });

    return { streams: streams ?? emptyStreamsResult(streamArgs) };
  },
});
