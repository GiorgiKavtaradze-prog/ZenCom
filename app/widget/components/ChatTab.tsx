"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAgentStream } from "../lib/useAgentStream";
import { renderMarkdown } from "@/lib/markdown";
import {
  Bot,
  Send,
  Sparkles,
  ExternalLink,
  FileText,
  ArrowUpRight,
  Zap,
} from "lucide-react";

type Props = {
  conversationId: Id<"conversations"> | null;
  proactiveText: string | null;
  onNewAgentMessage?: () => void;
  // Open an internal helpdesk article (by slug) inside the widget.
  onOpenArticle?: (slug: string) => void;
  // Open the help center pre-filled with a search query — used for suggested
  // chips that have a title but no direct article slug.
  onSearchHelp?: (query: string) => void;
  // For a brand-new chat (conversationId === null), lazily create the
  // conversation on first send and return its id (or null on failure).
  onEnsureConversation?: () => Promise<Id<"conversations"> | null>;
  // The anonymous visitor's minted id — required to authorize reads/writes
  // against this conversation (owned by the widget in localStorage).
  visitorId: string | null;
};

// Citation URLs from the agent are either internal helpdesk article paths
// (`/articles/<slug>` or `/help/<slug>`) or real external source URLs. Internal
// paths have no standalone route — they must open inside the widget's Helpdesk
// tab — so we detect them and extract the slug.
function articleSlugFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/^\/(?:articles|help)\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

type Citation = {
  chunkId?: Id<"knowledgeChunks">;
  title?: string;
  url?: string;
};

