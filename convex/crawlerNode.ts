"use node";

// ─────────────────────────────────────────────────────────────────────────────
// Website crawler — data plane (Node runtime). Scheduled by crawler.startCrawl,
// re-schedules itself until the frontier drains or the maxPages cap is hit, while
// staying inside Convex's 10-min action limit (we process a bounded batch per run
// and hand off via ctx.scheduler.runAfter).
//
// Per page: SSRF-re-validate (resolved IP + redirect host), robots.txt allow
// check, size-bounded fetch (~2 MB), main-content extraction via node-html-parser
// (pure-JS, bundles cleanly in Convex's Node runtime — no native deps unlike
// jsdom/cheerio), same-origin link discovery, chunk + embed, persist.
//
// node-html-parser + unpdf are declared in convex.json node.externalPackages.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parse as parseHtml } from "node-html-parser";
import { chunkText, estimateTokens } from "./chunking";
import { embedTexts } from "./embeddings";

const USER_AGENT = "IntercomMVP-KBCrawler/1.0 (+https://intercom-mvp.app/bot)";
const PAGES_PER_BATCH = 5; // bounded per run → stays under 10-min action limit
const MAX_PAGE_BYTES = 2 * 1024 * 1024; // ~2 MB cap (stays under 8-MiB payload)
const FETCH_TIMEOUT_MS = 15_000;
const MAX_TOKENS = 700;
const OVERLAP = 100;
const MAX_LINKS_PER_PAGE = 50;
const MAX_CHUNKS_PER_PAGE = 50;

// ── SSRF: resolved-IP validation (DNS-rebinding defense) ─────────────────────

function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const o = ip.split(".").map(Number);
    if (o[0] === 0 || o[0] === 127 || o[0] === 10) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true; // link-local + metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] >= 224) return true; // multicast/reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("::ffff:")) {
      return isPrivateIp(lower.slice(7)); // IPv4-mapped
    }
    return false;
  }
  return true; // unparseable → reject
}

