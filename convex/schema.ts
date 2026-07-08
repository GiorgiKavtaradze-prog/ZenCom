import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Reconciled application schema. All NEW tenant/AI/status fields are added as
// `v.optional(...)` and STAY optional permanently — presence is enforced in
// code (e.g. `requireOrgMember` throws if claims/org are absent), never by a
// schema-tightening re-push that would race live widget writes.
//
// NOTE: `@convex-dev/agent` owns its own threads/messages/streamDeltas tables
// internally (registered in convex.config.ts). We do NOT redefine them here.
// Our `conversations` row bridges to an agent thread via the optional
// `threadId` field (wired up in Phase 4). Our `messages` table remains the
// tenant-facing transcript the live widget already subscribes to.
//
// `@convex-dev/rate-limiter` also owns its own tables, so there is no custom
// rate-limit table in this schema.
export default defineSchema({
  // ── TENANT ────────────────────────────────────────────────────────────────
  workspaces: defineTable({
    name: v.string(),
    ownerClerkUserId: v.string(), // kept: creator convenience, NOT the auth boundary
    clerkOrgId: v.optional(v.string()), // Clerk Organization id — REAL tenant key (enforced in code)
    slug: v.optional(v.string()),
  })
    .index("by_owner", ["ownerClerkUserId"])
    .index("by_org", ["clerkOrgId"]),

  // Mirror of Clerk org memberships (webhook-synced, idempotent upserts).
  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    clerkOrgId: v.string(),
    clerkUserId: v.string(),
    role: v.union(v.literal("admin"), v.literal("support")),
    name: v.string(),
    email: v.optional(v.string()),
    imageUrl: v.optional(v.string()), // Clerk CDN URL (string, NOT _storage)
    // Admin-set widget avatar (Convex _storage). When present it overrides the
    // Clerk `imageUrl` everywhere the member's avatar is shown (widget header,
    // inbox, team roster). Cleared by setting back to undefined.
    customAvatarStorageId: v.optional(v.id("_storage")),
    status: v.union(v.literal("active"), v.literal("removed")),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_org_user", ["clerkOrgId", "clerkUserId"]) // webhook upsert key
    .index("by_workspace_role", ["workspaceId", "role"]),

  // ── CONVERSATIONS / MESSAGES ───────────────────────────────────────────────
  conversations: defineTable({
    workspaceId: v.id("workspaces"),
    visitorId: v.string(), // anonymous id minted client-side, stored in localStorage
    visitorName: v.string(),
    lastMessageAt: v.number(),
    mode: v.optional(v.union(v.literal("ai"), v.literal("human"))), // default "ai" (set in code on create)
    status: v.optional(v.union(v.literal("open"), v.literal("closed"))), // ("snoozed" deferred)
    assignedClerkUserId: v.optional(v.string()), // undefined = unassigned queue
    assignedAt: v.optional(v.number()),
    lastVisitorMessageAt: v.optional(v.number()),
    lastReadByAgentAt: v.optional(v.number()),
    pendingAgentJobId: v.optional(v.id("_scheduled_functions")), // debounce/idempotency lock (opportunistic cancel only)
    agentRunEpoch: v.optional(v.number()), // bumped on takeover/new-msg to abort in-flight runs
    threadId: v.optional(v.string()), // bridge to @convex-dev/agent thread (set in Phase 4)
  })
    .index("by_workspace", ["workspaceId", "lastMessageAt"])
    .index("by_workspace_visitor", ["workspaceId", "visitorId"])
    .index("by_workspace_status", ["workspaceId", "status", "lastMessageAt"])
    .index("by_workspace_assignee", [
      "workspaceId",
      "assignedClerkUserId",
      "lastMessageAt",
    ])
    .index("by_workspace_mode", ["workspaceId", "mode", "lastMessageAt"]),

  // Tenant-facing transcript. The live widget reads this via `messages.list` —
  // KEEP intact. New fields are additive + optional.
  messages: defineTable({
    conversationId: v.id("conversations"),
    author: v.union(
      v.literal("visitor"),
      v.literal("agent"), // human OR AI text — disambiguate with isAi
      v.literal("system"), // "Sonny joined", "Returned to AI", assignment notices
    ),
    body: v.string(),
    isAi: v.optional(v.boolean()), // true ⇒ AI-authored agent message
    authorClerkUserId: v.optional(v.string()),
    pending: v.optional(v.boolean()), // streaming placeholder (token-batched updates)
    citations: v.optional(
      v.array(
        v.object({
          chunkId: v.optional(v.id("knowledgeChunks")), // best-effort: chunks re-minted on re-embed
          title: v.optional(v.string()), // resolved + authoritative (survives chunk deletion)
          url: v.optional(v.string()),
        }),
      ),
    ),
    // Rich action "widget" attached to an AI message — e.g. an upgrade card that
    // links to the billing page. Produced by the `send_upgrade_link` agent tool
    // and rendered as an interactive card in the widget transcript.
    upgradeCard: v.optional(
      v.object({
        title: v.string(),
        description: v.string(),
        ctaLabel: v.string(),
        url: v.string(),
      }),
    ),
  }).index("by_conversation", ["conversationId"]),

  // ── LEADS ──────────────────────────────────────────────────────────────────
  leads: defineTable({
    workspaceId: v.id("workspaces"),
    conversationId: v.optional(v.id("conversations")),
    visitorId: v.optional(v.string()), // dedupe a visitor's lead
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.string(), // required; server-validated + length-capped
    phone: v.optional(v.string()),
    source: v.string(), // "widget" | "proactive"
    status: v.union(
      v.literal("new"),
      v.literal("contacted"),
      v.literal("closed"),
    ),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId", "createdAt"])
    .index("by_workspace_email", ["workspaceId", "email"])
    .index("by_workspace_status", ["workspaceId", "status", "createdAt"])
    .index("by_workspace_visitor", ["workspaceId", "visitorId"])
    .index("by_conversation", ["conversationId"]),

  // ── KNOWLEDGE BASE ─────────────────────────────────────────────────────────
  helpdeskArticles: defineTable({
    workspaceId: v.id("workspaces"),
    title: v.string(),
    slug: v.string(),
    category: v.string(),
    bodyMarkdown: v.string(), // rich content as markdown (<1 MiB)
    excerpt: v.optional(v.string()),
    searchableText: v.string(), // title + excerpt + stripped body — single searchField
    coverImageStorageId: v.optional(v.id("_storage")),
    status: v.union(v.literal("draft"), v.literal("published")),
    isPopular: v.boolean(),
    order: v.number(),
    authorClerkUserId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId", "order"])
    .index("by_workspace_slug", ["workspaceId", "slug"])
    .index("by_workspace_category", ["workspaceId", "category", "order"])
    .index("by_workspace_status", ["workspaceId", "status", "order"])
    .index("by_workspace_popular", ["workspaceId", "isPopular", "order"])
    .searchIndex("search_articles", {
      searchField: "searchableText",
      filterFields: ["workspaceId", "status", "category"],
    }),

  knowledgeChunks: defineTable({
    workspaceId: v.id("workspaces"),
    source: v.union(
      v.literal("crawl"),
      v.literal("article"),
      v.literal("file"),
    ),
    articleId: v.optional(v.id("helpdeskArticles")),
    crawlJobId: v.optional(v.id("crawlJobs")),
    sourceUrl: v.optional(v.string()),
    title: v.string(),
    text: v.string(), // ~500–1500 tokens
    chunkIndex: v.number(),
    tokenCount: v.number(),
    contentHash: v.string(), // sha256(text) — dedupe/idempotency
    embedding: v.array(v.float64()), // length MUST equal 1536
  })
    .index("by_workspace_source", ["workspaceId", "source"]) // post-hydration source narrowing
    .index("by_article", ["articleId"])
    .index("by_crawlJob", ["crawlJobId"])
    .index("by_workspace_hash", ["workspaceId", "contentHash"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536, // text-embedding-3-small native — LOCKED
      filterFields: ["workspaceId"], // ONLY workspaceId — vector filter cannot AND two fields
    }),

  crawlJobs: defineTable({
    workspaceId: v.id("workspaces"),
    rootUrl: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    maxPages: v.number(),
    maxDepth: v.number(),
    pagesDiscovered: v.number(),
    pagesCrawled: v.number(),
    chunksCreated: v.number(),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_status", ["workspaceId", "status"]),

  crawlQueue: defineTable({
    // per-job frontier (one row/URL; avoids 1-MiB doc)
    crawlJobId: v.id("crawlJobs"),
    workspaceId: v.id("workspaces"),
    url: v.string(),
    depth: v.number(),
    state: v.union(v.literal("pending"), v.literal("done"), v.literal("error")),
  })
    .index("by_job_state", ["crawlJobId", "state"])
    .index("by_job_url", ["crawlJobId", "url"]),

  // ── WIDGET CONFIG ──────────────────────────────────────────────────────────
  widgetAppearance: defineTable({
    workspaceId: v.id("workspaces"),
    themeColor: v.string(),
    buttonColor: v.string(),
    cornerRadius: v.number(),
    title: v.string(),
    titleColor: v.string(),
    logoStorageId: v.optional(v.id("_storage")), // validated MIME+size on finalize; SVG rejected
    position: v.union(v.literal("bottom-right"), v.literal("bottom-left")),
    bottomMargin: v.number(),
    sideMargin: v.number(),
    notificationSound: v.boolean(),
  }).index("by_workspace", ["workspaceId"]),

  widgetSettings: defineTable({
    workspaceId: v.id("workspaces"),
    proactiveMessage: v.object({
      enabled: v.boolean(),
      delaySeconds: v.number(),
      text: v.string(),
    }),
    leadCapture: v.object({
      enabled: v.boolean(),
      requiredFields: v.array(
        v.union(
          v.literal("firstName"),
          v.literal("lastName"),
          v.literal("email"),
          v.literal("phone"),
        ),
      ),
    }),
    faqEnabled: v.boolean(),
  }).index("by_workspace", ["workspaceId"]),

  // ── BILLING MIRROR (webhook-written; read-only cache for Convex gating) ─────
  subscriptions: defineTable({
    workspaceId: v.id("workspaces"),
    clerkOrgId: v.string(),
    subscriptionId: v.string(),
    subscriptionItemId: v.optional(v.string()), // plan+status live here (subscriptionItem.* is primary signal)
    planSlug: v.string(), // "free_org" | "pro" | "scale"
    status: v.union(
      // normalized from Clerk camelCase events
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
      v.literal("ended"),
      v.literal("incomplete"),
      v.literal("expired"),
    ),
    seats: v.number(),
    features: v.array(v.string()),
    limits: v.object({
      aiMessagesPerMonth: v.number(),
      kbDocuments: v.number(),
      crawlPages: v.number(),
      seats: v.number(),
    }),
    currentPeriodStart: v.optional(v.number()), // drives usage bucket window
    currentPeriodEnd: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_org", ["clerkOrgId"])
    .index("by_subscription", ["subscriptionId"])
    .index("by_subscription_item", ["subscriptionItemId"]),

  usage: defineTable({
    // quota counters keyed to billing period, not calendar month
    workspaceId: v.id("workspaces"),
    clerkOrgId: v.string(),
    periodStart: v.number(), // = subscription currentPeriodStart (aligns quota to billing cycle)
    aiMessages: v.number(),
    kbDocuments: v.number(),
  }).index("by_workspace_period", ["workspaceId", "periodStart"]),
});