export function ChatTab({
  conversationId,
  proactiveText,
  onNewAgentMessage,
  onOpenArticle,
  onSearchHelp,
  onEnsureConversation,
  visitorId,
}: Props) {
  const messages = useQuery(
    api.messages.list,
    conversationId && visitorId ? { conversationId, visitorId } : "skip",
  );
  const send = useMutation(api.messages.sendFromVisitor);

  // Live token stream overlay (Phase 4). `streaming` carries in-flight assistant
  // UIMessages with accumulated `.text` + a "streaming" status.
  const streaming = useAgentStream(conversationId, visitorId);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // A "pending" agent row (empty body + pending:true) means the agent run was
  // scheduled but no tokens have streamed yet → show a typing indicator. Once
  // tokens stream we render the streaming overlay instead.
  const pendingAgentRow = useMemo(
    () => messages?.find((m) => m.author === "agent" && m.pending && !m.body),
    [messages],
  );

  // Suggested-article chips are conversation starters — only show them under the
  // FIRST agent message (the welcome), not stacked under every later reply.
  const firstAgentMessageId = useMemo(
    () => messages?.find((m) => m.author === "agent")?._id ?? null,
    [messages],
  );

  // Text of the stream that is *actively* generating right now (status
  // "streaming"). Finished streams are excluded so a previous reply's stream can
  // never reappear once it has settled.
  const streamingText = useMemo(() => {
    if (!streaming) return null;
    const live = streaming
      .filter((s) => s.status === "streaming" && s.text && s.text.length > 0)
      .at(-1);
    return live?.text ?? null;
  }, [streaming]);

  // The overlay is bound to the pending placeholder row for the in-flight reply.
  // Once run.ts finalizes that row (pending cleared + body set), the placeholder
  // disappears and the settled `messages` row becomes the single source of truth
  // — so we drop the overlay. This prevents the "message → chips → message again"
  // duplicate (a lingering stream rendered alongside the settled bubble) and
  // stops a finished stream from bleeding into the next reply.
  const pendingRowId = pendingAgentRow?._id ?? null;
  const [overlay, setOverlay] = useState<{
    rowId: string;
    text: string;
  } | null>(null);
  useEffect(() => {
    if (!pendingRowId) {
      setOverlay(null);
      return;
    }
    if (streamingText) {
      setOverlay({ rowId: pendingRowId, text: streamingText });
    } else {
      // No live tokens this tick: keep the last text for THIS reply (bridges the
      // brief gap between the stream finishing and the row finalizing), but never
      // show text carried over from a previous reply.
      setOverlay((prev) => (prev && prev.rowId === pendingRowId ? prev : null));
    }
  }, [pendingRowId, streamingText]);

  const overlayStream = overlay ? { text: overlay.text } : null;

  // Typing indicator: a reply is pending but no streamed text is showing yet.
  const showTyping = Boolean(pendingAgentRow) && !overlayStream;

  // Notify host (loader.js) of a brand-new settled agent message so it can play
  // the notification sound / bump the unread badge when collapsed.
  const lastAgentMsgIdRef = useRef<string | null>(null);
  const seededRef = useRef(false);
  useEffect(() => {
    if (!messages) return;
    const lastAgent = [...messages]
      .reverse()
      .find((m) => m.author === "agent" && !m.pending && m.body);
    // Seed on first load so existing history doesn't fire a notification.
    if (!seededRef.current) {
      seededRef.current = true;
      lastAgentMsgIdRef.current = lastAgent?._id ?? null;
      return;
    }
    if (lastAgent && lastAgent._id !== lastAgentMsgIdRef.current) {
      lastAgentMsgIdRef.current = lastAgent._id;
      onNewAgentMessage?.();
    }
  }, [messages, onNewAgentMessage]);

  // Autoscroll on new content (settled, streaming, or typing).
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, overlayStream?.text, showTyping]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setText("");
    setError(null);
    setSending(true);
    try {
      // For a new chat the conversation doesn't exist yet — create it on the
      // first send, then post into it.
      const cid = conversationId ?? (await onEnsureConversation?.()) ?? null;
      if (!cid) {
        setError("Couldn't start the conversation. Please try again.");
        setText(body);
        return;
      }
      if (!visitorId) {
        setError("Couldn't send your message. Please refresh and try again.");
        setText(body);
        return;
      }
      await send({ conversationId: cid, visitorId, body });
    } catch (err) {
      // Surface rate-limit / validation errors as a soft inline notice.
      const code = (err as { data?: { code?: string } })?.data?.code ?? "ERROR";
      setError(
        code === "RateLimitError" || code === "widgetMessage"
          ? "You're sending messages too quickly — please wait a moment."
          : "Couldn't send your message. Please try again.",
      );
      setText(body); // restore so the visitor doesn't lose their text
    } finally {
      setSending(false);
    }
  }

  // A brand-new chat (no conversationId yet) is "ready" immediately as an empty
  // thread — the visitor can type and the conversation is created on first send.
  const isNewChat = !conversationId;
  const ready = isNewChat || messages !== undefined;
  const isEmpty =
    isNewChat || (messages !== undefined && messages.length === 0);

  return (
    <div className="flex h-full flex-col bg-[#fafafb]">
      <div className="flex-1 space-y-1 overflow-y-auto px-3.5 py-4">
        {/* Greeting / proactive nudge */}
        {proactiveText ? (
          <div className="mb-4 flex items-end gap-2">
            <span className="mb-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--wc-theme)] text-white">
              <Sparkles className="size-3.5" />
            </span>
            <div className="max-w-[82%] rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-neutral-700 shadow-sm ring-1 ring-black/5">
              {proactiveText}
            </div>
          </div>
        ) : null}

        {!ready ? (
          <ChatLoading />
        ) : isEmpty && !proactiveText ? (
          <div className="flex flex-col items-center px-6 pt-10 text-center">
            <span className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-[var(--wc-theme)]/10 text-[var(--wc-theme)]">
              <Sparkles className="size-5" />
            </span>
            <p className="text-sm font-medium text-neutral-700">
              How can we help?
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
              Send us a message and we&apos;ll get right back to you.
            </p>
          </div>
        ) : null}

        {messages?.map((m) => {
          if (m.author === "agent" && m.pending && !m.body) return null; // typing row
          return (
            <MessageBubble
              key={m._id}
              message={m}
              onOpenArticle={onOpenArticle}
              onSearchHelp={onSearchHelp}
              showCitations={m._id === firstAgentMessageId}
            />
          );
        })}

        {/* Live streaming overlay (token-by-token) */}
        {overlayStream ? <StreamingBubble text={overlayStream.text} /> : null}

        {/* Typing indicator while the agent is preparing a reply */}
        {showTyping ? <TypingIndicator /> : null}

        <div ref={endRef} />
      </div>

      {error ? (
        <p className="px-3.5 pb-1 pt-1 text-center text-xs font-medium text-rose-500">
          {error}
        </p>
      ) : null}

      <form
        onSubmit={submit}
        className="flex items-end gap-2 border-t border-neutral-100 bg-white p-3"
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit(e as unknown as React.FormEvent);
            }
          }}
          rows={1}
          placeholder="Type your message…"
          aria-label="Type your message"
          disabled={!ready}
          className="max-h-28 min-h-[42px] flex-1 resize-none rounded-2xl border border-neutral-200 bg-neutral-50 px-3.5 py-2.5 text-sm leading-relaxed outline-none transition placeholder:text-neutral-400 focus:border-transparent focus:bg-white focus:ring-2 focus:ring-[var(--wc-button)]/30 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!text.trim() || !ready || sending}
          aria-label="Send message"
          className="flex size-[42px] shrink-0 items-center justify-center rounded-2xl text-white shadow-sm transition hover:opacity-95 disabled:opacity-40"
          style={{ background: "var(--wc-button)" }}
        >
          <Send className="size-4" />
        </button>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  onOpenArticle,
  onSearchHelp,
  showCitations = true,
}: {
  message: Doc<"messages">;
  onOpenArticle?: (slug: string) => void;
  onSearchHelp?: (query: string) => void;
  showCitations?: boolean;
}) {
  const isVisitor = message.author === "visitor";
  const isAi = message.author === "agent" && message.isAi;
  const citations = showCitations
    ? ((message.citations ?? []) as Citation[])
    : [];

  if (message.author === "system") {
    return (
      <div className="flex justify-center py-2">
        <span className="rounded-full bg-neutral-200/70 px-3 py-1 text-[11px] font-medium text-neutral-500">
          {message.body}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`mb-3 flex flex-col ${isVisitor ? "items-end" : "items-start"}`}
    >
      {!isVisitor ? (
        <span className="mb-1 ml-1 flex items-center gap-1.5 text-[11px] font-medium text-neutral-400">
          {isAi ? (
            <>
              <span className="flex size-4 items-center justify-center rounded-full bg-[var(--wc-theme)]/10 text-[var(--wc-theme)]">
                <Bot className="size-2.5" />
              </span>
              AI Assistant
            </>
          ) : (
            "Support"
          )}
        </span>
      ) : null}
      {isVisitor ? (
        <div
          className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13px] leading-relaxed text-white shadow-sm"
          style={{ background: "var(--wc-button)" }}
        >
          {message.body}
        </div>
      ) : (
        <div
          className="wc-prose max-w-[82%] break-words rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-neutral-800 shadow-sm ring-1 ring-black/5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          // Markdown is HTML-escaped in renderMarkdown before re-introducing a
          // limited tag set, so agent output can't inject executable markup.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.body) }}
        />
      )}
      {citations.length > 0 ? (
        <div className="ml-1 mt-2 flex max-w-[85%] flex-col gap-1.5">
          {citations.map((c, i) => (
            <CitationChip
              key={c.chunkId ?? c.url ?? i}
              citation={c}
              onOpenArticle={onOpenArticle}
              onSearchHelp={onSearchHelp}
            />
          ))}
        </div>
      ) : null}
      {message.upgradeCard ? <UpgradeCard card={message.upgradeCard} /> : null}
    </div>
  );
}

