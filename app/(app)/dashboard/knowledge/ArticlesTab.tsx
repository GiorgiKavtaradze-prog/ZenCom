"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ConvexError } from "convex/values";
import {
  FileText,
  ImageIcon,
  Loader2,
  Pencil,
  Plus,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

type Article = Doc<"helpdeskArticles">;

const articleSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(200),
  category: z.string().trim().max(80),
  bodyMarkdown: z.string().max(200_000),
  excerpt: z.string().trim().max(500).optional(),
  isPopular: z.boolean(),
  published: z.boolean(),
});

type ArticleForm = z.infer<typeof articleSchema>;

function convexErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
  }
  return fallback;
}

export function ArticlesTab() {
  const articles = useQuery(api.articles.list, {});
  const remove = useMutation(api.articles.remove);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Article | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Article | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditing(null);
    setEditorOpen(true);
  }
  function openEdit(article: Article) {
    setEditing(article);
    setEditorOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await remove({ articleId: deleteTarget._id });
      toast.success("Article deleted.");
      setDeleteTarget(null);
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not delete the article."));
    } finally {
      setDeleting(false);
    }
  }

  const loading = articles === undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Articles</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {loading
              ? "Loading articles…"
              : articles.length === 0
                ? "Published articles feed your AI knowledge base."
                : `${articles.length} article${
                    articles.length === 1 ? "" : "s"
                  } · published articles feed your AI`}
          </p>
        </div>
        <Button
          onClick={openCreate}
          className="bg-gradient-to-br from-brand to-brand-2 text-white shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95"
        >
          <Plus className="size-4" />
          New article
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="overflow-hidden rounded-2xl border border-border bg-card shadow-card"
            >
              <Skeleton className="h-28 w-full rounded-none" />
              <div className="space-y-3 p-5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : articles.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
            <FileText className="size-6" />
          </div>
          <h3 className="mt-5 text-base font-medium tracking-tight">
            No articles yet
          </h3>
          <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
            Write your first help article. Published articles are embedded into
            your AI knowledge base so it can answer from them instantly.
          </p>
          <Button
            onClick={openCreate}
            className="mt-6 bg-gradient-to-br from-brand to-brand-2 text-white shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95"
          >
            <Plus className="size-4" />
            New article
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {articles.map((article) => (
            <ArticleCard
              key={article._id}
              article={article}
              onEdit={() => openEdit(article)}
              onDelete={() => setDeleteTarget(article)}
            />
          ))}
        </div>
      )}

      <ArticleEditor
        key={editing?._id ?? "new"}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        article={editing}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this article?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.title}” will be permanently removed, along with its
              cover image and any AI knowledge it contributed. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Article card ──────────────────────────────────────────────────────────────

