"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { OrganizationProfile } from "@clerk/nextjs";
import { ShieldAlert, ShieldCheck, UserRound, UsersRound } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { initials } from "../_components/inbox/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 TEAM page. Members management.
//
// Admins get Clerk's full <OrganizationProfile/> (members + invitations + roles)
// embedded in the shadcn shell, plus the Convex-mirrored roster for parity.
// Non-admins see a READ-ONLY roster (no management UI) — the hard role boundary
// is also enforced server-side (member mutations are admin-gated in Convex).
// ─────────────────────────────────────────────────────────────────────────────
export default function TeamPage() {
  const { isAuthenticated } = useConvexAuth();
  const active = useQuery(
    api.workspaces.getActiveWorkspace,
    isAuthenticated ? {} : "skip",
  );

  if (active === undefined) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-8 p-6 lg:p-8">
        <div className="flex items-center gap-4">
          <Skeleton className="size-12 rounded-2xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    );
  }

  const isAdmin = active.ok && active.role === "admin";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 p-6 lg:p-8">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="bg-brand/10 text-brand flex size-12 items-center justify-center rounded-2xl">
            <UsersRound className="size-6" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {isAdmin
                ? "Invite teammates, manage roles, and review your roster."
                : "The people you collaborate with in this workspace."}
            </p>
          </div>
        </div>
        {isAdmin ? (
          <Badge
            variant="outline"
            className="border-brand/20 bg-brand/5 text-brand h-7 gap-1.5 px-3"
          >
            <ShieldCheck className="size-3.5" />
            Admin
          </Badge>
        ) : (
          <Badge variant="secondary" className="h-7 gap-1.5 px-3">
            <UserRound className="size-3.5" />
            Member
          </Badge>
        )}
      </div>

      <TeamRoster />

      {isAdmin ? (
        <section className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight">
              Members &amp; invitations
            </h2>
            <p className="text-muted-foreground text-sm">
              Manage who has access and what they can do.
            </p>
          </div>
          <div className="bg-card shadow-card overflow-hidden rounded-2xl border">
            <div className="flex justify-center px-2 py-4 sm:px-4">
              <OrganizationProfile
                routing="hash"
                appearance={{
                  variables: {
                    colorPrimary: "#5746f0",
                    colorForeground: "#0a0918",
                    colorMutedForeground: "#6b7280",
                    colorBackground: "transparent",
                    borderRadius: "0.75rem",
                    fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
                  },
                  elements: {
                    rootBox: "w-full",
                    cardBox: "w-full shadow-none border-none bg-transparent",
                    navbar: "hidden",
                    pageScrollBox: "p-0",
                    formButtonPrimary:
                      "bg-gradient-to-br from-[#5746f0] to-[#9b6bff] text-white shadow-[0_8px_24px_-8px_#5746f0] hover:opacity-95 normal-case",
                    badge: "rounded-full",
                  },
                }}
              />
            </div>
          </div>
        </section>
      ) : (
        <div className="bg-muted/40 flex items-start gap-3 rounded-2xl border p-5">
          <div className="bg-background text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-xl border">
            <ShieldAlert className="size-4.5" />
          </div>
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Admins only</p>
            <p className="text-muted-foreground text-sm">
              Inviting teammates and changing roles requires an admin. Ask a
              workspace admin if you need access changes.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Convex-mirrored roster (webhook-synced). Renders for both roles.
function TeamRoster() {
  const members = useQuery(api.inbox.listMembers, {});

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight">Roster</h2>
          <p className="text-muted-foreground text-sm">
            {members === undefined
              ? "Loading your workspace teammates…"
              : `${members.length} active member${members.length === 1 ? "" : "s"} in this workspace.`}
          </p>
        </div>
      </div>

      {members === undefined ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-card flex items-center gap-3 rounded-2xl border p-4"
            >
              <Skeleton className="size-11 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      ) : members.length === 0 ? (
        <div className="bg-card shadow-card flex flex-col items-center justify-center rounded-2xl border px-6 py-16 text-center">
          <div className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
            <UsersRound className="size-7" />
          </div>
          <h3 className="mt-5 text-base font-medium">No teammates yet</h3>
          <p className="text-muted-foreground mt-1.5 max-w-sm text-sm">
            Members appear here automatically as they join your workspace. Invite
            your team to start collaborating.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {members.map((m) => (
            <li
              key={m.clerkUserId}
              className="group bg-card hover:border-brand/30 hover:shadow-card flex items-center gap-3.5 rounded-2xl border p-4 transition-all"
            >
              <Avatar className="size-11">
                {m.avatarUrl ? <AvatarImage src={m.avatarUrl} /> : null}
                <AvatarFallback className="text-sm font-medium">
                  {initials(m.name)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                  <span className="truncate">{m.name}</span>
                  {m.isSelf ? (
                    <span className="text-muted-foreground bg-muted shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                      You
                    </span>
                  ) : null}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs capitalize">
                  {m.role === "admin" ? "Administrator" : "Support agent"}
                </p>
              </div>
              <Badge
                variant={m.role === "admin" ? "default" : "secondary"}
                className={
                  m.role === "admin"
                    ? "bg-brand/10 text-brand gap-1 capitalize"
                    : "gap-1 capitalize"
                }
              >
                {m.role === "admin" ? (
                  <ShieldCheck className="size-3" />
                ) : (
                  <UserRound className="size-3" />
                )}
                {m.role}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
