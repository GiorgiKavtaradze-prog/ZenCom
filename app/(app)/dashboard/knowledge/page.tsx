"use client";

import { useConvexAuth } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { BookOpen, Lock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArticlesTab } from "./ArticlesTab";
import { CrawlerTab } from "./CrawlerTab";

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge base dashboard (Phase 3). Admin-gated:
//   - Every Convex mutation here (articles.create/update/remove, crawler.*,
//     files.*) calls requireAdmin on the server — the real boundary.
//   - Client-side we read Clerk orgRole and only render the editor surface for
//     admins (support members see an "admins only" notice), avoiding the error
//     boundary that a thrown admin-gated query would trigger.
//
// Two tabs:
//   - Articles : helpdesk article CRUD (title/category/body/popular/published +
//     cover image), wired to convex/articles.ts. Publishing embeds the article.
//   - Crawler  : start a website crawl (convex/crawler.startCrawl), watch live
//     job progress (crawler.listJobs, reactive), and manage ingested sources
//     (kb.listSources + crawler.deleteJob / re-crawl).
// ─────────────────────────────────────────────────────────────────────────────

export default function KnowledgePage() {
  const { isAuthenticated } = useConvexAuth();
  const { isLoaded: clerkLoaded, orgRole } = useAuth();
  const isAdmin = orgRole === "org:admin";

  if (!clerkLoaded || !isAuthenticated) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-8 p-6 lg:p-8">
        <div className="space-y-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-5 w-72" />
        </div>
        <Skeleton className="h-10 w-64 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-24 text-center">
        <div className="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
          <Lock className="size-6" />
        </div>
        <h2 className="mt-5 text-lg font-medium tracking-tight">Admins only</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Only organization admins can manage the knowledge base. Ask an admin
          on your team for access.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 p-6 lg:p-8">
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <BookOpen className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Knowledge base
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage the articles and crawled pages your AI answers from.
          </p>
        </div>
      </div>

      <Tabs defaultValue="articles" className="w-full">
        <TabsList>
          <TabsTrigger value="articles">Articles</TabsTrigger>
          <TabsTrigger value="crawler">Website crawler</TabsTrigger>
        </TabsList>
        <TabsContent value="articles" className="mt-8">
          <ArticlesTab />
        </TabsContent>
        <TabsContent value="crawler" className="mt-8">
          <CrawlerTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