function ArticleCard({
  article,
  onEdit,
  onDelete,
}: {
  article: Article;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isPublished = article.status === "published";
  const summary = article.excerpt?.trim() || article.bodyMarkdown?.trim() || "";

  return (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-card transition-all duration-300 hover:-translate-y-1 hover:border-brand/30 hover:shadow-elevated">
      {/* Cover band */}
      <div className="relative flex h-28 items-center justify-center overflow-hidden border-b border-border bg-gradient-to-br from-brand/10 via-brand-2/10 to-brand-3/10">
        <div
          aria-hidden
          className="bg-dotgrid pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(70%_70%_at_50%_40%,black,transparent)]"
        />
        {article.coverImageStorageId ? (
          <span className="relative flex items-center gap-1.5 rounded-full border border-border/60 bg-card/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
            <ImageIcon className="size-3.5" />
            Cover image
          </span>
        ) : (
          <FileText className="relative size-7 text-brand/40" />
        )}
        {/* Status / popular pills */}
        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
          {isPublished ? (
            <Badge className="gap-1 border-transparent bg-emerald-100 font-medium text-emerald-700">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Published
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="gap-1 border-border bg-card/80 font-medium text-muted-foreground backdrop-blur"
            >
              <span className="size-1.5 rounded-full bg-muted-foreground/50" />
              Draft
            </Badge>
          )}
          {article.isPopular ? (
            <Badge className="gap-1 border-transparent bg-amber-100 font-medium text-amber-700">
              <Star className="size-3 fill-current" />
              Popular
            </Badge>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-5">
        <Badge
          variant="outline"
          className="w-fit border-brand/20 bg-brand/5 font-medium text-brand"
        >
          {article.category}
        </Badge>
        <h3 className="mt-3 line-clamp-2 text-base font-semibold tracking-tight">
          {article.title}
        </h3>
        {summary ? (
          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {summary}
          </p>
        ) : null}

        <div className="mt-auto flex items-center justify-end gap-1 pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onEdit}
            aria-label={`Edit ${article.title}`}
          >
            <Pencil className="size-3.5" />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={`Delete ${article.title}`}
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Create/edit dialog ────────────────────────────────────────────────────────

function ArticleEditor({
  open,
  onOpenChange,
  article,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  article: Article | null;
}) {
  const create = useMutation(api.articles.create);
  const update = useMutation(api.articles.update);
  const setPublished = useMutation(api.articles.setPublished);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const finalizeImage = useMutation(api.files.finalizeImageUpload);

  // Resolve existing cover image URL (admin-only query) for preview.
  const existingCoverUrl = useQuery(
    api.files.getUrl,
    article?.coverImageStorageId
      ? { storageId: article.coverImageStorageId }
      : "skip",
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [coverStorageId, setCoverStorageId] = useState<
    Id<"_storage"> | null | undefined
  >(undefined); // undefined = unchanged, null = removed
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const form = useForm<ArticleForm>({
    resolver: zodResolver(articleSchema),
    defaultValues: {
      title: article?.title ?? "",
      category: article?.category ?? "",
      bodyMarkdown: article?.bodyMarkdown ?? "",
      excerpt: article?.excerpt ?? "",
      isPopular: article?.isPopular ?? false,
      published: article?.status === "published",
    },
  });

  const shownCover = useMemo(() => {
    if (coverStorageId === null) return null; // explicitly removed
    if (coverPreview) return coverPreview; // freshly uploaded
    return existingCoverUrl ?? null; // existing
  }, [coverStorageId, coverPreview, existingCoverUrl]);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      // Server validates MIME + size (SVG rejected) and throws on rejection.
      const finalized = await finalizeImage({ storageId });
      setCoverStorageId(finalized.storageId);
      setCoverPreview(finalized.url);
      toast.success("Cover image uploaded.");
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not upload the image."));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onSubmit(values: ArticleForm) {
    try {
      if (article) {
        // Update content + flags. coverImageStorageId is only sent when changed.
        await update({
          articleId: article._id,
          title: values.title,
          category: values.category,
          bodyMarkdown: values.bodyMarkdown,
          excerpt: values.excerpt || undefined,
          isPopular: values.isPopular,
          ...(coverStorageId !== undefined
            ? { coverImageStorageId: coverStorageId ?? undefined }
            : {}),
        });
        // Publish state is a separate mutation (it manages KB chunk lifecycle).
        const wasPublished = article.status === "published";
        if (values.published !== wasPublished) {
          await setPublished({
            articleId: article._id,
            published: values.published,
          });
        }
        toast.success("Article saved.");
      } else {
        await create({
          title: values.title,
          category: values.category,
          bodyMarkdown: values.bodyMarkdown,
          excerpt: values.excerpt || undefined,
          isPopular: values.isPopular,
          publish: values.published,
          ...(coverStorageId ? { coverImageStorageId: coverStorageId } : {}),
        });
        toast.success(
          values.published
            ? "Article published — indexing for AI now."
            : "Draft created.",
        );
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not save the article."));
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{article ? "Edit article" : "New article"}</DialogTitle>
          <DialogDescription>
            Published articles are embedded into your AI knowledge base. Drafts
            are saved but not used by the AI.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-5"
          >
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input placeholder="How to reset your password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <FormControl>
                    <Input placeholder="Getting started" {...field} />
                  </FormControl>
                  <FormDescription>
                    Defaults to “General” if left blank.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="excerpt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Excerpt</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Short summary shown in lists (optional)"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="bodyMarkdown"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Body</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Write your article in Markdown…"
                      className="min-h-48 font-mono text-sm"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Markdown supported. A rich WYSIWYG editor is a planned
                    follow-up.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Cover image */}
            <div className="space-y-2">
              <FormLabel>Cover image</FormLabel>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
              {shownCover ? (
                <div className="group/cover relative w-full overflow-hidden rounded-xl border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={shownCover}
                    alt="Cover preview"
                    className="h-44 w-full object-cover"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    className="absolute right-2 top-2 rounded-full shadow-soft"
                    onClick={() => {
                      setCoverStorageId(null);
                      setCoverPreview(null);
                    }}
                    aria-label="Remove cover image"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex h-44 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-input bg-muted/30 text-sm text-muted-foreground transition-colors hover:border-brand/40 hover:bg-brand/5 disabled:opacity-60"
                >
                  <span className="flex size-11 items-center justify-center rounded-xl bg-brand/10 text-brand">
                    {uploading ? (
                      <Loader2 className="size-5 animate-spin" />
                    ) : (
                      <ImageIcon className="size-5" />
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <Upload className="size-3.5" />
                    {uploading ? "Uploading…" : "Upload a cover image"}
                  </span>
                </button>
              )}
              <p className="text-muted-foreground text-xs">
                PNG, JPEG, WebP or GIF up to 5 MB. SVG is not allowed.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="isPopular"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 p-4">
                    <div className="space-y-0.5">
                      <FormLabel>Popular</FormLabel>
                      <FormDescription className="text-xs">
                        Feature in the widget home.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="published"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 p-4">
                    <div className="space-y-0.5">
                      <FormLabel>Published</FormLabel>
                      <FormDescription className="text-xs">
                        Live + used by the AI.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting || uploading}
                className="bg-gradient-to-br from-brand to-brand-2 text-white shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95"
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {article ? "Save changes" : "Create article"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
