"use server";

import { auth } from "@clerk/nextjs/server";
import { fetchMutation } from "convex/nextjs";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { PLANS, type PlanSlug } from "@/convex/lib/plans";

// ─────────────────────────────────────────────────────────────────────────────
// Crawl entitlement is enforced HERE, server-side, via Clerk's `has()`.
//
// `auth().has({ feature })` reads the live session claims, so it reflects an
// upgrade the instant Clerk's token refreshes — no dependency on the Convex
// `subscriptions` webhook mirror (which can lag or, in dev, never be wired).
// This is the source of truth for the website-crawl paywall + page cap; the
// Convex `startCrawl` mutation only keeps the admin + SSRF + single-run gates.
// ─────────────────────────────────────────────────────────────────────────────

export type CrawlActionResult = { ok: true } | { ok: false; error: string };

// Resolve the caller's live plan (highest tier wins) to derive the page cap.
function resolvePlanSlug(has: (params: { plan: string }) => boolean): PlanSlug {
  if (has({ plan: "scale" })) return "scale";
  if (has({ plan: "pro" })) return "pro";
  return "free_org";
}

export async function startCrawlAction(
  url: string,
): Promise<CrawlActionResult> {
  const { orgId, has, getToken } = await auth();

  if (!orgId) {
    return { ok: false, error: "Select or create an organization first." };
  }

  // Authoritative, live entitlement check.
  if (!has({ feature: "website_crawl" })) {
    return {
      ok: false,
      error: "Website crawling is not included in your plan.",
    };
  }

  const maxPages = PLANS[resolvePlanSlug(has)].limits.crawlPages;

  // Pass the Clerk-issued Convex JWT so the mutation runs as this admin.
  const token = await getToken({ template: "convex" });
  if (!token) {
    return { ok: false, error: "Not authenticated." };
  }

  try {
    await fetchMutation(api.crawler.startCrawl, { url, maxPages }, { token });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: convexErrorMessage(err) };
  }
}

function convexErrorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
  }
  return "Could not start the crawl.";
}
