"use node";

// ─────────────────────────────────────────────────────────────────────────────
// DEMO DATA SEED (dev only).
//
// Populates a realistic demo dataset for a single org/user so the dashboard,
// inbox, KB, leads, billing meter, and AI RAG all have believable content.
//
// Runnable directly:
//   npx convex run seed:run '{"clerkOrgId":"org_...","clerkUserId":"user_..."}'
//
// This is a Node action (needs node:crypto for sha256 + the OpenAI embedding
// path). All DB writes go through default-runtime internal mutations declared in
// seedMutations.ts (a Node action cannot touch ctx.db directly). Article bodies
// are chunked + embedded exactly like the real article re-index path
// (articlesNode.reindex) so the seeded chunks are genuine RAG-retrievable rows.
//
// Idempotent: if the workspace already has seeded conversations and `reset` is
// not true, it returns early. With `reset: true` it wipes prior seeded
// conversations / messages / leads / articles / chunks / crawl jobs first.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { createHash } from "node:crypto";
import { chunkText, estimateTokens } from "./chunking";
import { embedTexts } from "./embeddings";
import { PLANS } from "./lib/plans";

const MAX_TOKENS = 700;
const OVERLAP = 100;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Mirror of articlesNode.ts stripMarkdown — keep the embedded text identical to
// what the real re-index path would produce.
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>#~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── Article source content ───────────────────────────────────────────────────

type SeedArticle = {
  title: string;
  category: string;
  excerpt: string;
  isPopular: boolean;
  bodyMarkdown: string;
};

