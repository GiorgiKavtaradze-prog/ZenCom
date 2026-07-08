"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { renderMarkdown } from "@/lib/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  ChevronRight,
  Search,
  FileText,
  Folder,
  Star,
} from "lucide-react";

type Props = {
  workspaceId: Id<"workspaces">;
  // When set (e.g. a visitor clicked a suggested-article chip in the chat tab),
  // jump straight to that article. `onArticleConsumed` clears it after handling
  // so navigating away and back doesn't re-trigger the jump.
  requestedSlug?: string | null;
  onArticleConsumed?: () => void;
  // When set, open the help center pre-filled with this search query (used for
  // suggested chips that have a title but no direct article slug).
  requestedSearch?: string | null;
  onSearchConsumed?: () => void;
  // Whether the Help tab is part of the widget's tab bar. When false, the
  // helpdesk was opened ad-hoc from a chat chip, so we surface a "Back to chat"
  // affordance (there's no tab bar to return through). `onExit` returns to chat.
  faqEnabled?: boolean;
  onExit?: () => void;
};

// The helpdesk has three views: the home (popular + categories), a category
// listing, and the single-article reader. Search overlays the home view.
type View =
  | { kind: "home" }
  | { kind: "category"; category: string }
  | { kind: "article"; slug: string };

