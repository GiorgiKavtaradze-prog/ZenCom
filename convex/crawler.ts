import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireAdmin, requireOrgMember } from "./lib/auth";
import { getEntitlement, hasFeature } from "./lib/entitlements";
import { internal } from "./_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// Website crawler — control plane (default runtime). The actual fetching/parsing
// runs in crawlerNode.processCrawlBatch ("use node"); this file owns:
//   - startCrawl: admin-gated, SSRF-validated, feature/limit-gated job creation +
//     frontier seeding (sitemap discovery happens in the Node batch).
//   - frontier mutations the Node action calls: claim a batch, mark done/error,
//     enqueue newly-discovered same-origin URLs, bump progress, finish the job.
//
// Crawl is scoped to the org's OWN site by design (documented trust boundary):
// injection-laden third-party content can only poison that tenant's KB.
// ─────────────────────────────────────────────────────────────────────────────

const HARD_MAX_PAGES = 500; // absolute ceiling regardless of plan
const DEFAULT_MAX_PAGES = 200; // fallback when the caller omits a plan-derived cap
const DEFAULT_MAX_DEPTH = 3;
const HARD_MAX_DEPTH = 5;

// ── SSRF validation (host/IP allow-listing) ──────────────────────────────────
//
// Reject anything that could reach internal infrastructure. We validate the
// HOSTNAME here (synchronous, no DNS in a mutation); the Node action re-validates
// the RESOLVED IP and re-checks on every redirect (DNS-rebinding defense).

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^0\.0\.0\.0$/,
  /^127\./, // loopback
  /^10\./, // private A
  /^192\.168\./, // private C
  /^169\.254\./, // link-local (incl. cloud metadata 169.254.169.254)
  /^172\.(1[6-9]|2\d|3[01])\./, // private B (172.16–172.31)
  /^::1$/, // IPv6 loopback
  /^fc[0-9a-f]{2}:/i, // IPv6 unique-local
  /^fe80:/i, // IPv6 link-local
];

export type SsrfCheck =
  | { ok: true; normalized: string; origin: string; hostname: string }
  | { ok: false; reason: string };

export function validateCrawlUrl(input: string): SsrfCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "Invalid URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only http(s) URLs are allowed." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Credentials in URL are not allowed." };
  }
  const host = url.hostname.toLowerCase();
  if (!host || (!host.includes(".") && host !== "localhost")) {
    return { ok: false, reason: "Hostname must be fully qualified." };
  }
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(host)) {
      return {
        ok: false,
        reason: "Private/loopback/link-local hosts are blocked.",
      };
    }
  }
  // Strip fragments; keep query (some sitemaps are query-driven). Normalize.
  url.hash = "";
  return {
    ok: true,
    normalized: url.toString(),
    origin: url.origin,
    hostname: host,
  };
}

// ── startCrawl (admin) ────────────────────────────────────────────────────────

export const startCrawl = mutation({
  args: {
    url: v.string(),
    maxPages: v.optional(v.number()),
    maxDepth: v.optional(v.number()),
  },
  returns: v.object({ crawlJobId: v.id("crawlJobs") }),
  handler: async (ctx, args) => {
    const { workspace } = await requireAdmin(ctx);

    // Entitlement is enforced HERE — the real trust boundary — not only in the
    // Next.js `startCrawlAction`. A client calling this mutation directly must not
    // be able to bypass the paywall. The subscriptions mirror fails safe to Free
    // (no `website_crawl`, crawlPages 0) when missing or webhook-lagged.
    const ent = await getEntitlement(ctx, workspace);
    if (!hasFeature(ent, "website_crawl")) {
      throw new ConvexError({
        code: "FEATURE_UNAVAILABLE",
        message: "Website crawling is not included in your plan.",
      });
    }

    const check = validateCrawlUrl(args.url);
    if (!check.ok) {
      throw new ConvexError({ code: "INVALID_URL", message: check.reason });
    }

    // Only one running crawl per workspace at a time (avoids frontier interleave
    // + runaway concurrent embedding spend).
    const running = await ctx.db
      .query("crawlJobs")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", workspace._id).eq("status", "running"),
      )
      .first();
    if (running) {
      throw new ConvexError({
        code: "CRAWL_IN_PROGRESS",
        message: "A crawl is already running for this workspace.",
      });
    }

    // Clamp to the plan cap so a client-supplied maxPages can never widen the
    // crawl beyond the plan's allowance (defense in depth alongside the gate).
    const planCap = ent.limits.crawlPages;
    const maxPages = Math.max(
      1,
      Math.min(
        args.maxPages ?? Math.min(planCap, DEFAULT_MAX_PAGES),
        planCap,
        HARD_MAX_PAGES,
      ),
    );
    const maxDepth = Math.max(
      0,
      Math.min(args.maxDepth ?? DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH),
    );

    const crawlJobId = await ctx.db.insert("crawlJobs", {
      workspaceId: workspace._id,
      rootUrl: check.normalized,
      status: "running",
      maxPages,
      maxDepth,
      pagesDiscovered: 1,
      pagesCrawled: 0,
      chunksCreated: 0,
      startedAt: Date.now(),
    });

    // Seed the frontier with the root; the Node batch expands via sitemap + links.
    await ctx.db.insert("crawlQueue", {
      crawlJobId,
      workspaceId: workspace._id,
      url: check.normalized,
      depth: 0,
      state: "pending",
    });

    await ctx.scheduler.runAfter(0, internal.crawlerNode.processCrawlBatch, {
      crawlJobId,
    });
    return { crawlJobId };
  },
});