const ARTICLES: SeedArticle[] = [
  {
    title: "How do I install the chat widget?",
    category: "Getting Started",
    excerpt: "Add the chat widget to any website with a single script tag.",
    isPopular: true,
    bodyMarkdown: `# Installing the chat widget

Adding live chat and AI support to your site takes about two minutes.

## 1. Copy your embed snippet

From your dashboard, open **Settings → Install**. You'll see a short snippet that looks like this:

\`\`\`html
<script
  src="https://cdn.example.com/loader.js"
  data-app-id="YOUR_APP_ID"
  async
></script>
\`\`\`

The \`data-app-id\` is unique to your workspace — it tells the widget which knowledge base and team to connect to.

## 2. Paste it before the closing body tag

Drop the snippet just before the closing \`</body>\` tag on every page where you want the launcher to appear. If you use a site builder (Webflow, Framer, Shopify, WordPress), paste it into the **custom code / footer** section so it loads site-wide.

## 3. Refresh and look bottom-right

Reload your site. A chat bubble appears in the corner. Click it to start a conversation — the AI assistant answers instantly from your knowledge base, and any question it can't handle is routed to your team.

## Troubleshooting

- **No bubble showing?** Make sure the snippet is on the page and that no content blocker is stripping third-party scripts.
- **Wrong colors or position?** Those come from your widget appearance settings, not the snippet — update them in the customizer.
`,
  },
  {
    title: "What plans do you offer?",
    category: "Billing",
    excerpt: "Compare the Free, Pro, and Scale plans and their limits.",
    isPopular: true,
    bodyMarkdown: `# Plans and pricing

We offer three plans so you only pay for what you need.

## Free

Great for getting started and small sites.

- **100 AI messages / month**
- Up to **10 knowledge base documents**
- Helpdesk articles
- 2 team seats

## Pro

For growing teams that need automation and crawling.

- **2,000 AI messages / month**
- Up to **200 knowledge base documents**
- **Automatic website crawling** (up to 200 pages)
- Proactive messages
- Remove "Powered by" branding
- 10 team seats

## Scale

For high-volume support operations.

- **20,000 AI messages / month**
- Up to **2,000 knowledge base documents**
- Crawl up to **2,000 pages**
- Everything in Pro
- 20 team seats

You can upgrade or downgrade at any time from **Settings → Billing**. Changes take effect immediately and your usage meter resets at the start of each billing period.
`,
  },
  {
    title: "How do I reset my password?",
    category: "Account",
    excerpt: "Reset your password from the sign-in screen in under a minute.",
    isPopular: false,
    bodyMarkdown: `# Resetting your password

If you can't sign in, you can reset your password yourself.

## Steps

1. Go to the **sign-in page** and click **Forgot password?**
2. Enter the email address on your account.
3. Check your inbox for a password-reset email (it usually arrives within a minute — check spam if you don't see it).
4. Click the link in the email and choose a new password.
5. Sign in with your new password.

## Tips

- Reset links expire after a short window for security. If yours expired, just request a new one.
- We recommend a password manager so you never have to remember it again.
- If you signed up with **Google** or another social login, you don't have a password — use that provider's button to sign in instead.

Still locked out? Reach out to support and we'll verify your identity and help you back in.
`,
  },
  {
    title: "Can I crawl my website automatically?",
    category: "Getting Started",
    excerpt: "Point the crawler at your site and we build your AI knowledge base for you.",
    isPopular: true,
    bodyMarkdown: `# Automatic website crawling

Instead of writing every help article by hand, you can point our crawler at your existing website and we'll turn it into AI-ready knowledge automatically.

## How it works

1. Go to **Knowledge → Crawl a website**.
2. Enter your root URL, e.g. \`https://yourcompany.com\`.
3. Choose how many pages to crawl and how deep to follow links.
4. Start the crawl. We fetch each page, strip the navigation and boilerplate, split the content into passages, and embed them into your knowledge base.

## What gets indexed

We index readable page content — docs, FAQs, product pages, blog posts. We skip images, scripts, and obvious navigation chrome so the AI answers from real content, not menus.

## Keeping it fresh

Re-run a crawl any time your site changes. We dedupe content we've already indexed, so re-crawling is fast and won't create duplicates.

> **Note:** Automatic crawling is available on the **Pro** and **Scale** plans. On Free, you can still add knowledge base documents and helpdesk articles manually.
`,
  },
  {
    title: "How does the AI know what to answer?",
    category: "Getting Started",
    excerpt: "The assistant answers only from your knowledge base, with citations.",
    isPopular: false,
    bodyMarkdown: `# How the AI assistant works

Our assistant is **grounded** — it answers from *your* content, not from the open internet.

## Retrieval-augmented answers

When a visitor asks a question, we:

1. Turn the question into a vector embedding.
2. Search your knowledge base (articles, crawled pages, uploaded files) for the most relevant passages.
3. Hand those passages to the model as reference material.
4. Generate an answer **grounded in that material**, with citations back to the source articles.

## Why this matters

- **Accurate:** the AI quotes your real docs instead of guessing.
- **On-brand:** answers reflect your product, your policies, your tone.
- **Safe:** if nothing relevant is found, the assistant declines or hands off to a human instead of making something up.

## Improving answers

The best way to improve the AI is to improve your knowledge base. Add a clear article for any question it gets wrong, and the next time someone asks, it'll have the right source to cite.
`,
  },
  {
    title: "Do you offer refunds?",
    category: "Billing",
    excerpt: "Our refund policy and how to request one.",
    isPopular: false,
    bodyMarkdown: `# Refund policy

We want you to be happy with your subscription.

## 14-day money-back guarantee

If you upgrade to a paid plan and decide it's not for you, contact us within **14 days** of your first payment and we'll issue a full refund — no questions asked.

## How to request a refund

1. Open **Settings → Billing**.
2. Click **Contact support** or email our billing team.
3. Tell us the workspace and the charge you'd like refunded.

We process refunds within a few business days back to your original payment method.

## After 14 days

Beyond the 14-day window we don't offer prorated refunds for the current period, but you can **cancel at any time** to stop future charges. Your plan stays active until the end of the period you've already paid for, then drops to Free.

## Annual plans

Annual subscriptions follow the same 14-day guarantee from the date of purchase. After that, you keep access for the remainder of the year.
`,
  },
];

// ── Conversation scripts ─────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIN = 60 * 1000;

type SeedMessage = {
  author: "visitor" | "agent" | "system";
  body: string;
  isAi?: boolean;
  // offset in ms applied AFTER the conversation's base time
  deltaMs: number;
  // index into ARTICLES for an AI citation (article chunk citation), if any
  citeArticleIndex?: number;
};

type SeedConversation = {
  visitorName: string;
  mode: "ai" | "human";
  status: "open" | "closed";
  // days ago the conversation started
  daysAgo: number;
  assignToSonny: boolean;
  // attach a lead to this conversation (index into LEADS), if any
  messages: SeedMessage[];
};

