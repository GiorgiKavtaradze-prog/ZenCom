"use node";

// ─────────────────────────────────────────────────────────────────────────────
// The agent RUN action: respondToVisitorMessage({ conversationId }).
//
// This is scheduled (debounced) by messages.sendFromVisitor when a conversation
// is in AI mode. It:
//   1. loads conversation + workspace; aborts if mode !== "ai".
//   2. captures the current agentRunEpoch (the abort token for this run).
//   3. RESERVES one AI message (reserve-then-confirm); refunds on any abort/fail.
//   4. creates an @convex-dev/agent thread if conversation.threadId is unset,
//      and stores it on the conversation (the bridge).
//   5. retrieves RAG context (workspaceId-only vector filter).
//   6. inserts a `pending` agent message row (typing placeholder the widget /
//      dashboard already subscribe to via messages.list), then runs the agent
//      with streamText + tools + the grounded context, saving per-token deltas
//      via the component (genuine streaming for the widget's stream query).
//   7. between/after expensive steps RE-CHECKS mode + epoch and ABORTS (no
//      double/stale reply) if either changed.
//   8. on success, MIRRORS the final assistant text into the same `messages`
//      row (clears `pending`, attaches citations) so the canonical transcript
//      shows it. On OPENAI_NOT_CONFIGURED, posts a graceful system message and
//      refunds. On any failure, refunds + removes the placeholder.
//
// HOW STREAMING + THE MESSAGES-TABLE MIRROR COEXIST:
//   - The agent component owns the per-token `streamDeltas` (read by the public
//     streaming query in agentStream.ts) → live token streaming in the widget.
//   - Our `messages` row is the CANONICAL transcript (read by messages.list).
//     It starts as a `pending` placeholder (drives the typing indicator from
//     schedule time) and is finalized with the full text + citations when the
//     stream completes. The widget shows streaming tokens during generation,
//     then settles on the mirrored row — no dual source-of-truth conflict.
// ─────────────────────────────────────────────────────────────────────────────

