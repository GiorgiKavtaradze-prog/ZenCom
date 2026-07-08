"use node";

// ─────────────────────────────────────────────────────────────────────────────
// The 7 support tools (@convex-dev/agent createTool API, verified for 0.6.3:
// `{ description, inputSchema (zod), execute(ctx, input, options) }` — `args`
// and `handler` were removed in 0.6.0).
//
// SECURITY CONTRACT (blueprint cross-cutting): every tool is workspace-scoped via
// a SERVER-RESOLVED closure — `workspaceId` and `conversationId` are baked in
// when the agent is constructed for a specific conversation, NEVER taken from
// model free-text (which can originate in a retrieved, untrusted chunk). The
// model only chooses semantic args (a query string, a voluntarily-supplied
// email). All DB work is delegated to the default-runtime mutations/queries in
// `internal.ts` via `ctx.runQuery`/`ctx.runMutation`, so these Node tools never
// touch `ctx.db` directly.
// ─────────────────────────────────────────────────────────────────────────────

import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import type { ToolSet } from "ai";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { retrieveContext, type Citation } from "./rag";

export const OPENAI_NOT_CONFIGURED_CODE = "OPENAI_NOT_CONFIGURED";

// The relative path to the billing page (the widget iframe is served from the
// app's own origin, so a relative URL resolves to the dashboard). Opened in a
// new tab by the card so it never navigates the embedded widget.
const BILLING_PAGE_URL = "/dashboard/billing";

// A rich "widget" card the agent can attach to its reply — currently only the
// upgrade card (CTA → billing page). Mirrored onto the final `messages` row by
// the run action and rendered as an interactive card in the widget transcript.
export type UpgradeCard = {
  title: string;
  description: string;
  ctaLabel: string;
  url: string;
};

// Server-resolved dependencies, closed over per conversation. NOTHING here is
// model-controlled.
export type SupportToolDeps = {
  workspaceId: Id<"workspaces">;
  conversationId: Id<"conversations">;
  // Bumped per visitor message / takeover. Tools that mutate conversation state
  // (escalate) pass it so the mutation can no-op on a stale run.
  agentRunEpoch: number;
  // Collects citations produced by retrieval tools during this run so the run
  // action can mirror them onto the final `messages` row.
  collectCitations: (citations: Citation[]) => void;
  // Records an upgrade card produced by `send_upgrade_link` so the run action
  // can mirror it onto the final `messages` row (last one wins).
  collectUpgradeCard: (card: UpgradeCard) => void;
};