// Rich "widget" card the agent attaches via the send_upgrade_link tool. Renders
// an upgrade CTA that opens the billing page in a new tab (relative URLs resolve
// to the app origin the widget iframe is served from).
function UpgradeCard({
  card,
}: {
  card: NonNullable<Doc<"messages">["upgradeCard"]>;
}) {
  return (
    <div className="ml-1 mt-2 w-full max-w-[85%] overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-[var(--wc-button)]/20">
      <div className="flex items-start gap-3 p-3.5">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--wc-button)]/10 text-[var(--wc-button)]">
          <Zap className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight text-neutral-900">
            {card.title}
          </p>
          <p className="mt-0.5 text-[13px] leading-snug text-neutral-500">
            {card.description}
          </p>
        </div>
      </div>
      <a
        href={card.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-1.5 px-3.5 py-3 text-[13px] font-semibold text-white transition hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wc-button)]/40"
        style={{ background: "var(--wc-button)" }}
      >
        {card.ctaLabel}
        <ArrowUpRight className="size-3.5" />
      </a>
    </div>
  );
}

function CitationChip({
  citation,
  onOpenArticle,
  onSearchHelp,
}: {
  citation: Citation;
  onOpenArticle?: (slug: string) => void;
  onSearchHelp?: (query: string) => void;
}) {
  const label = citation.title ?? "Source";
  const slug = articleSlugFromUrl(citation.url);
  const isExternal = !slug && /^https?:\/\//.test(citation.url ?? "");

  const chipClass =
    "group inline-flex w-full items-center gap-2 rounded-xl bg-[var(--wc-button)]/[0.08] px-2.5 py-2 text-left text-[13px] font-medium text-[var(--wc-button)] ring-1 ring-inset ring-[var(--wc-button)]/20 transition hover:bg-[var(--wc-button)]/[0.14] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wc-button)]/40";

  const inner = (icon: React.ReactNode) => (
    <>
      <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-[var(--wc-button)]/15">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </>
  );

  // Internal helpdesk article → open inside the widget's Help tab.
  if (slug && onOpenArticle) {
    return (
      <button
        type="button"
        onClick={() => onOpenArticle(slug)}
        className={chipClass}
      >
        {inner(<FileText className="size-3.5" />)}
      </button>
    );
  }

  // Real external source URL → open in a new tab.
  if (isExternal && citation.url) {
    return (
      <a
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        className={chipClass}
      >
        {inner(<ExternalLink className="size-3.5" />)}
      </a>
    );
  }

  // No direct article link (e.g. a knowledge-base citation with only a title) →
  // search the help center for that title so the chip is still actionable.
  if (onSearchHelp && citation.title) {
    return (
      <button
        type="button"
        onClick={() => onSearchHelp(citation.title!)}
        className={chipClass}
      >
        {inner(<FileText className="size-3.5" />)}
      </button>
    );
  }

  // No usable destination → show as a static, readable reference.
  return (
    <span className={chipClass.replace("hover:bg-[var(--wc-button)]/[0.14]", "")}>
      {inner(<FileText className="size-3.5" />)}
    </span>
  );
}

