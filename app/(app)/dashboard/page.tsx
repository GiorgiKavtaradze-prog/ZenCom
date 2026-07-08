"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Inbox as InboxIcon, Users } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ConversationList,
  type InboxFilter,
} from "./_components/inbox/ConversationList";
import { ConversationThread } from "./_components/inbox/ConversationThread";
import { usePresence } from "./_components/inbox/usePresence";
import { initials } from "./_components/inbox/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 INBOX — two-pane dashboard. Left: filterable conversation list. Right:
// the selected thread + composer. Everything is live via Convex `useQuery`.
//
// PRESENCE: a single `usePresence` heartbeat runs at the page level. It tracks
// which conversation the agent is viewing (`activeConversationId`) and whether
// they're typing (`typingConversationId`), broadcasting both to teammates. The
// resolved roster is passed down to the thread header ("who's viewing").
// ─────────────────────────────────────────────────────────────────────────────
export default function InboxPage() {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [activeId, setActiveId] = useState<Id<"conversations"> | null>(null);
  const [typing, setTyping] = useState(false);

  const { roster, onlineCount } = usePresence({
    activeConversationId: activeId,
    typingConversationId: typing ? activeId : null,
  });

  return (
    <div className="grid h-[calc(100svh-3.5rem)] grid-cols-1 bg-muted/30 md:grid-cols-[minmax(320px,380px)_1fr]">
      {/* Left pane — conversation list */}
      <div
        className={`bg-card flex min-h-0 min-w-0 flex-col border-r border-border ${
          activeId ? "hidden md:flex" : "flex"
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <InboxIcon className="size-4" />
            </span>
            <div className="leading-none">
              <h1 className="text-sm font-semibold tracking-tight">Inbox</h1>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Shared conversations
              </p>
            </div>
          </div>
          <OnlineRoster roster={roster} onlineCount={onlineCount} />
        </div>
        <div className="min-h-0 flex-1">
          <ConversationList
            filter={filter}
            onFilterChange={setFilter}
            activeId={activeId}
            onSelect={setActiveId}
          />
        </div>
      </div>

      {/* Right pane — thread */}
      <div
        className={`bg-background min-h-0 min-w-0 ${
          activeId ? "flex" : "hidden md:flex"
        } flex-col`}
      >
        {activeId ? (
          <ConversationThread
            key={activeId}
            conversationId={activeId}
            roster={roster}
            onTypingChange={setTyping}
          />
        ) : (
          <div className="grid h-full place-items-center p-8">
            <div className="flex max-w-sm flex-col items-center text-center">
              <div className="flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <InboxIcon className="size-7" />
              </div>
              <h2 className="mt-5 text-base font-medium text-foreground">
                No conversation selected
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Pick a conversation from the list to read the thread, reply, and
                hand off between your AI agent and the team.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Stacked avatars of teammates currently online in the workspace.
function OnlineRoster({
  roster,
  onlineCount,
}: {
  roster: ReturnType<typeof usePresence>["roster"];
  onlineCount: number;
}) {
  const online = roster.filter((r) => r.online);
  if (online.length === 0) {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
        <Users className="size-3.5" />
        No one online
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-2.5 shadow-soft">
          <span className="flex -space-x-2">
            {online.slice(0, 4).map((m) => (
              <Avatar
                key={m.clerkUserId}
                className="ring-card size-6 ring-2"
              >
                {m.avatarUrl ? <AvatarImage src={m.avatarUrl} /> : null}
                <AvatarFallback className="bg-brand/10 text-[9px] font-medium text-brand">
                  {initials(m.name)}
                </AvatarFallback>
              </Avatar>
            ))}
          </span>
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {onlineCount} teammate{onlineCount === 1 ? "" : "s"} online
      </TooltipContent>
    </Tooltip>
  );
}