const CONVERSATIONS: SeedConversation[] = [
  // 1. AI handled, grounded answer with citation, closed.
  {
    visitorName: "Emma Thompson",
    mode: "ai",
    status: "closed",
    daysAgo: 9,
    assignToSonny: false,
    messages: [
      { author: "visitor", body: "Hi! How do I add the chat widget to my Webflow site?", deltaMs: 0 },
      {
        author: "agent",
        isAi: true,
        citeArticleIndex: 0,
        body: "Great question! Adding the widget to Webflow takes about two minutes:\n\n1. Open **Settings → Install** in your dashboard and copy your embed snippet.\n2. In Webflow, go to **Project Settings → Custom Code** and paste the snippet into the **Footer Code** box so it loads on every page.\n3. Publish your site and refresh — a chat bubble will appear in the bottom-right corner.\n\nLet me know if the bubble doesn't show up and I can help you debug it!",
        deltaMs: 1 * MIN,
      },
      { author: "visitor", body: "Perfect, that worked. Thank you!", deltaMs: 4 * MIN },
      { author: "system", body: "Conversation marked as resolved.", deltaMs: 5 * MIN },
    ],
  },
  // 2. AI handled billing question with citation, open.
  {
    visitorName: "Liam Carter",
    mode: "ai",
    status: "open",
    daysAgo: 8,
    assignToSonny: false,
    messages: [
      { author: "visitor", body: "What's the difference between the Pro and Scale plans?", deltaMs: 0 },
      {
        author: "agent",
        isAi: true,
        citeArticleIndex: 1,
        body: "Both Pro and Scale include automatic crawling, proactive messages, and branding removal — the main difference is volume:\n\n- **Pro** — 2,000 AI messages/month, 200 KB documents, crawl up to 200 pages, 10 seats.\n- **Scale** — 20,000 AI messages/month, 2,000 KB documents, crawl up to 2,000 pages, 20 seats.\n\nIf you're handling high support volume, Scale is the better fit. You can upgrade any time from **Settings → Billing**.",
        deltaMs: 2 * MIN,
      },
    ],
  },
  // 3. AI couldn't fully answer, handed to human; Sonny replied. Closed.
  {
    visitorName: "Sophia Nguyen",
    mode: "human",
    status: "closed",
    daysAgo: 7,
    assignToSonny: true,
    messages: [
      { author: "visitor", body: "I was charged twice this month, can someone look into it?", deltaMs: 0 },
      {
        author: "agent",
        isAi: true,
        body: "I'm sorry about that — billing discrepancies are best handled by our team. Let me bring in a human to take a closer look at your account.",
        deltaMs: 1 * MIN,
      },
      { author: "system", body: "Sonny Sangha joined the conversation.", deltaMs: 3 * MIN },
      {
        author: "agent",
        body: "Hi Sophia, Sonny here. I found the duplicate charge and I've refunded it — you should see it back on your card in 3–5 business days. Really sorry for the hassle!",
        deltaMs: 12 * MIN,
      },
      { author: "visitor", body: "Amazing, thank you so much for the quick fix!", deltaMs: 20 * MIN },
      { author: "system", body: "Conversation marked as resolved.", deltaMs: 22 * MIN },
    ],
  },
  // 4. AI handled crawl question with citation, closed.
  {
    visitorName: "Noah Patel",
    mode: "ai",
    status: "closed",
    daysAgo: 6,
    assignToSonny: false,
    messages: [
      { author: "visitor", body: "Can I just point this at my docs site instead of writing articles?", deltaMs: 0 },
      {
        author: "agent",
        isAi: true,
        citeArticleIndex: 3,
        body: "Absolutely! Head to **Knowledge → Crawl a website**, enter your docs root URL, and choose how many pages to crawl. We'll fetch each page, strip out navigation, split the content into passages, and embed it into your knowledge base automatically.\n\nRe-running the crawl later is safe — we dedupe content we've already indexed. Automatic crawling is available on the Pro and Scale plans.",
        deltaMs: 90 * 1000,
      },
      { author: "visitor", body: "That's exactly what I needed. 🙌", deltaMs: 3 * MIN },
      { author: "system", body: "Conversation marked as resolved.", deltaMs: 4 * MIN },
    ],
  },
  // 5. Human conversation assigned to Sonny, open (in-progress).
  {
    visitorName: "Olivia Martinez",
    mode: "human",
    status: "open",
    daysAgo: 4,
    assignToSonny: true,
    messages: [
      { author: "visitor", body: "Hey, I'd love a demo of the team inbox features before we upgrade.", deltaMs: 0 },
      { author: "system", body: "Sonny Sangha joined the conversation.", deltaMs: 8 * MIN },
      {
        author: "agent",
        body: "Hi Olivia! Happy to walk you through it. The shared inbox lets your whole team see every conversation, assign threads, and take over from the AI with one click. Are you free for a quick call this week?",
        deltaMs: 11 * MIN,
      },
      { author: "visitor", body: "Thursday afternoon would be perfect.", deltaMs: 40 * MIN },
    ],
  },
  // 6. AI handled "how does the AI work", closed.
  {
    visitorName: "James Wilson",
    mode: "ai",
    status: "closed",
    daysAgo: 3,
    assignToSonny: false,
    messages: [
      { author: "visitor", body: "How does the bot know the answers? Is it just ChatGPT?", deltaMs: 0 },
      {
        author: "agent",
        isAi: true,
        citeArticleIndex: 4,
        body: "Good question! It's grounded in *your* content rather than the open internet. When you ask something, we embed your question, search your knowledge base for the most relevant passages, and the model writes an answer based on those passages — with citations back to the source articles. If nothing relevant is found, it declines or hands off to a human instead of guessing.",
        deltaMs: 2 * MIN,
      },
      { author: "system", body: "Conversation marked as resolved.", deltaMs: 6 * MIN },
    ],
  },
  // 7. Unassigned, open, in the queue (visitor waiting).
  {
    visitorName: "Ava Robinson",
    mode: "ai",
    status: "open",
    daysAgo: 1,
    assignToSonny: false,
    messages: [
      { author: "visitor", body: "Do you integrate with Slack? I'd want notifications there.", deltaMs: 0 },
      {
        author: "agent",
        isAi: true,
        body: "I don't have a knowledge base article covering Slack notifications yet, so I'd rather not guess. Let me flag this for the team — someone will follow up shortly with the details.",
        deltaMs: 1 * MIN,
      },
      { author: "visitor", body: "Sounds good, thanks!", deltaMs: 2 * MIN },
    ],
  },
  // 8. Unassigned, open, in the queue (brand new, this morning).
  {
    visitorName: "William Lee",
    mode: "ai",
    status: "open",
    daysAgo: 0,
    assignToSonny: false,
    messages: [
      { author: "visitor", body: "Hi, is there a way to get a refund if it doesn't work out for us?", deltaMs: 2 * HOUR },
      {
        author: "agent",
        isAi: true,
        citeArticleIndex: 5,
        body: "Yes! We offer a **14-day money-back guarantee** on paid plans — if it's not the right fit within 14 days of your first payment, contact us from **Settings → Billing** and we'll issue a full refund, no questions asked. After that you can cancel any time to stop future charges.",
        deltaMs: 2 * HOUR + 1 * MIN,
      },
    ],
  },
];

