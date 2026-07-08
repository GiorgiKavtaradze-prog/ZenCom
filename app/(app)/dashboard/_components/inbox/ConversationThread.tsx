"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Bot, ExternalLink, Send, Sparkles } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { renderMarkdown } from "@/lib/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ThreadHeader } from "./ThreadHeader";
import { relativeTime } from "./utils";
import { usePresence, type RosterEntry } from "./usePresence";

type Message = Doc<"messages">;

// Markdown bubble styling. Colors are inherited from the surrounding bubble so
// the same prose works on the light AI bubble and the solid human-agent bubble.
const MARKDOWN_PROSE = cn(
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-1.5 [&_strong]:font-semibold [&_em]:italic",
  "[&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5",
  "[&_:where(h1,h2,h3,h4)]:my-1.5 [&_:where(h1,h2,h3,h4)]:font-semibold",
  "[&_h1]:text-base [&_h2]:text-[15px] [&_h3]:text-sm",
  "[&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]",
  "[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/10 [&_pre]:p-2.5",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_hr]:my-2 [&_hr]:border-current/20",
);

function Citations({ citations }: { citations: Message["citations"] }) {
  if (!citations || citations.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-brand/15 pt-2.5">
      {citations.map((c, i) => {
        const label = c.title ?? c.url ?? "Source";
        const chip = (
          <Badge
            variant="outline"
            className="h-5 max-w-48 gap-1 border-brand/20 bg-card px-1.5 text-[10px] font-medium text-brand transition-colors hover:bg-brand/10"
          >
            <ExternalLink className="size-2.5 shrink-0" />
            <span className="truncate">{label}</span>
          </Badge>
        );
        return c.url ? (
          <a
            key={i}
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className="no-underline"
          >
            {chip}
          </a>
        ) : (
          <span key={i}>{chip}</span>
        );
      })}
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  // System messages render as centered, muted pills.
  if (message.author === "system") {
    return (
      <div className="my-1.5 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
          {message.body}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  const isAgent = message.author === "agent";
  const isAi = isAgent && message.isAi;

  return (
    <div
      className={cn(
        "group/msg flex flex-col gap-1",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "max-w-[78%] px-4 py-2.5 text-sm leading-relaxed shadow-soft",
          isAgent
            ? isAi
              ? "rounded-2xl rounded-br-md border border-brand/20 bg-brand/5 text-foreground"
              : "rounded-2xl rounded-br-md bg-gradient-to-br from-brand to-brand-2 text-white shadow-[0_8px_24px_-12px_var(--brand)]"
            : "rounded-2xl rounded-bl-md border border-border bg-card text-foreground",
        )}
      >
        {isAi ? (
          <span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
            <Sparkles className="size-3" />
            AI assistant
          </span>
        ) : null}
        {isAgent ? (
          <div
            className={cn("break-words", MARKDOWN_PROSE)}
            // Message bodies are HTML-escaped inside renderMarkdown before a
            // limited tag set is re-introduced, so agent/AI output can't inject
            // executable markup.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.body) }}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        )}
        {isAi ? <Citations citations={message.citations} /> : null}
      </div>
      <span className="px-1 text-[10px] tabular-nums text-muted-foreground/60 opacity-0 transition-opacity group-hover/msg:opacity-100">
        {relativeTime(message._creationTime)}
      </span>
    </div>
  );
}

function Composer({
  conversationId,
  isAiMode,
  onTypingChange,
}: {
  conversationId: Id<"conversations">;
  isAiMode: boolean;
  onTypingChange: (typing: boolean) => void;
}) {
  const send = useMutation(api.messages.sendFromAgent);
  const takeOver = useMutation(api.inbox.takeOver);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    onTypingChange(false);
    try {
      // Replying while the AI owns the chat implies the human is stepping in;
      // take over first so the visitor's next message doesn't trigger the bot.
      if (isAiMode) {
        await takeOver({ conversationId });
      }
      await send({ conversationId, body });
      setText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-border bg-card px-4 py-3.5">
      {isAiMode ? (
        <div className="mb-2.5 flex items-center gap-2 rounded-lg border border-brand/20 bg-brand/5 px-3 py-2 text-[11px] font-medium text-brand">
          <Bot className="size-3.5 shrink-0" />
          The AI is handling this chat — replying will take it over.
        </div>
      ) : null}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-background p-2 shadow-soft transition-colors focus-within:border-brand/40 focus-within:ring-2 focus-within:ring-brand/10">
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onTypingChange(e.target.value.trim().length > 0);
          }}
          onBlur={() => onTypingChange(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Reply to the visitor…  (Enter to send, Shift+Enter for newline)"
          rows={2}
          className="max-h-40 min-h-[40px] resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button
          size="icon"
          className="size-10 shrink-0 rounded-xl bg-gradient-to-br from-brand to-brand-2 text-white shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95 disabled:from-muted-foreground/40 disabled:to-muted-foreground/40 disabled:opacity-100 disabled:shadow-none"
          disabled={sending || text.trim().length === 0}
          onClick={() => void submit()}
          aria-label="Send reply"
        >
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function ConversationThread({
  conversationId,
  roster,
  onTypingChange,
}: {
  conversationId: Id<"conversations">;
  roster: RosterEntry[];
  onTypingChange: (typing: boolean) => void;
}) {
  const convo = useQuery(api.inbox.getConversation, { conversationId });
  const messages = useQuery(api.messages.list, { conversationId });
  const markRead = useMutation(api.inbox.markRead);
  const endRef = useRef<HTMLDivElement>(null);

  // Mark the conversation read whenever it's opened or new messages arrive.
  useEffect(() => {
    void markRead({ conversationId });
  }, [conversationId, messages?.length, markRead]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length]);

  if (convo === undefined) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="ml-auto h-8 w-24 rounded-md" />
        </div>
        <div className="flex-1 space-y-4 p-6">
          <Skeleton className="h-14 w-1/2 rounded-2xl" />
          <Skeleton className="ml-auto h-14 w-1/2 rounded-2xl" />
          <Skeleton className="h-14 w-2/5 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (convo === null) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="flex max-w-xs flex-col items-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Bot className="size-6" />
          </div>
          <p className="mt-4 text-sm font-medium text-foreground">
            Conversation unavailable
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            This conversation may have been removed or you no longer have access.
          </p>
        </div>
      </div>
    );
  }

  const isAiMode = convo.mode === "ai";

  return (
    <div className="flex h-full flex-col">
      <ThreadHeader convo={convo} roster={roster} />

      <ScrollArea className="min-h-0 flex-1 bg-muted/30">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6">
          {messages === undefined ? (
            <div className="space-y-4">
              <Skeleton className="h-14 w-1/2 rounded-2xl" />
              <Skeleton className="ml-auto h-14 w-1/2 rounded-2xl" />
              <Skeleton className="h-14 w-2/5 rounded-2xl" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Sparkles className="size-5" />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">
                No messages yet
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Start the conversation below.
              </p>
            </div>
          ) : (
            messages.map((m) => <MessageRow key={m._id} message={m} />)
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <Composer
        conversationId={conversationId}
        isAiMode={isAiMode}
        onTypingChange={onTypingChange}
      />
    </div>
  );
}

// Re-export so the page can pass presence down without importing the hook twice.
export { usePresence };
