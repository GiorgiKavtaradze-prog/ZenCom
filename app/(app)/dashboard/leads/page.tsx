"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  useConvex,
  useConvexAuth,
  useMutation,
  usePaginatedQuery,
} from "convex/react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import {
  Download,
  ExternalLink,
  Loader2,
  MessageSquare,
  Search,
  Users,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — DASHBOARD LEADS (authed, both roles). A data-table of captured
// contacts (name, email, phone, source, linked conversation, captured date,
// status) backed by `leads.list` (paginated, server-scoped to the active org).
// Filters: status, source, and free-text search. Each row exposes an inline
// status control (`leads.updateStatus`) and a link to the originating
// conversation in the inbox. A CSV export button pulls `leads.forExport` and
// builds the file client-side.
//
// The hard tenant boundary is the server: every query/mutation runs through
// `requireOrgMember`, so no member can read another org's leads regardless of
// what the client requests.
// ─────────────────────────────────────────────────────────────────────────────

type LeadStatus = "new" | "contacted" | "closed";

// Semantic status styling — brand for fresh leads, amber for in-progress,
// muted/closed for resolved. Each badge is a soft tinted pill with a matching
// leading dot for quick scanning down the column.
const STATUS_META: Record<
  LeadStatus,
  { label: string; badgeClass: string; dotClass: string }
> = {
  new: {
    label: "New",
    badgeClass: "border-brand/20 bg-brand/10 text-brand",
    dotClass: "bg-brand",
  },
  contacted: {
    label: "Contacted",
    badgeClass: "border-amber-500/20 bg-amber-500/10 text-amber-700",
    dotClass: "bg-amber-500",
  },
  closed: {
    label: "Closed",
    badgeClass: "border-border bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/50",
  },
};

// Source chips — visually distinct, soft-tinted pills.
const SOURCE_META: Record<string, string> = {
  widget: "border-brand-3/20 bg-brand-3/10 text-brand-3",
  proactive: "border-brand-2/20 bg-brand-2/10 text-brand-2",
};

const STATUS_OPTIONS: { value: LeadStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "closed", label: "Closed" },
];

const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "widget", label: "Widget" },
  { value: "proactive", label: "Proactive" },
];

function convexErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
  }
  return fallback;
}