async function hostResolvesToPublicIp(hostname: string): Promise<boolean> {
  try {
    if (isIP(hostname)) return !isPrivateIp(hostname);
    const results = await dnsLookup(hostname, { all: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateIp(r.address));
  } catch {
    return false;
  }
}

// ── fetch with size + timeout + redirect-aware SSRF re-check ──────────────────

async function safeFetch(
  url: string,
): Promise<{ html: string; finalUrl: string } | null> {
  const target = new URL(url);
  if (!(await hostResolvesToPublicIp(target.hostname))) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return null;

    // Re-validate the post-redirect host (DNS-rebinding / open-redirect SSRF).
    const finalUrl = res.url || url;
    const finalHost = new URL(finalUrl).hostname;
    if (!(await hostResolvesToPublicIp(finalHost))) return null;

    // Size-bound the body: read the stream, abort past the cap.
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      return { html: text.slice(0, MAX_PAGE_BYTES), finalUrl };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_PAGE_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { html: buf.toString("utf-8"), finalUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── robots.txt (minimal, UA-agnostic Disallow for "*") ───────────────────────

async function fetchRobots(origin: string): Promise<string[]> {
  try {
    // SSRF: validate the resolved IP before this request — it is the FIRST call
    // made to the origin (before any safeFetch), so without this the resolved-IP
    // defenses would be bypassed for robots.txt. Also refuse to follow redirects
    // to an unvalidated host (a 3xx → !res.ok → bail).
    if (!(await hostResolvesToPublicIp(new URL(origin).hostname))) return [];
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const text = (await res.text()).slice(0, 100_000);
    const disallows: string[] = [];
    let appliesToUs = false;
    for (const line of text.split("\n")) {
      const trimmed = line.split("#")[0].trim();
      if (!trimmed) continue;
      const [rawKey, ...rest] = trimmed.split(":");
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (key === "user-agent") {
        appliesToUs = value === "*" || value.toLowerCase().includes("intercom");
      } else if (key === "disallow" && appliesToUs && value) {
        disallows.push(value);
      }
    }
    return disallows;
  } catch {
    return [];
  }
}

function isAllowedByRobots(pathname: string, disallows: string[]): boolean {
  return !disallows.some((rule) => rule !== "" && pathname.startsWith(rule));
}

// ── HTML → main text + same-origin links ─────────────────────────────────────

function extractContent(
  html: string,
  pageUrl: string,
  rootOrigin: string,
): { title: string; text: string; links: string[] } {
  const root = parseHtml(html, {
    blockTextElements: { script: false, style: false, noscript: false },
  });

  // Strip non-content nodes before reading text.
  for (const sel of [
    "script",
    "style",
    "noscript",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "iframe",
    "svg",
  ]) {
    for (const node of root.querySelectorAll(sel)) node.remove();
  }

  const titleEl = root.querySelector("title");
  const h1 = root.querySelector("h1");
  const title = (titleEl?.text || h1?.text || pageUrl).trim().slice(0, 200);

  // Prefer <main>/<article>; fall back to <body>.
  const main =
    root.querySelector("main") ??
    root.querySelector("article") ??
    root.querySelector("body") ??
    root;
  const text = main.text.replace(/\s+/g, " ").trim();

  // Same-origin link discovery (absolute, deduped, fragment-stripped).
  const links = new Set<string>();
  for (const a of root.querySelectorAll("a")) {
    if (links.size >= MAX_LINKS_PER_PAGE) break;
    const href = a.getAttribute("href");
    if (!href) continue;
    try {
      const abs = new URL(href, pageUrl);
      abs.hash = "";
      if (abs.origin !== rootOrigin) continue;
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      // Skip obvious non-HTML assets.
      if (/\.(png|jpe?g|gif|webp|svg|pdf|zip|mp4|css|js|ico|woff2?)$/i.test(abs.pathname)) {
        continue;
      }
      links.add(abs.toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return { title, text, links: [...links] };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── the self-rescheduling batch action ───────────────────────────────────────

export const processCrawlBatch = internalAction({
  args: { crawlJobId: v.id("crawlJobs") },
  returns: v.null(),
  handler: async (ctx, { crawlJobId }) => {
    const job = await ctx.runQuery(internal.crawler.getJob, { crawlJobId });
    if (!job || job.status !== "running") return null;

    // Stop if we've crawled enough.
    if (job.pagesCrawled >= job.maxPages) {
      await ctx.runMutation(internal.crawler.finishJob, {
        crawlJobId,
        status: "completed",
      });
      return null;
    }

    const rootOrigin = new URL(job.rootUrl).origin;
    const disallows = await fetchRobots(rootOrigin);

    const batch = await ctx.runQuery(internal.crawler.claimBatch, {
      crawlJobId,
      limit: PAGES_PER_BATCH,
    });

    // Frontier drained → done.
    if (batch.length === 0) {
      await ctx.runMutation(internal.crawler.finishJob, {
        crawlJobId,
        status: "completed",
      });
      return null;
    }

    for (const page of batch) {
      try {
        const pathname = new URL(page.url).pathname;
        if (!isAllowedByRobots(pathname, disallows)) {
          await ctx.runMutation(internal.crawler.markPageError, {
            queueId: page._id,
          });
          continue;
        }

        const fetched = await safeFetch(page.url);
        if (!fetched) {
          await ctx.runMutation(internal.crawler.markPageError, {
            queueId: page._id,
          });
          continue;
        }

        const { title, text, links } = extractContent(
          fetched.html,
          fetched.finalUrl,
          rootOrigin,
        );

        // Enqueue newly-discovered same-origin links at depth+1.
        if (page.depth < job.maxDepth && links.length > 0) {
          await ctx.runMutation(internal.crawler.enqueueUrls, {
            crawlJobId,
            urls: links.map((url) => ({ url, depth: page.depth + 1 })),
          });
        }

        let chunksAdded = 0;
        if (text.length > 50) {
          const pieces = chunkText(`${title}\n\n${text}`, {
            maxTokens: MAX_TOKENS,
            overlap: OVERLAP,
          }).slice(0, MAX_CHUNKS_PER_PAGE);

          if (pieces.length > 0) {
            const embeddings = await embedTexts(pieces);
            const chunks = pieces.map((t, i) => ({
              text: t,
              embedding: embeddings[i],
              tokenCount: estimateTokens(t),
              contentHash: sha256(t),
            }));
            const result = await ctx.runMutation(internal.kb.insertChunks, {
              workspaceId: job.workspaceId,
              source: "crawl",
              title,
              sourceUrl: page.url,
              crawlJobId,
              chunks,
            });
            chunksAdded = result.inserted;
          }
        }

        await ctx.runMutation(internal.crawler.markPageDone, {
          queueId: page._id,
          crawlJobId,
          chunksAdded,
        });
      } catch {
        await ctx.runMutation(internal.crawler.markPageError, {
          queueId: page._id,
        });
      }
    }

    // Re-schedule the next batch (frontier may still have pending URLs). A small
    // delay throttles fetch rate + spaces out embedding spend.
    await ctx.scheduler.runAfter(
      1000,
      internal.crawlerNode.processCrawlBatch,
      { crawlJobId },
    );
    return null;
  },
});