export function HelpdeskTab({
  workspaceId,
  requestedSlug,
  onArticleConsumed,
  requestedSearch,
  onSearchConsumed,
  faqEnabled = true,
  onExit,
}: Props) {
  const [view, setView] = useState<View>({ kind: "home" });
  const [search, setSearch] = useState("");
  const trimmed = search.trim();

  // Honor an externally requested article (from a chat citation chip).
  useEffect(() => {
    if (requestedSlug) {
      setView({ kind: "article", slug: requestedSlug });
      onArticleConsumed?.();
    }
  }, [requestedSlug, onArticleConsumed]);

  // Honor an externally requested search (a chip with a title but no slug):
  // land on the home view with the query pre-filled so results show.
  useEffect(() => {
    if (requestedSearch != null && requestedSearch !== "") {
      setView({ kind: "home" });
      setSearch(requestedSearch);
      onSearchConsumed?.();
    }
  }, [requestedSearch, onSearchConsumed]);

  const popular = useQuery(api.articles.listPopular, {
    workspaceId,
    limit: 6,
  });
  const categories = useQuery(api.articles.listCategories, { workspaceId });
  const searchResults = useQuery(
    api.articles.searchArticles,
    trimmed.length >= 2 ? { workspaceId, query: trimmed, limit: 12 } : "skip",
  );

  const showSearch = trimmed.length >= 2;

  if (view.kind === "article") {
    return (
      <ArticleReader
        workspaceId={workspaceId}
        slug={view.slug}
        backLabel={faqEnabled ? "Back" : "Back to chat"}
        onBack={
          faqEnabled
            ? () => setView({ kind: "home" })
            : (onExit ?? (() => setView({ kind: "home" })))
        }
      />
    );
  }

  if (view.kind === "category") {
    return (
      <CategoryView
        workspaceId={workspaceId}
        category={view.category}
        onBack={() => setView({ kind: "home" })}
        onOpenArticle={(slug) => setView({ kind: "article", slug })}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#fafafb]">
      {/* When the Help tab isn't in the nav (opened from a chat chip), give the
          visitor a way back to the conversation. */}
      {!faqEnabled && onExit ? (
        <BackBar label="Back to chat" onBack={onExit} />
      ) : null}
      {/* Search */}
      <div className="border-b border-neutral-100 bg-white p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search for help…"
            aria-label="Search the help center"
            className="w-full rounded-xl border border-neutral-200 bg-neutral-50 py-2.5 pl-10 pr-3 text-sm outline-none transition placeholder:text-neutral-400 focus:border-transparent focus:bg-white focus:ring-2 focus:ring-[var(--wc-button)]/30"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {showSearch ? (
          <div className="p-3">
            <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              Results for “{trimmed}”
            </p>
            {searchResults === undefined ? (
              <ListSkeleton />
            ) : searchResults.length === 0 ? (
              <EmptyHint text="No articles matched your search." />
            ) : (
              <ul className="space-y-1.5">
                {searchResults.map((a) => (
                  <ArticleRow
                    key={a._id}
                    title={a.title}
                    subtitle={a.excerpt ?? a.category}
                    onClick={() => setView({ kind: "article", slug: a.slug })}
                  />
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-6 p-3">
            {/* Popular questions */}
            <section>
              <SectionLabel icon={<Star className="size-3.5" />}>
                Popular questions
              </SectionLabel>
              {popular === undefined ? (
                <ListSkeleton />
              ) : popular.length === 0 ? (
                <EmptyHint text="No popular articles yet." />
              ) : (
                <ul className="space-y-1.5">
                  {popular.map((a) => (
                    <ArticleRow
                      key={a._id}
                      title={a.title}
                      subtitle={a.excerpt}
                      onClick={() => setView({ kind: "article", slug: a.slug })}
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* Categories */}
            <section>
              <SectionLabel icon={<Folder className="size-3.5" />}>
                Browse by category
              </SectionLabel>
              {categories === undefined ? (
                <ListSkeleton />
              ) : categories.length === 0 ? (
                <EmptyHint text="No categories yet." />
              ) : (
                <ul className="space-y-1.5">
                  {categories.map((c) => (
                    <button
                      key={c.category}
                      onClick={() =>
                        setView({ kind: "category", category: c.category })
                      }
                      className="group flex w-full items-center justify-between gap-2 rounded-xl bg-white px-3 py-2.5 text-left text-sm shadow-sm ring-1 ring-black/5 transition hover:shadow-md hover:ring-black/10"
                    >
                      <span className="flex min-w-0 items-center gap-2.5 font-medium text-neutral-800">
                        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-neutral-100 text-neutral-500">
                          <Folder className="size-3.5" />
                        </span>
                        <span className="truncate">{c.category}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-neutral-400">
                        {c.count}
                        <ChevronRight className="size-4 transition group-hover:translate-x-0.5 group-hover:text-neutral-500" />
                      </span>
                    </button>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryView({
  workspaceId,
  category,
  onBack,
  onOpenArticle,
}: {
  workspaceId: Id<"workspaces">;
  category: string;
  onBack: () => void;
  onOpenArticle: (slug: string) => void;
}) {
  const articles = useQuery(api.articles.listByCategory, {
    workspaceId,
    category,
    limit: 100,
  });
  return (
    <div className="flex h-full flex-col bg-[#fafafb]">
      <BackBar label={category} onBack={onBack} />
      <div className="flex-1 overflow-y-auto p-3">
        {articles === undefined ? (
          <ListSkeleton />
        ) : articles.length === 0 ? (
          <EmptyHint text="No articles in this category yet." />
        ) : (
          <ul className="space-y-1.5">
            {articles.map((a) => (
              <ArticleRow
                key={a._id}
                title={a.title}
                subtitle={a.excerpt}
                onClick={() => onOpenArticle(a.slug)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ArticleReader({
  workspaceId,
  slug,
  onBack,
  backLabel = "Back",
}: {
  workspaceId: Id<"workspaces">;
  slug: string;
  onBack: () => void;
  backLabel?: string;
}) {
  const article = useQuery(api.articles.getBySlug, { workspaceId, slug });
  const html = useMemo(
    () => (article ? renderMarkdown(article.bodyMarkdown) : ""),
    [article],
  );

  return (
    <div className="flex h-full flex-col bg-white">
      <BackBar label={backLabel} onBack={onBack} />
      <div className="flex-1 overflow-y-auto p-5">
        {article === undefined ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : article === null ? (
          <EmptyHint text="This article is no longer available." />
        ) : (
          <article>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--wc-theme)]">
              {article.category}
            </p>
            <h1 className="mb-4 text-xl font-semibold tracking-tight text-neutral-900">
              {article.title}
            </h1>
            <div
              className="wc-prose text-sm leading-relaxed text-neutral-700"
              // Admin-authored, published-only, server-escaped markdown.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </article>
        )}
      </div>
    </div>
  );
}

// ── small presentational helpers ─────────────────────────────────────────────

function SectionLabel({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <p className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
      {icon}
      {children}
    </p>
  );
}

function ArticleRow({
  title,
  subtitle,
  onClick,
}: {
  title: string;
  subtitle?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className="group flex w-full items-start gap-3 rounded-xl bg-white px-3 py-2.5 text-left shadow-sm ring-1 ring-black/5 transition hover:shadow-md hover:ring-black/10"
      >
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--wc-theme)]/10 text-[var(--wc-theme)]">
          <FileText className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-neutral-800">
            {title}
          </span>
          {subtitle ? (
            <span className="mt-0.5 block truncate text-xs leading-relaxed text-neutral-400">
              {subtitle}
            </span>
          ) : null}
        </span>
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-neutral-300 transition group-hover:translate-x-0.5 group-hover:text-neutral-500" />
      </button>
    </li>
  );
}

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-neutral-100 bg-white p-2.5">
      <button
        onClick={onBack}
        className="group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100"
      >
        <ArrowLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
        <span className="max-w-[220px] truncate">{label}</span>
      </button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1.5">
      <Skeleton className="h-12 w-full rounded-xl" />
      <Skeleton className="h-12 w-full rounded-xl" />
      <Skeleton className="h-12 w-full rounded-xl" />
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="px-2 py-8 text-center text-sm text-neutral-400">{text}</p>
  );
}