// ── Leads ────────────────────────────────────────────────────────────────────

type SeedLead = {
  firstName: string;
  lastName: string;
  email: string;
  status: "new" | "contacted" | "closed";
  daysAgo: number;
  // link to the conversation at this index (in CONVERSATIONS), if any
  linkConversationIndex?: number;
};

const LEADS: SeedLead[] = [
  { firstName: "Olivia", lastName: "Martinez", email: "olivia.martinez@brightlabs.io", status: "contacted", daysAgo: 4, linkConversationIndex: 4 },
  { firstName: "Liam", lastName: "Carter", email: "liam@carterdesign.co", status: "new", daysAgo: 8, linkConversationIndex: 1 },
  { firstName: "Ava", lastName: "Robinson", email: "ava.robinson@gmail.com", status: "new", daysAgo: 1, linkConversationIndex: 6 },
  { firstName: "Ethan", lastName: "Brooks", email: "ethan.brooks@northwind.com", status: "contacted", daysAgo: 5 },
  { firstName: "Mia", lastName: "Sullivan", email: "mia.sullivan@acme.dev", status: "closed", daysAgo: 6 },
  { firstName: "Daniel", lastName: "Kim", email: "daniel.kim@launchpad.app", status: "new", daysAgo: 2 },
];

// ─────────────────────────────────────────────────────────────────────────────