function fullName(row: {
  firstName?: string;
  lastName?: string;
}): string {
  const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  return name || "—";
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function LeadsPage() {
  const { isAuthenticated } = useConvexAuth();
  const convex = useConvex();

  const [status, setStatus] = useState<LeadStatus | "all">("all");
  const [source, setSource] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);

  const updateStatus = useMutation(api.leads.updateStatus);

  const queryArgs = isAuthenticated
    ? {
        status: status === "all" ? undefined : status,
        source: source === "all" ? undefined : source,
        search: search.trim() || undefined,
      }
    : "skip";

  const { results, status: pageStatus, loadMore } = usePaginatedQuery(
    api.leads.list,
    queryArgs as
      | {
          status?: LeadStatus;
          source?: string;
          search?: string;
        }
      | "skip",
    { initialNumItems: 25 },
  );

  const loading = pageStatus === "LoadingFirstPage";
  const canLoadMore = pageStatus === "CanLoadMore";

  async function handleStatusChange(
    leadId: Id<"leads">,
    next: LeadStatus,
  ) {
    try {
      await updateStatus({ leadId, status: next });
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not update the lead."));
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const { rows, truncated } = await convex.query(api.leads.forExport, {
        status: status === "all" ? undefined : status,
      });
      if (rows.length === 0) {
        toast.info("No leads to export.");
        return;
      }
      downloadCsv(rows);
      if (truncated) {
        toast.warning(
          "Export was capped at 5,000 rows — narrow with a filter for the rest.",
        );
      } else {
        toast.success(`Exported ${rows.length} lead${rows.length === 1 ? "" : "s"}.`);
      }
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not export leads."));
    } finally {
      setExporting(false);
    }
  }

  const hasFilters =
    status !== "all" || source !== "all" || search.trim().length > 0;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 p-6 lg:p-8">
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <Users className="size-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Contacts captured from your widget — search, filter, and export.
            </p>
          </div>
        </div>
        <Button
          onClick={handleExport}
          disabled={exporting}
          variant="outline"
          className="shadow-sm"
        >
          {exporting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Export CSV
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-2xl border border-border bg-card p-3 shadow-card">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, phone…"
            className="h-10 border-transparent bg-muted/60 pl-9 focus-visible:bg-background"
          />
        </div>
        <Select
          value={status}
          onValueChange={(v) => setStatus(v as LeadStatus | "all")}
        >
          <SelectTrigger className="h-10 w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-10 w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="h-11 px-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Name
              </TableHead>
              <TableHead className="h-11 px-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Email
              </TableHead>
              <TableHead className="hidden h-11 px-5 text-xs font-medium uppercase tracking-wide text-muted-foreground md:table-cell">
                Phone
              </TableHead>
              <TableHead className="hidden h-11 px-5 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:table-cell">
                Source
              </TableHead>
              <TableHead className="hidden h-11 px-5 text-xs font-medium uppercase tracking-wide text-muted-foreground lg:table-cell">
                Captured
              </TableHead>
              <TableHead className="h-11 px-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Status
              </TableHead>
              <TableHead className="h-11 px-5 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Conversation
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i} className="border-border">
                  {Array.from({ length: 7 }).map((__, j) => (
                    <TableCell key={j} className="px-5 py-4">
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : results.length === 0 ? (
              <TableRow className="border-border hover:bg-transparent">
                <TableCell colSpan={7} className="h-72">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-4 text-center">
                    <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                      <Users className="size-6" />
                    </div>
                    <div className="space-y-1.5">
                      <p className="font-medium text-foreground">
                        {hasFilters
                          ? "No leads match these filters"
                          : "No leads captured yet"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {hasFilters
                          ? "Try adjusting or clearing your filters to see more results."
                          : "When visitors share their details in your widget, they'll appear here."}
                      </p>
                    </div>
                    {hasFilters ? null : (
                      <Button asChild variant="outline" size="sm">
                        <Link href="/dashboard/customizer">
                          Customize your widget
                        </Link>
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              results.map((lead) => (
                <TableRow key={lead._id} className="border-border">
                  <TableCell className="px-5 py-3.5 font-medium text-foreground">
                    {fullName(lead)}
                  </TableCell>
                  <TableCell className="px-5 py-3.5">
                    <a
                      href={`mailto:${lead.email}`}
                      className="truncate text-muted-foreground underline-offset-2 transition-colors hover:text-brand hover:underline"
                    >
                      {lead.email}
                    </a>
                  </TableCell>
                  <TableCell className="hidden px-5 py-3.5 text-muted-foreground md:table-cell">
                    {lead.phone ?? "—"}
                  </TableCell>
                  <TableCell className="hidden px-5 py-3.5 sm:table-cell">
                    <Badge
                      variant="outline"
                      className={`h-6 capitalize ${
                        SOURCE_META[lead.source] ??
                        "border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      {lead.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden px-5 py-3.5 text-muted-foreground lg:table-cell">
                    {formatDate(lead.createdAt)}
                  </TableCell>
                  <TableCell className="px-5 py-3.5">
                    <Select
                      value={lead.status}
                      onValueChange={(v) =>
                        handleStatusChange(lead._id, v as LeadStatus)
                      }
                    >
                      <SelectTrigger className="h-8 w-fit gap-1.5 border-none bg-transparent px-1.5 shadow-none hover:bg-muted focus-visible:ring-0">
                        <Badge
                          variant="outline"
                          className={`h-6 gap-1.5 ${STATUS_META[lead.status].badgeClass}`}
                        >
                          <span
                            className={`size-1.5 rounded-full ${STATUS_META[lead.status].dotClass}`}
                          />
                          {STATUS_META[lead.status].label}
                        </Badge>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new">New</SelectItem>
                        <SelectItem value="contacted">Contacted</SelectItem>
                        <SelectItem value="closed">Closed</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="px-5 py-3.5 text-right">
                    {lead.conversationId ? (
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-brand"
                      >
                        <Link
                          href={`/dashboard?conversation=${lead.conversationId}`}
                        >
                          <MessageSquare className="size-4" />
                          <span className="sr-only">Open conversation</span>
                          <ExternalLink className="size-3.5" />
                        </Link>
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {canLoadMore ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => loadMore(25)}
            className="shadow-sm"
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// Build + download a CSV from the export rows. Quotes every field and escapes
// embedded quotes (RFC 4180) so commas/newlines in names don't break columns.
function downloadCsv(
  rows: Array<{
    firstName?: string;
    lastName?: string;
    email: string;
    phone?: string;
    source: string;
    status: string;
    createdAt: number;
    conversationId?: Id<"conversations">;
  }>,
): void {
  const headers = [
    "First name",
    "Last name",
    "Email",
    "Phone",
    "Source",
    "Status",
    "Captured at",
    "Conversation id",
  ];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.firstName ?? "",
        r.lastName ?? "",
        r.email,
        r.phone ?? "",
        r.source,
        r.status,
        new Date(r.createdAt).toISOString(),
        r.conversationId ?? "",
      ]
        .map((v) => esc(String(v)))
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\r\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
