"use client";

import { Bot, ChevronRight, MessageSquarePlus, User } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";

// Compact relative time ("now", "5m", "3h", "2d", else a short date).
function relativeTime(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The widget's chat "home": a list of the visitor's past conversations plus a
// prominent "Send us a message" button to start a new one. Selecting a row opens
// that thread; the button starts a fresh chat. Data comes from
// conversations.listForVisitor (newest first, message-less drafts omitted).
// ─────────────────────────────────────────────────────────────────────────────

type ConversationRow = {
  _id: Id<"conversations">;
  lastMessageAt: number;
  status: "open" | "closed";
  mode: "ai" | "human";
  preview: string;
  lastAuthor: "visitor" | "agent" | "system";
};

type Props = {
  conversations: ConversationRow[] | undefined;
  onOpen: (id: Id<"conversations">) => void;
  onNew: () => void;
};

export function ConversationList({ conversations, onOpen, onNew }: Props) {
  const loading = conversations === undefined;
  const isEmpty = !loading && conversations.length === 0;

  return (
    <div className="flex h-full flex-col bg-[#fafafb]">
      <div className="flex-1 overflow-y-auto px-3.5 py-4">
        {loading ? (
          <ListLoading />
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <span className="mb-4 grid size-14 place-items-center rounded-2xl bg-[var(--wc-theme)] text-white shadow-sm">
              <Bot className="size-7" />
            </span>
            <p className="text-base font-semibold tracking-tight text-neutral-800">
              How can we help?
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-400">
              Start a conversation and we&apos;ll get right back to you.
            </p>
          </div>
        ) : (
          <>
            <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              Recent conversations
            </p>
            <ul className="space-y-2">
              {conversations.map((c) => (
                <li key={c._id}>
                  <button
                    type="button"
                    onClick={() => onOpen(c._id)}
                    className="group flex w-full items-center gap-3 rounded-2xl bg-white px-3.5 py-3 text-left shadow-sm ring-1 ring-black/5 transition hover:shadow-md hover:ring-black/10"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--wc-theme)]/10 text-[var(--wc-theme)]">
                      {c.lastAuthor === "visitor" ? (
                        <User className="size-4" />
                      ) : (
                        <Bot className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold tracking-tight text-neutral-800">
                          {c.lastAuthor === "visitor" ? "You" : "Support"}
                        </span>
                        <span className="shrink-0 text-[11px] font-medium text-neutral-400">
                          {relativeTime(c.lastMessageAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5">
                        <span className="truncate text-[13px] text-neutral-500">
                          {c.preview || "No messages yet"}
                        </span>
                        {c.status === "closed" ? (
                          <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
                            Closed
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
                            Open
                          </span>
                        )}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-neutral-300 transition group-hover:translate-x-0.5 group-hover:text-neutral-500" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="border-t border-neutral-100 bg-white p-3">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-95"
          style={{ background: "var(--wc-button)" }}
        >
          <MessageSquarePlus className="size-4" />
          Send us a message
        </button>
      </div>
    </div>
  );
}

function ListLoading() {
  return (
    <ul className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-2xl bg-white px-3.5 py-3 ring-1 ring-black/5"
        >
          <span className="size-10 shrink-0 animate-pulse rounded-xl bg-neutral-100" />
          <span className="min-w-0 flex-1 space-y-2">
            <span className="block h-3 w-24 animate-pulse rounded bg-neutral-100" />
            <span className="block h-3 w-40 animate-pulse rounded bg-neutral-100" />
          </span>
        </li>
      ))}
    </ul>
  );
}