function AgentLabel() {
  return (
    <span className="mb-1 ml-1 flex items-center gap-1.5 text-[11px] font-medium text-neutral-400">
      <span className="flex size-4 items-center justify-center rounded-full bg-[var(--wc-theme)]/10 text-[var(--wc-theme)]">
        <Bot className="size-2.5" />
      </span>
      AI Assistant
    </span>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="mb-3 flex flex-col items-start">
      <AgentLabel />
      <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-neutral-800 shadow-sm ring-1 ring-black/5">
        {text}
        <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-[var(--wc-theme)] align-middle" />
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="mb-3 flex flex-col items-start">
      <AgentLabel />
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-white px-4 py-3 shadow-sm ring-1 ring-black/5">
        <Dot delay="0ms" />
        <Dot delay="150ms" />
        <Dot delay="300ms" />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-1.5 animate-bounce rounded-full bg-[var(--wc-theme)]/60"
      style={{ animationDelay: delay }}
    />
  );
}

function ChatLoading() {
  return (
    <div className="space-y-3">
      <div className="flex justify-start">
        <div className="h-10 w-44 animate-pulse rounded-2xl rounded-bl-md bg-white ring-1 ring-black/5" />
      </div>
      <div className="flex justify-end">
        <div className="h-10 w-32 animate-pulse rounded-2xl rounded-br-md bg-neutral-200/80" />
      </div>
      <div className="flex justify-start">
        <div className="h-16 w-56 animate-pulse rounded-2xl rounded-bl-md bg-white ring-1 ring-black/5" />
      </div>
    </div>
  );
}
