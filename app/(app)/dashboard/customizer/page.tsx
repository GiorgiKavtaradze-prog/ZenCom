"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { Lock, Palette } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { CustomizerEditor } from "./CustomizerEditor";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — WIDGET CUSTOMIZER (admin-gated). A no-code editor for the widget's
// appearance (colors, radius, margins, title, logo, position, sound) and its
// behaviour (proactive message, lead capture, FAQ/helpdesk toggle), with a live
// preview pane and the copy-paste install snippet.
//
// Admin-gating is enforced TWICE:
//   - Server: every mutation here (widget.updateAppearance / updateSettings,
//     files.generateUploadUrl / finalizeImageUpload) calls `requireAdmin`.
//   - Client: we read Clerk's orgRole and only mount the editor for admins,
//     mirroring the knowledge page so support members see an "admins only"
//     notice instead of tripping the error boundary on an admin-gated query.
//
// The workspaceId (the public embed app_id) is read from getActiveWorkspace and
// drives both the live-preview iframe (src="/widget?app_id=…") and the snippet.
// ─────────────────────────────────────────────────────────────────────────────

export default function CustomizerPage() {
  const { isAuthenticated } = useConvexAuth();
  const { isLoaded: clerkLoaded, orgRole } = useAuth();
  const isAdmin = orgRole === "org:admin";

  const active = useQuery(
    api.workspaces.getActiveWorkspace,
    isAuthenticated ? {} : "skip",
  );

  if (!clerkLoaded || !isAuthenticated || active === undefined) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-8 p-6 lg:p-8">
        <div className="space-y-2.5">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[1fr_minmax(320px,440px)]">
          <Skeleton className="h-[600px] w-full rounded-2xl" />
          <Skeleton className="h-[600px] w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto w-full max-w-2xl p-6 lg:p-8">
        <div className="flex flex-col items-center rounded-2xl border bg-card px-6 py-16 text-center shadow-card">
          <div className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
            <Lock className="size-6" />
          </div>
          <h2 className="mt-5 text-lg font-medium tracking-tight">Admins only</h2>
          <p className="text-muted-foreground mt-2 max-w-sm text-sm leading-relaxed">
            Only organization admins can customize the widget. Ask an admin on
            your team to update its appearance and behaviour.
          </p>
        </div>
      </div>
    );
  }

  if (!active.ok) {
    return (
      <div className="mx-auto w-full max-w-2xl p-6 lg:p-8">
        <div className="flex flex-col items-center rounded-2xl border bg-card px-6 py-16 text-center shadow-card">
          <div className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
            <Palette className="size-6" />
          </div>
          <h2 className="mt-5 text-lg font-medium tracking-tight">
            Workspace not ready
          </h2>
          <p className="text-muted-foreground mt-2 max-w-sm text-sm leading-relaxed">
            We couldn&apos;t resolve your workspace. Reload in a moment.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 p-6 lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="bg-brand/10 text-brand flex size-11 shrink-0 items-center justify-center rounded-xl">
            <Palette className="size-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Customizer</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Style your widget&apos;s colors, copy, and behaviour — no code.
            </p>
          </div>
        </div>
      </div>

      <CustomizerEditor workspaceId={active.workspace._id} />
    </div>
  );
}