import { v, ConvexError } from "convex/values";
import { stepCountIs } from "ai";
import { internalAction, type ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { buildSupportAgent } from "./index";
import { retrieveContext, type Citation } from "./rag";
import { OPENAI_NOT_CONFIGURED_CODE, type UpgradeCard } from "./tools";

const MAX_STEPS = 6; // tool-loop cap (blueprint: stepCountIs(≤6))

export const respondToVisitorMessage = internalAction({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    // ── 1. Load conversation + workspace; abort if not AI mode ───────────────
    const convo = await ctx.runQuery(internal.agent.runHelpers.loadForRun, {
      conversationId,
    });
    if (!convo) return null; // conversation vanished
    if ((convo.mode ?? "ai") !== "ai") return null; // human took over before we started
    const workspace = convo.workspace;
    if (!workspace) return null;

    // ── 2. Capture the abort token for this run ──────────────────────────────
    const runEpoch = convo.agentRunEpoch ?? 0;

    // ── 3. Reserve quota (reserve-then-confirm) ──────────────────────────────
    const reservation = await ctx.runMutation(
      internal.agent.runHelpers.reserveQuota,
      { conversationId, expectedEpoch: runEpoch },
    );
    if (!reservation.ok) {
      // Over quota / inactive / superseded. Post a graceful system message ONCE
      // (only when actually denied by quota, not when superseded) and stop.
      if (reservation.reason !== "superseded") {
        await ctx.runMutation(internal.agent.runHelpers.postSystem, {
          conversationId,
          expectedEpoch: runEpoch,
          body: "Thanks for your message! Our AI assistant is unavailable right now, but a team member will follow up shortly.",
        });
      }
      return null;
    }
    const periodStart = reservation.periodStart;

    // From here on, ANY early return / throw MUST refund. We track whether the
    // reservation has been settled (finalized text written) so refund is exactly
    // once.
    let settled = false;
    const refund = async () => {
      if (settled) return;
      await ctx.runMutation(internal.agent.runHelpers.refundQuota, {
        conversationId,
        periodStart,
      });
    };

    try {
      // ── 4. Ensure an agent thread exists (the bridge) ──────────────────────
      // Build a minimal agent (no key needed for createThread? — createThread
      // does NOT call the model, but buildSupportAgent reads the key. We read it
      // here so OPENAI_NOT_CONFIGURED is caught uniformly below).
      const collected: Citation[] = [];
      // Last upgrade card produced by send_upgrade_link wins (a single reply
      // should only ever surface one upgrade CTA).
      let upgradeCard: UpgradeCard | null = null;
      const agent = buildSupportAgent({
        workspaceName: workspace.name,
        toolDeps: {
          workspaceId: workspace._id,
          conversationId,
          agentRunEpoch: runEpoch,
          collectCitations: (cs) => collected.push(...cs),
          collectUpgradeCard: (card) => {
            upgradeCard = card;
          },
        },
      });

      let threadId = convo.threadId ?? null;
      if (!threadId) {
        const created = await agent.createThread(ctx, {
          title: `conversation:${conversationId}`,
        });
        threadId = created.threadId;
        // Persist the bridge (idempotent; only if still this run + AI mode).
        await ctx.runMutation(internal.agent.runHelpers.setThreadId, {
          conversationId,
          threadId,
          expectedEpoch: runEpoch,
        });
      }

      // Re-check abort after thread setup.
      if (await isAborted(ctx, conversationId, runEpoch)) {
        await refund();
        return null;
      }

      // ── 5. Retrieve RAG context (workspaceId-only vector filter) ───────────
      const visitorText = convo.lastVisitorBody ?? "";
      const retrieval = await retrieveContext(ctx, workspace._id, visitorText);
      // Seed citations from the pre-fetch (tools may add more).
      collected.push(...retrieval.citations);

      // Re-check abort after the (slow) embedding + vector search.
      if (await isAborted(ctx, conversationId, runEpoch)) {
        await refund();
        return null;
      }

      // ── 6. Insert the pending placeholder (typing indicator anchor) ────────
      const placeholder = await ctx.runMutation(
        internal.agent.runHelpers.insertPendingAgentMessage,
        { conversationId, expectedEpoch: runEpoch },
      );
      if (!placeholder.ok) {
        // Superseded between checks — abort cleanly.
        await refund();
        return null;
      }
      const pendingMessageId = placeholder.messageId;

      // ── 7. Run the agent (streamText + tools + grounded context) ───────────
      // The grounded, delimiter-wrapped context is delivered as a `system`
      // augmentation in `messages` so it is treated as reference data; the
      // visitor text is the user prompt. saveStreamDeltas persists per-token
      // deltas for the public streaming query.
      const result = await agent.streamText(
        ctx,
        { threadId },
        {
          messages: [
            {
              role: "system",
              content: retrieval.contextBlock,
            },
          ],
          prompt: visitorText,
          tools: agent.options.tools,
          stopWhen: stepCountIs(MAX_STEPS),
        },
        { saveStreamDeltas: true },
      );

      // Drain the stream so deltas are persisted AND we get the final text.
      await result.consumeStream();
      const finalText = (await result.text).trim();

      // ── 7b. Final abort check (takeover could have landed mid-generation) ──
      if (await isAborted(ctx, conversationId, runEpoch)) {
        // A human took over while we generated. Remove our placeholder, refund,
        // and let the human own the conversation. The streamed deltas are on the
        // agent thread but never mirrored to the canonical transcript.
        await ctx.runMutation(internal.agent.runHelpers.discardPending, {
          messageId: pendingMessageId,
        });
        await refund();
        return null;
      }

      // ── 8. Finalize: mirror the assistant text into the messages row ───────
      const citations = dedupeCitations(collected);
      await ctx.runMutation(internal.agent.runHelpers.finalizeAgentMessage, {
        messageId: pendingMessageId,
        conversationId,
        body:
          finalText.length > 0
            ? finalText
            : "I'm sorry, I wasn't able to put together an answer. Let me connect you with a team member.",
        citations,
        upgradeCard: upgradeCard ?? undefined,
      });
      settled = true; // confirmed — DO NOT refund.
      return null;
    } catch (err) {
      // OPENAI_NOT_CONFIGURED → graceful system message + refund.
      const code =
        err instanceof ConvexError &&
        typeof err.data === "object" &&
        err.data !== null &&
        "code" in err.data
          ? (err.data as { code?: string }).code
          : undefined;

      if (code === OPENAI_NOT_CONFIGURED_CODE) {
        await ctx.runMutation(internal.agent.runHelpers.postSystem, {
          conversationId,
          expectedEpoch: runEpoch,
          body: "Thanks for your message! A team member will follow up with you shortly.",
        });
        await refund();
        return null;
      }

      // Any other failure: refund + surface nothing to the visitor beyond a
      // gentle system note (the pending row, if any, is cleaned up here too).
      await ctx.runMutation(internal.agent.runHelpers.cleanupOnError, {
        conversationId,
        expectedEpoch: runEpoch,
      });
      await refund();
      // Re-throw so the failure is visible in convex logs / _scheduled_functions.
      throw err;
    }
  },
});

// Abort predicate: re-read the conversation and compare mode + epoch. A takeover
// (mode→human) or a newer visitor message (epoch bump) means this run is stale.
async function isAborted(
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
  runEpoch: number,
): Promise<boolean> {
  const state = await ctx.runQuery(internal.agent.runHelpers.checkRunState, {
    conversationId,
  });
  if (!state) return true;
  if ((state.mode ?? "ai") !== "ai") return true;
  if ((state.agentRunEpoch ?? 0) !== runEpoch) return true;
  return false;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = `${c.title ?? ""}|${c.url ?? ""}`;
    if (key === "|") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chunkId: c.chunkId, title: c.title, url: c.url });
    if (out.length >= 6) break;
  }
  return out;
}
