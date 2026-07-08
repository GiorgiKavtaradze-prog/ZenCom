"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ConvexError } from "convex/values";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Globe,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useHasFeature } from "@/lib/entitlement";
import { toast } from "sonner";
import { startCrawlAction } from "./actions";

type CrawlStatus = "queued" | "running" | "completed" | "failed";

const crawlSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Enter a URL.")
    .url("Enter a valid http(s) URL."),
});
type CrawlForm = z.infer<typeof crawlSchema>;

function convexErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
  }
  return fallback;
}

export function CrawlerTab() {
  const { isLoaded, allowed: crawlAllowed } = useHasFeature("website_crawl");
  const jobs = useQuery(api.crawler.listJobs, {});
  const sources = useQuery(api.kb.listSources, {});

  const form = useForm<CrawlForm>({
    resolver: zodResolver(crawlSchema),
    defaultValues: { url: "" },
  });

  async function onSubmit(values: CrawlForm) {
    const res = await startCrawlAction(values.url);
    if (res.ok) {
      toast.success("Crawl started — pages will appear below as they ingest.");
      form.reset({ url: "" });
    } else {
      toast.error(res.error);
    }
  }

  const hasRunning = (jobs ?? []).some((j) => j.status === "running");
  const submitting = form.formState.isSubmitting;

  return (
    <div className="space-y-10">
      {/* Add website form */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-card">
        <div
          aria-hidden
          className="bg-dotgrid pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(60%_80%_at_15%_0%,black,transparent)]"
        />
        <div className="relative flex items-start gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <Globe className="size-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold tracking-tight">
              Crawl a website
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter a page on your own site. We crawl same-origin pages, then
              chunk and embed them into your AI knowledge base.
            </p>

            <div className="mt-5">
              {isLoaded && !crawlAllowed ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/20 bg-brand/5 p-4 text-sm">
                  <span className="text-foreground">
                    Website crawling isn’t included in your current plan.
                  </span>
                  <Button
                    asChild
                    size="sm"
                    className="bg-gradient-to-br from-brand to-brand-2 text-white shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95"
                  >
                    <a href="/pricing">Upgrade plan</a>
                  </Button>
                </div>
              ) : (
                <Form {...form}>
                  <form
                    onSubmit={form.handleSubmit(onSubmit)}
                    className="flex flex-col gap-3 sm:flex-row sm:items-start"
                  >
                    <FormField
                      control={form.control}
                      name="url"
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          <FormLabel className="sr-only">Website URL</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="https://docs.example.com"
                              autoComplete="off"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="submit"
                      disabled={submitting || hasRunning || !isLoaded}
                      className="bg-gradient-to-br from-brand to-brand-2 text-white shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95"
                    >
                      {submitting ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      {hasRunning ? "Crawl running…" : "Start crawl"}
                    </Button>
                  </form>
                </Form>
              )}
              {hasRunning ? (
                <p className="text-muted-foreground mt-3 text-xs">
                  Only one crawl can run at a time. Wait for the current one to
                  finish.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Crawl jobs with live progress */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight">Crawl jobs</h2>
          {jobs !== undefined && jobs.length > 0 ? (
            <Badge variant="secondary" className="font-medium">
              {jobs.length}
            </Badge>
          ) : null}
        </div>
        {jobs === undefined ? (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full rounded-2xl" />
            <Skeleton className="h-28 w-full rounded-2xl" />
          </div>
        ) : jobs.length === 0 ? (
          <EmptyState
            icon={<Globe className="size-6" />}
            title="No crawls yet"
            description="Start your first crawl above to import pages from your site into the knowledge base."
          />
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <CrawlJobCard key={job._id} job={job} />
            ))}
          </div>
        )}
      </section>

      {/* Ingested sources */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight">
            Ingested sources
          </h2>
          {sources !== undefined && sources.length > 0 ? (
            <Badge variant="secondary" className="font-medium">
              {sources.length}
            </Badge>
          ) : null}
        </div>
        {sources === undefined ? (
          <Skeleton className="h-24 w-full rounded-2xl" />
        ) : sources.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-6" />}
            title="Nothing ingested yet"
            description="Crawled pages and uploaded documents show up here once they’re embedded."
          />
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-card">
            {sources.map((s) => (
              <SourceRow key={s.key} source={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── crawl job card (live, reactive) ───────────────────────────────────────────

function CrawlJobCard({
  job,
}: {
  job: {
    _id: Id<"crawlJobs">;
    rootUrl: string;
    status: CrawlStatus;
    maxPages: number;
    pagesDiscovered: number;
    pagesCrawled: number;
    chunksCreated: number;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
  };
}) {
  const deleteJob = useMutation(api.crawler.deleteJob);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  // Progress is bounded by discovered pages (which grows as the crawl expands).
  const denom = Math.max(job.pagesDiscovered, 1);
  const pct =
    job.status === "completed"
      ? 100
      : Math.min(100, Math.round((job.pagesCrawled / denom) * 100));

  async function reCrawl() {
    setBusy(true);
    try {
      const res = await startCrawlAction(job.rootUrl);
      if (res.ok) {
        toast.success("Re-crawl started.");
      } else {
        toast.error(res.error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    setBusy(true);
    try {
      await deleteJob({ crawlJobId: job._id });
      toast.success("Crawl source removed from the knowledge base.");
      setConfirmDelete(false);
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not delete the crawl."));
    } finally {
      setBusy(false);
    }
  }

  const isRunning = job.status === "running";

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-card transition-colors hover:border-border">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
              job.status === "failed"
                ? "bg-rose-100 text-rose-600"
                : isRunning
                  ? "bg-brand/10 text-brand"
                  : "bg-emerald-100 text-emerald-600"
            }`}
          >
            <Globe className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={job.rootUrl}>
              {job.rootUrl}
            </p>
            <p className="text-muted-foreground text-xs">
              {job.pagesCrawled} / {job.pagesDiscovered} pages ·{" "}
              {job.chunksCreated} chunk{job.chunksCreated === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <StatusBadge status={job.status} />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void reCrawl()}
            disabled={busy || isRunning}
            aria-label="Re-crawl"
            title="Re-crawl"
          >
            <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirmDelete(true)}
            disabled={busy || isRunning}
            aria-label="Delete crawl"
            title="Delete crawl"
          >
            <Trash2 className="text-destructive size-4" />
          </Button>
        </div>
      </div>

      {isRunning ? (
        <div className="space-y-1.5">
          <Progress value={pct} />
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3 animate-spin" />
            Crawling… {pct}%
          </p>
        </div>
      ) : null}

      {job.status === "failed" && job.error ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-xl border p-3 text-xs">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{job.error}</span>
        </div>
      ) : null}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this crawl source?</AlertDialogTitle>
            <AlertDialogDescription>
              Every page and chunk imported from {job.rootUrl} will be removed
              from your AI knowledge base. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void onDelete();
              }}
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── ingested source row ───────────────────────────────────────────────────────

function SourceRow({
  source,
}: {
  source: {
    key: string;
    source: "crawl" | "file";
    title: string;
    sourceUrl?: string;
    crawlJobId?: Id<"crawlJobs">;
    chunkCount: number;
    lastUpdated: number;
  };
}) {
  const deleteJob = useMutation(api.crawler.deleteJob);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  // Crawl sources can be deleted via the owning job. File sources are deleted
  // from the document uploader surface (no per-file delete in this build).
  const canDelete =
    source.source === "crawl" && source.crawlJobId !== undefined;

  async function onDelete() {
    if (!source.crawlJobId) return;
    setBusy(true);
    try {
      await deleteJob({ crawlJobId: source.crawlJobId });
      toast.success("Source removed from the knowledge base.");
      setConfirmDelete(false);
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not delete the source."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 p-4 transition-colors hover:bg-muted/40">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          {source.source === "crawl" ? (
            <Globe className="size-5" />
          ) : (
            <FileText className="size-5" />
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={source.title}>
            {source.title}
          </p>
          <p className="text-muted-foreground truncate text-xs">
            {source.sourceUrl ??
              (source.source === "crawl"
                ? "Website crawl"
                : "Uploaded document")}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" className="font-medium">
          {source.chunkCount} chunk{source.chunkCount === 1 ? "" : "s"}
        </Badge>
        {canDelete ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            aria-label="Delete source"
            title="Delete source"
          >
            <Trash2 className="text-destructive size-4" />
          </Button>
        ) : null}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this source?</AlertDialogTitle>
            <AlertDialogDescription>
              “{source.title}” and its {source.chunkCount} chunk
              {source.chunkCount === 1 ? "" : "s"} will be removed from your AI
              knowledge base. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void onDelete();
              }}
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── small presentational helpers ──────────────────────────────────────────────

function StatusBadge({ status }: { status: CrawlStatus }) {
  switch (status) {
    case "running":
      return (
        <Badge className="gap-1 border-transparent bg-brand/10 font-medium text-brand">
          <Loader2 className="size-3 animate-spin" />
          Running
        </Badge>
      );
    case "completed":
      return (
        <Badge className="gap-1 border-transparent bg-emerald-100 font-medium text-emerald-700">
          <CheckCircle2 className="size-3" />
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge className="gap-1 border-transparent bg-rose-100 font-medium text-rose-700">
          <AlertCircle className="size-3" />
          Failed
        </Badge>
      );
    default:
      return (
        <Badge className="gap-1 border-transparent bg-amber-100 font-medium text-amber-700">
          <span className="size-1.5 rounded-full bg-amber-500" />
          Queued
        </Badge>
      );
  }
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
      <div className="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
        {icon}
      </div>
      <p className="mt-5 text-base font-medium tracking-tight">{title}</p>
      <p className="text-muted-foreground mt-1.5 max-w-sm text-sm">
        {description}
      </p>
    </div>
  );
}