// ── frontier mutations (called by the Node action) ────────────────────────────

// Snapshot the job + its progress so the Node action can decide whether to stop.
export const getJob = internalQuery({
  args: { crawlJobId: v.id("crawlJobs") },
  returns: v.union(
    v.object({
      _id: v.id("crawlJobs"),
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
      pagesCrawled: v.number(),
      pagesDiscovered: v.number(),
      chunksCreated: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { crawlJobId }) => {
    const job = await ctx.db.get(crawlJobId);
    if (!job) return null;
    return {
      _id: job._id,
      workspaceId: job.workspaceId,
      rootUrl: job.rootUrl,
      status: job.status,
      maxPages: job.maxPages,
      maxDepth: job.maxDepth,
      pagesCrawled: job.pagesCrawled,
      pagesDiscovered: job.pagesDiscovered,
      chunksCreated: job.chunksCreated,
    };
  },
});

// Claim up to `limit` pending URLs and mark them in-flight (state stays "pending"
// until the action reports done/error — we just read them; idempotency is via the
// per-URL state transition in markPageDone/markPageError).
export const claimBatch = internalQuery({
  args: { crawlJobId: v.id("crawlJobs"), limit: v.number() },
  returns: v.array(
    v.object({
      _id: v.id("crawlQueue"),
      url: v.string(),
      depth: v.number(),
    }),
  ),
  handler: async (ctx, { crawlJobId, limit }) => {
    const pending = await ctx.db
      .query("crawlQueue")
      .withIndex("by_job_state", (q) =>
        q.eq("crawlJobId", crawlJobId).eq("state", "pending"),
      )
      .take(Math.min(limit, 25));
    return pending.map((p) => ({ _id: p._id, url: p.url, depth: p.depth }));
  },
});

// Enqueue newly-discovered same-origin URLs (dedup on (job,url) via by_job_url).
// Bounded by the job's maxPages (pagesDiscovered ceiling).
export const enqueueUrls = internalMutation({
  args: {
    crawlJobId: v.id("crawlJobs"),
    urls: v.array(v.object({ url: v.string(), depth: v.number() })),
  },
  returns: v.object({ added: v.number() }),
  handler: async (ctx, { crawlJobId, urls }) => {
    const job = await ctx.db.get(crawlJobId);
    if (!job || job.status !== "running") return { added: 0 };

    let added = 0;
    let discovered = job.pagesDiscovered;
    for (const { url, depth } of urls) {
      if (discovered >= job.maxPages) break;
      if (depth > job.maxDepth) continue;
      const existing = await ctx.db
        .query("crawlQueue")
        .withIndex("by_job_url", (q) =>
          q.eq("crawlJobId", crawlJobId).eq("url", url),
        )
        .unique();
      if (existing) continue;
      await ctx.db.insert("crawlQueue", {
        crawlJobId,
        workspaceId: job.workspaceId,
        url,
        depth,
        state: "pending",
      });
      discovered += 1;
      added += 1;
    }
    if (added > 0) {
      await ctx.db.patch(crawlJobId, { pagesDiscovered: discovered });
    }
    return { added };
  },
});

// Mark a queued URL crawled + bump job progress (pagesCrawled, chunksCreated).
export const markPageDone = internalMutation({
  args: {
    queueId: v.id("crawlQueue"),
    crawlJobId: v.id("crawlJobs"),
    chunksAdded: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { queueId, crawlJobId, chunksAdded }) => {
    const entry = await ctx.db.get(queueId);
    if (entry && entry.state === "pending") {
      await ctx.db.patch(queueId, { state: "done" });
    }
    const job = await ctx.db.get(crawlJobId);
    if (job) {
      await ctx.db.patch(crawlJobId, {
        pagesCrawled: job.pagesCrawled + 1,
        chunksCreated: job.chunksCreated + chunksAdded,
      });
    }
    return null;
  },
});

export const markPageError = internalMutation({
  args: { queueId: v.id("crawlQueue") },
  returns: v.null(),
  handler: async (ctx, { queueId }) => {
    const entry = await ctx.db.get(queueId);
    if (entry && entry.state === "pending") {
      await ctx.db.patch(queueId, { state: "error" });
    }
    return null;
  },
});

export const finishJob = internalMutation({
  args: {
    crawlJobId: v.id("crawlJobs"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { crawlJobId, status, error }) => {
    const job = await ctx.db.get(crawlJobId);
    if (!job) return null;
    await ctx.db.patch(crawlJobId, {
      status,
      error: error?.slice(0, 1000),
      finishedAt: Date.now(),
    });
    return null;
  },
});

// ── dashboard read (authed) ───────────────────────────────────────────────────

export const listJobs = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("crawlJobs"),
      _creationTime: v.number(),
      rootUrl: v.string(),
      status: v.union(
        v.literal("queued"),
        v.literal("running"),
        v.literal("completed"),
        v.literal("failed"),
      ),
      maxPages: v.number(),
      pagesDiscovered: v.number(),
      pagesCrawled: v.number(),
      chunksCreated: v.number(),
      error: v.optional(v.string()),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const { workspace } = await requireOrgMember(ctx);
    const jobs = await ctx.db
      .query("crawlJobs")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .order("desc")
      .take(Math.min(limit ?? 20, 50));
    return jobs.map((j) => ({
      _id: j._id,
      _creationTime: j._creationTime,
      rootUrl: j.rootUrl,
      status: j.status,
      maxPages: j.maxPages,
      pagesDiscovered: j.pagesDiscovered,
      pagesCrawled: j.pagesCrawled,
      chunksCreated: j.chunksCreated,
      error: j.error,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
    }));
  },
});

