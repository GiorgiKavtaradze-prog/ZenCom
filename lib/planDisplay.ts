import {
  PLANS,
  PLAN_SLUGS,
  type Feature,
  type PlanSlug,
  type PlanDefinition,
} from "@/convex/lib/plans";

// ─────────────────────────────────────────────────────────────────────────────
// Presentation layer over the canonical plan definitions in convex/lib/plans.ts.
//
// The Convex file owns the source-of-truth limits/features (what Convex
// enforces). This file layers DISPLAY metadata (price, tagline, human feature
// labels) on top for the marketing pricing page + the dashboard billing page.
// Prices here are display-only; Clerk Billing holds the real amounts and runs
// checkout. Keep the monthly USD figures in sync with the Clerk Dashboard plans.
// ─────────────────────────────────────────────────────────────────────────────

export const FEATURE_LABELS: Record<Feature, string> = {
  ai_messages: "AI-powered replies",
  website_crawl: "Website crawler",
  kb_documents: "Knowledge base documents",
  helpdesk: "Help center / articles",
  proactive_messages: "Proactive messages",
  remove_branding: "Remove “Powered by” branding",
};

export type PlanDisplay = {
  slug: PlanSlug;
  name: string;
  /** Monthly price in USD, display-only (Clerk Billing is the source of truth). */
  priceMonthly: number;
  tagline: string;
  highlighted?: boolean;
  def: PlanDefinition;
  /** Human-readable bullet list combining limits + features. */
  bullets: string[];
};

function limitBullets(def: PlanDefinition): string[] {
  const l = def.limits;
  const bullets = [
    `${l.aiMessagesPerMonth.toLocaleString()} AI messages / month`,
    `${l.seats} ${l.seats === 1 ? "seat" : "seats"}`,
    `${l.kbDocuments.toLocaleString()} knowledge base documents`,
  ];
  if (l.crawlPages > 0) {
    bullets.push(`Crawl up to ${l.crawlPages.toLocaleString()} pages`);
  }
  return bullets;
}

function featureBullets(def: PlanDefinition): string[] {
  return def.features.map((f) => FEATURE_LABELS[f]);
}

const META: Record<PlanSlug, { priceMonthly: number; tagline: string; highlighted?: boolean }> = {
  free_org: {
    priceMonthly: 0,
    tagline: "Everything you need to launch an AI chat widget.",
  },
  pro: {
    priceMonthly: 49,
    tagline: "For growing teams that need crawling and proactive messaging.",
    highlighted: true,
  },
  scale: {
    priceMonthly: 199,
    tagline: "High-volume support with the largest quotas.",
  },
};

export const PLAN_DISPLAY: Record<PlanSlug, PlanDisplay> = PLAN_SLUGS.reduce(
  (acc, slug) => {
    const def = PLANS[slug];
    acc[slug] = {
      slug,
      name: def.name,
      priceMonthly: META[slug].priceMonthly,
      tagline: META[slug].tagline,
      highlighted: META[slug].highlighted,
      def,
      bullets: [...limitBullets(def), ...featureBullets(def)],
    };
    return acc;
  },
  {} as Record<PlanSlug, PlanDisplay>,
);

export const PLAN_DISPLAY_LIST: PlanDisplay[] = PLAN_SLUGS.map(
  (slug) => PLAN_DISPLAY[slug],
);

export function planName(slug: string): string {
  return (PLAN_DISPLAY as Record<string, PlanDisplay | undefined>)[slug]?.name ?? "Free";
}

// Human label for the mirrored subscription status union (+ implicit "none").
export function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "past_due":
      return "Past due";
    case "canceled":
      return "Canceled";
    case "ended":
      return "Ended";
    case "incomplete":
      return "Incomplete";
    case "expired":
      return "Expired";
    case "none":
      return "Active"; // implicit Free, no paid subscription row yet
    default:
      return status;
  }
}