// Email shape guard (server-side) for capture_lead. Mirrors the leads contract:
// email required + length-capped; never sourced from retrieved content.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildSupportTools(deps: SupportToolDeps): ToolSet {
  // 1) search_knowledge_base — semantic RAG over this workspace's chunks.
  const search_knowledge_base = createTool({
    description:
      "Search this workspace's knowledge base for passages relevant to a question. Returns grounded reference material with source titles. Use this to answer factual questions about the product/service.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(400)
        .describe("The visitor's question or the key phrase to look up."),
    }),
    execute: async (ctx, { query }) => {
      const actionCtx = ctx as unknown as ActionCtx;
      const result = await retrieveContext(actionCtx, deps.workspaceId, query);
      if (result.citations.length > 0) deps.collectCitations(result.citations);
      if (result.matches.length === 0) {
        return {
          found: false,
          aboveThreshold: false,
          context:
            "No relevant knowledge-base content was found for this query. Do not answer from outside knowledge; consider escalate_to_human or cannot_help.",
          sources: [],
        };
      }
      return {
        found: true,
        aboveThreshold: result.aboveThreshold,
        // Pre-wrapped in UNTRUSTED-CONTENT delimiters by rag.ts.
        context: result.contextBlock,
        sources: result.citations.map((c) => ({
          title: c.title ?? "Untitled",
          url: c.url,
        })),
      };
    },
  });

  // 2) search_helpdesk_articles — full-text helpdesk search (published only).
  const search_helpdesk_articles = createTool({
    description:
      "Full-text search of this workspace's published helpdesk articles by keyword. Returns article titles, slugs, and excerpts the visitor can read.",
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe("Keywords to search for."),
      category: z
        .string()
        .max(120)
        .optional()
        .describe("Optional category to narrow the search."),
    }),
    execute: async (ctx, { query, category }) => {
      const actionCtx = ctx as unknown as ActionCtx;
      const articles = await actionCtx.runQuery(
        internal.agent.internal.searchHelpdesk,
        {
          workspaceId: deps.workspaceId,
          query,
          category,
        },
      );
      return { count: articles.length, articles };
    },
  });

  // 3) get_faq — the workspace's "popular" / FAQ articles, for quick deflection.
  const get_faq = createTool({
    description:
      "Fetch this workspace's most popular (FAQ) helpdesk articles. Use when the visitor asks a general 'how do I' question or you want to offer common answers.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("How many FAQ entries to return (default 5)."),
    }),
    execute: async (ctx, { limit }) => {
      const actionCtx = ctx as unknown as ActionCtx;
      const faqs = await actionCtx.runQuery(internal.agent.internal.getFaq, {
        workspaceId: deps.workspaceId,
        limit: limit ?? 5,
      });
      return { count: faqs.length, faqs };
    },
  });

  // 4) capture_lead — persist a VOLUNTARILY-provided contact. Email validated
  // server-side; workspaceId/conversationId are server-resolved, not model text.
  const capture_lead = createTool({
    description:
      "Save the visitor's contact details so a human can follow up. ONLY call this when the visitor has voluntarily provided their email (and optionally name). Never invent contact details.",
    inputSchema: z.object({
      email: z
        .string()
        .min(3)
        .max(254)
        .describe("The visitor's email address, exactly as they gave it."),
      firstName: z.string().max(100).optional(),
      lastName: z.string().max(100).optional(),
    }),
    execute: async (ctx, { email, firstName, lastName }) => {
      const normalized = email.trim().toLowerCase();
      if (!EMAIL_RE.test(normalized) || normalized.length > 254) {
        return {
          ok: false,
          message:
            "That does not look like a valid email address. Ask the visitor to confirm it.",
        };
      }
      const actionCtx = ctx as unknown as ActionCtx;
      await actionCtx.runMutation(internal.agent.internal.captureLead, {
        workspaceId: deps.workspaceId,
        conversationId: deps.conversationId,
        email: normalized,
        firstName: firstName?.trim() || undefined,
        lastName: lastName?.trim() || undefined,
      });
      return {
        ok: true,
        message:
          "Contact captured. Tell the visitor a team member will follow up by email.",
      };
    },
  });

  // 5) escalate_to_human — flip the conversation to human mode, bump epoch, post
  // a system message. The mutation re-checks the epoch to avoid acting on a
  // stale run. workspaceId/conversationId server-resolved.
  const escalate_to_human = createTool({
    description:
      "Hand the conversation off to a human agent. Use when you are unsure, the request is out of scope, the visitor is frustrated or explicitly asks for a person, or the task needs an action you cannot perform.",
    inputSchema: z.object({
      reason: z
        .string()
        .max(300)
        .optional()
        .describe("Short internal note on why you're escalating."),
    }),
    execute: async (ctx, { reason }) => {
      const actionCtx = ctx as unknown as ActionCtx;
      const res = await actionCtx.runMutation(
        internal.agent.internal.escalateToHuman,
        {
          conversationId: deps.conversationId,
          workspaceId: deps.workspaceId,
          expectedEpoch: deps.agentRunEpoch,
          reason: reason?.slice(0, 300),
        },
      );
      return {
        escalated: res.escalated,
        message: res.escalated
          ? "This conversation is now with a human. Tell the visitor a team member will take over shortly, then stop."
          : "Escalation was superseded by a newer event; do not send further messages.",
      };
    },
  });

  // 6) suggest_articles — return helpdesk article links for the visitor to read.
  const suggest_articles = createTool({
    description:
      "Suggest relevant published helpdesk articles for the visitor to read. Returns titles and slugs to link. Use to deflect or supplement an answer.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(200)
        .describe("Topic to find related articles for."),
      limit: z.number().int().min(1).max(5).optional(),
    }),
    execute: async (ctx, { query, limit }) => {
      const actionCtx = ctx as unknown as ActionCtx;
      const articles = await actionCtx.runQuery(
        internal.agent.internal.searchHelpdesk,
        {
          workspaceId: deps.workspaceId,
          query,
          limit: limit ?? 3,
        },
      );
      // Surface these as citations on the final message too.
      if (articles.length > 0) {
        deps.collectCitations(
          articles.map((a) => ({
            title: a.title,
            url: `/articles/${a.slug}`,
          })),
        );
      }
      return {
        count: articles.length,
        articles: articles.map((a) => ({
          title: a.title,
          slug: a.slug,
          excerpt: a.excerpt,
        })),
      };
    },
  });

  // 7) cannot_help — graceful fallback for out-of-scope / unanswerable asks.
  // Intentionally side-effect-free: it just signals intent to the model so it
  // produces a polite decline. (Escalation, if appropriate, is a separate tool.)
  const cannot_help = createTool({
    description:
      "Signal that you cannot help with this request because it is out of scope or not covered by the knowledge base. Use this instead of guessing. After calling it, give the visitor a brief, polite decline and offer to connect them with a human if relevant.",
    inputSchema: z.object({
      reason: z
        .string()
        .max(300)
        .optional()
        .describe("Why you cannot help (out of scope / no KB coverage)."),
    }),
    execute: async (_ctx, { reason }) => {
      return {
        acknowledged: true,
        guidance:
          "Politely tell the visitor you can only help with this workspace's support topics" +
          (reason ? ` (${reason})` : "") +
          ", and offer to connect them with a human if they'd like.",
      };
    },
  });

  // 8) send_upgrade_link — attach an upgrade "widget" card that links to the
  // billing page. Side-effect is purely presentational: it records a card the
  // run action mirrors onto the final message. The destination URL is
  // server-controlled (never model text) so the model cannot redirect visitors.
  const send_upgrade_link = createTool({
    description:
      "Show the visitor an upgrade card with a button that links to the billing page where they can change their plan. Use this when the visitor asks about upgrading, pricing tiers, increasing limits or seats, unlocking a paid feature, or otherwise wants to move to a higher plan.",
    inputSchema: z.object({
      plan: z
        .enum(["pro", "scale"])
        .optional()
        .describe(
          "The specific plan to suggest, if the visitor named one. Omit to offer a general 'view plans' upgrade.",
        ),
      reason: z
        .string()
        .max(160)
        .optional()
        .describe(
          "A short, visitor-facing reason for upgrading to personalize the card, e.g. 'to unlock website crawling' or 'for more AI messages'.",
        ),
    }),
    execute: async (_ctx, { plan, reason }) => {
      const target = plan === "scale" ? "Scale" : plan === "pro" ? "Pro" : null;
      const reasonText = reason?.trim().slice(0, 160);
      deps.collectUpgradeCard({
        title: target ? `Upgrade to ${target}` : "Upgrade your plan",
        description: reasonText
          ? `${reasonText.charAt(0).toUpperCase()}${reasonText.slice(1)}.`
          : "Unlock higher limits and premium features on a paid plan.",
        ctaLabel: target ? `Upgrade to ${target}` : "View plans & upgrade",
        url: BILLING_PAGE_URL,
      });
      return {
        shown: true,
        message:
          "An upgrade card linking to the billing page has been shown to the visitor. In your reply, briefly invite them to upgrade using the button on the card. Do not paste a separate link.",
      };
    },
  });

  return {
    search_knowledge_base,
    search_helpdesk_articles,
    get_faq,
    capture_lead,
    escalate_to_human,
    suggest_articles,
    cannot_help,
    send_upgrade_link,
  };
}