// ── delete a crawl source (admin) ─────────────────────────────────────────────
//
// Removes a crawl job, its frontier rows, AND every knowledgeChunk it ingested
// (so deleting a source actually pulls it out of the AI knowledge base). Chunk +
// queue deletion is done as a scheduled, batched sweep so a large crawl never
// blows the per-mutation write budget. The job row itself is deleted last (after
// the sweep finishes) so the dashboard keeps showing it — greyed/"removing" — if
// you want, but here we delete the job immediately and sweep its children async;
// orphan chunks/queue rows are keyed by crawlJobId and removed by the sweep.
export const deleteJob = mutation({
  args: { crawlJobId: v.id("crawlJobs") },
  returns: v.null(),
  handler: async (ctx, { crawlJobId }) => {
    const { workspace } = await requireAdmin(ctx);
    const job = await ctx.db.get(crawlJobId);
    if (!job || job.workspaceId !== workspace._id) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Crawl not found." });
    }
    if (job.status === "running") {
      throw new ConvexError({
        code: "CRAWL_RUNNING",
        message: "Stop or wait for the crawl to finish before deleting it.",
      });
    }
    await ctx.db.delete(crawlJobId);
    // Cascade-delete chunks + frontier rows in bounded batches.
    await ctx.scheduler.runAfter(0, internal.crawler.sweepJobChildren, {
      crawlJobId,
    });
    return null;
  },
});

// Batched cascade delete of a (now-removed) job's knowledgeChunks + crawlQueue
// rows. Re-schedules itself until both are drained. Idempotent.
const SWEEP_BATCH = 100;
export const sweepJobChildren = internalMutation({
  args: { crawlJobId: v.id("crawlJobs") },
  returns: v.null(),
  handler: async (ctx, { crawlJobId }) => {
    const chunks = await ctx.db
      .query("knowledgeChunks")
      .withIndex("by_crawlJob", (q) => q.eq("crawlJobId", crawlJobId))
      .take(SWEEP_BATCH);
    for (const c of chunks) await ctx.db.delete(c._id);

    let queueDeleted = 0;
    if (chunks.length < SWEEP_BATCH) {
      const queued = await ctx.db
        .query("crawlQueue")
        .withIndex("by_job_url", (q) => q.eq("crawlJobId", crawlJobId))
        .take(SWEEP_BATCH);
      for (const row of queued) await ctx.db.delete(row._id);
      queueDeleted = queued.length;
    }

    // More to do? Re-schedule. (We keep going while either set still has rows.)
    if (chunks.length === SWEEP_BATCH || queueDeleted === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.crawler.sweepJobChildren, {
        crawlJobId,
      });
    }
    return null;
  },
});