export const run = internalAction({
  args: {
    clerkOrgId: v.string(),
    clerkUserId: v.string(),
    reset: v.optional(v.boolean()),
  },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    alreadySeeded: v.boolean(),
    counts: v.object({
      articles: v.number(),
      chunks: v.number(),
      conversations: v.number(),
      messages: v.number(),
      leads: v.number(),
    }),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    workspaceId: Id<"workspaces">;
    alreadySeeded: boolean;
    counts: {
      articles: number;
      chunks: number;
      conversations: number;
      messages: number;
      leads: number;
    };
  }> => {
    const now = Date.now();

    // 1) Find-or-create the workspace + idempotency gate + optional reset.
    const prep = await ctx.runMutation(internal.seedMutations.prepare, {
      clerkOrgId: args.clerkOrgId,
      clerkUserId: args.clerkUserId,
      ownerName: "Sonny Sangha",
      workspaceName: "Sonny's Organization",
      slug: "sonnys-organization",
      reset: args.reset ?? false,
    });
    const workspaceId = prep.workspaceId;

    // Already seeded and not resetting → return early, no duplication.
    if (prep.alreadySeeded && !args.reset) {
      return {
        workspaceId,
        alreadySeeded: true,
        counts: { articles: 0, chunks: 0, conversations: 0, messages: 0, leads: 0 },
      };
    }

    // 2) Plan / billing mirror + usage meter + widget config (in one mutation).
    const free = PLANS.free_org;
    const periodStart = now - 14 * DAY; // mid-cycle so the usage meter reads ~14/100
    const periodEnd = now + 16 * DAY;
    await ctx.runMutation(internal.seedMutations.config, {
      workspaceId,
      clerkOrgId: args.clerkOrgId,
      planSlug: free.slug,
      features: free.features,
      limits: free.limits,
      periodStart,
      periodEnd,
      aiMessagesUsed: 14,
    });

    // 3) Articles — insert each + chunk + embed + write knowledgeChunks.
    let articleCount = 0;
    let chunkCount = 0;
    const articleIds: Id<"helpdeskArticles">[] = [];
    for (let i = 0; i < ARTICLES.length; i++) {
      const a = ARTICLES[i];
      const articleId = await ctx.runMutation(internal.seedMutations.insertArticle, {
        workspaceId,
        clerkUserId: args.clerkUserId,
        title: a.title,
        slug: slugify(a.title),
        category: a.category,
        excerpt: a.excerpt,
        bodyMarkdown: a.bodyMarkdown,
        isPopular: a.isPopular,
        order: i,
      });
      articleIds.push(articleId);
      articleCount += 1;

      // Embed exactly like articlesNode.reindex: header + stripped body.
      const header = `${a.title}\n${a.category}\n${a.excerpt}`;
      const plain = `${header}\n\n${stripMarkdown(a.bodyMarkdown)}`;
      const pieces = chunkText(plain, { maxTokens: MAX_TOKENS, overlap: OVERLAP });
      if (pieces.length === 0) continue;

      const embeddings = await embedTexts(pieces);
      const chunks = pieces.map((text, idx) => ({
        text,
        embedding: embeddings[idx],
        tokenCount: estimateTokens(text),
        contentHash: sha256(text),
      }));
      await ctx.runMutation(internal.seedMutations.writeArticleChunks, {
        workspaceId,
        articleId,
        title: a.title,
        chunks,
      });
      chunkCount += chunks.length;
    }

    // 4) Conversations + messages. Build the article-citation map first.
    const conversationPayloads = CONVERSATIONS.map((c) => {
      const base = now - c.daysAgo * DAY;
      const messages = c.messages.map((m) => {
        const citations =
          m.citeArticleIndex !== undefined
            ? [
                {
                  articleId: articleIds[m.citeArticleIndex],
                  title: ARTICLES[m.citeArticleIndex].title,
                  slug: slugify(ARTICLES[m.citeArticleIndex].title),
                },
              ]
            : undefined;
        return {
          author: m.author,
          body: m.body,
          isAi: m.isAi ?? false,
          createdAt: base + m.deltaMs,
          citations,
        };
      });
      return {
        visitorName: c.visitorName,
        mode: c.mode,
        status: c.status,
        assignToSonny: c.assignToSonny,
        messages,
      };
    });

    const convResult = await ctx.runMutation(internal.seedMutations.writeConversations, {
      workspaceId,
      assigneeClerkUserId: args.clerkUserId,
      conversations: conversationPayloads,
    });

    // 5) Leads — link some to seeded conversations by index.
    const leadPayloads = LEADS.map((l) => ({
      firstName: l.firstName,
      lastName: l.lastName,
      email: l.email,
      status: l.status,
      createdAt: now - l.daysAgo * DAY,
      conversationIndex: l.linkConversationIndex,
    }));
    const leadCount = await ctx.runMutation(internal.seedMutations.writeLeads, {
      workspaceId,
      conversationIds: convResult.conversationIds,
      leads: leadPayloads,
    });

    // 6) Completed crawl job for realism.
    await ctx.runMutation(internal.seedMutations.writeCrawlJob, {
      workspaceId,
      rootUrl: "https://sonnysangha.com",
      startedAt: now - 5 * DAY,
      finishedAt: now - 5 * DAY + 3 * MIN,
    });

    return {
      workspaceId,
      alreadySeeded: false,
      counts: {
        articles: articleCount,
        chunks: chunkCount,
        conversations: convResult.conversationCount,
        messages: convResult.messageCount,
        leads: leadCount,
      },
    };
  },
});
