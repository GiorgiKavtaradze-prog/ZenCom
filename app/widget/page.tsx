"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  appearanceVars,
  loadOrMint,
  VISITOR_ID_KEY,
  VISITOR_NAME_KEY,
} from "./lib/widget-utils";
import { WidgetHeader } from "./components/WidgetHeader";
import { ChatTab } from "./components/ChatTab";
import { ConversationList } from "./components/ConversationList";
import { HelpdeskTab } from "./components/HelpdeskTab";
import { LeadCaptureForm } from "./components/LeadCaptureForm";
import { ArrowLeft, MessageSquare, LifeBuoy } from "lucide-react";

type Tab = "chat" | "helpdesk";
// Within the chat tab: the conversation-history home vs an open thread.
type ChatView = "list" | "thread";

export default function WidgetPage() {
  const [appId, setAppId] = useState<Id<"workspaces"> | null>(null);
  const [visitorId, setVisitorId] = useState<string | null>(null);
  const [visitorName, setVisitorName] = useState<string | null>(null);
  const [conversationId, setConversationId] =
    useState<Id<"conversations"> | null>(null);

  const [tab, setTab] = useState<Tab>("chat");
  // Chat tab starts on the conversation-history home; opening/starting a chat
  // switches to the thread view.
  const [chatView, setChatView] = useState<ChatView>("list");
  const [leadCaptured, setLeadCaptured] = useState(false);
  const [proactiveText, setProactiveText] = useState<string | null>(null);
  // Article / search requested from a chat citation chip — opens the Help view.
  const [articleSlug, setArticleSlug] = useState<string | null>(null);
  const [helpSearch, setHelpSearch] = useState<string | null>(null);

  const createConversation = useMutation(api.conversations.createForVisitor);

  // Read app_id from the iframe URL + load/mint the anonymous visitor identity.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("app_id");
    if (id) setAppId(id as Id<"workspaces">);

    setVisitorId(
      loadOrMint(
        VISITOR_ID_KEY,
        () => "v_" + Math.random().toString(36).slice(2),
      ),
    );
    setVisitorName(
      loadOrMint(
        VISITOR_NAME_KEY,
        () => "Visitor " + Math.floor(1000 + Math.random() * 9000),
      ),
    );
  }, []);

  // Full widget config (appearance + behavior settings + workspace name).
  const config = useQuery(
    api.widget.getConfig,
    appId ? { workspaceId: appId } : "skip",
  );

  // Presence roster for the header (team avatars + online status).
  const roster = useQuery(
    api.presence.publicRoster,
    appId ? { workspaceId: appId } : "skip",
  );

  // This visitor's conversation history (newest first) for the chat-home list.
  const conversations = useQuery(
    api.conversations.listForVisitor,
    appId && visitorId ? { workspaceId: appId, visitorId } : "skip",
  );

  // Seed lead-capture "already captured" from localStorage once we know the app.
  useEffect(() => {
    if (!appId) return;
    try {
      if (localStorage.getItem(`mychat_lead_${appId}`) === "1") {
        setLeadCaptured(true);
      }
    } catch {
      /* ignore */
    }
  }, [appId]);

  // Lazily create the conversation for a brand-new chat on first send (returns
  // the existing selected thread when one is already open).
  const ensureConversation =
    useCallback(async (): Promise<Id<"conversations"> | null> => {
      if (conversationId) return conversationId;
      if (!appId || !visitorId || !visitorName) return null;
      try {
        const id = await createConversation({
          workspaceId: appId,
          visitorId,
          visitorName,
        });
        setConversationId(id);
        return id;
      } catch {
        return null;
      }
    }, [conversationId, appId, visitorId, visitorName, createConversation]);

  // Open an existing thread from the history list.
  const openConversation = useCallback((id: Id<"conversations">) => {
    setConversationId(id);
    setProactiveText(null);
    setChatView("thread");
    setTab("chat");
  }, []);

  // Start a brand-new chat (the conversation row is created on first send).
  const startNewChat = useCallback(() => {
    setConversationId(null);
    setProactiveText(null);
    setChatView("thread");
    setTab("chat");
  }, []);

  // Back from a thread to the conversation-history home.
  const backToConversations = useCallback(() => {
    setChatView("list");
    setConversationId(null);
    setProactiveText(null);
  }, []);

  const closeWidget = useCallback(() => {
    window.parent.postMessage({ type: "mychat:close" }, "*");
  }, []);

  // Hand the host (loader.js) the authoritative proactive config so IT can run
  // the host-side dwell timer with the real `delaySeconds`. The iframe owns the
  // single source of truth (widget.getConfig); the loader owns the timing.
  useEffect(() => {
    if (!config) return;
    window.parent.postMessage(
      {
        type: "mychat:configure",
        proactive: {
          enabled: config.settings.proactiveMessage.enabled,
          delaySeconds: config.settings.proactiveMessage.delaySeconds,
        },
      },
      "*",
    );
  }, [config]);

  // ── Host → iframe messages (proactive nudge) ────────────────────────────────
  // loader.js runs a host-side dwell timer and posts 'mychat:proactive' after
  // settings.proactiveMessage.delaySeconds. We surface the configured text as a
  // greeting bubble in the chat tab and switch to it.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Origin check: the widget is embedded by an arbitrary customer page, so we
      // can't hardcode a single trusted origin — but we CAN require the message to
      // come from the embedding page (the referrer's origin). This stops foreign
      // frames from forcing tab switches / proactive nudges. (If the referrer is
      // unavailable we fall through, but the text below is never host-controlled.)
      const expectedOrigin = (() => {
        try {
          return document.referrer ? new URL(document.referrer).origin : null;
        } catch {
          return null;
        }
      })();
      if (expectedOrigin && e.origin !== expectedOrigin) return;

      const data = e.data as { type?: string } | null;
      if (!data || typeof data.type !== "string") return;
      if (!data.type.startsWith("mychat:")) return;

      if (data.type === "mychat:proactive") {
        // Never trust host-supplied text — the iframe holds the authoritative
        // config, so the greeting always comes from settings. This prevents a
        // foreign frame from injecting spoofed "support" copy into the widget.
        const text = config?.settings.proactiveMessage.text ?? null;
        if (text) {
          setProactiveText(text);
          setTab("chat");
          // Surface the greeting inside a thread (a fresh chat if none is open).
          setChatView("thread");
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [config?.settings.proactiveMessage.text]);

  // Tell the host a new agent message arrived (sound + unread badge handled by
  // loader.js, which is gated on a user gesture for autoplay).
  const onNewAgentMessage = useCallback(() => {
    window.parent.postMessage({ type: "mychat:agent-message" }, "*");
  }, []);

  // A suggested-article chip was clicked in the chat tab: switch to the Help view
  // and open that article (HelpdeskTab consumes the slug).
  const openArticle = useCallback((slug: string) => {
    setHelpSearch(null);
    setArticleSlug(slug);
    setTab("helpdesk");
  }, []);

  // A suggested chip with no direct article link: open the Help view and run its
  // title as a search query.
  const searchHelp = useCallback((query: string) => {
    setArticleSlug(null);
    setHelpSearch(query);
    setTab("helpdesk");
  }, []);

  // Return to the chat from an ad-hoc Help view (when the Help tab is hidden).
  const exitHelp = useCallback(() => {
    setArticleSlug(null);
    setHelpSearch(null);
    setTab("chat");
  }, []);

  const style = useMemo(
    () => (config ? appearanceVars(config.appearance) : undefined),
    [config],
  );

  // Invalid app_id (workspace doesn't resolve).
  if (appId && config === null) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-white p-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-neutral-100 text-neutral-400">
          <MessageSquare className="size-5" />
        </span>
        <p className="text-sm font-medium text-neutral-600">
          This chat widget isn&apos;t configured correctly.
        </p>
      </div>
    );
  }

  const leadGateActive = config?.settings.leadCapture.enabled && !leadCaptured;
  const faqEnabled = config?.settings.faqEnabled ?? true;

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-white font-sans antialiased"
      style={style}
    >
      <WidgetHeader
        title={config?.appearance.title ?? "Chat with us"}
        logoUrl={config?.appearance.logoUrl ?? null}
        roster={roster}
        onClose={closeWidget}
      />

      {/* Tab bar — only show Helpdesk when faqEnabled */}
      {faqEnabled ? (
        <nav className="flex gap-1 border-b border-neutral-100 bg-white px-2 pt-1.5">
          <TabButton
            active={tab === "chat"}
            onClick={() => setTab("chat")}
            icon={<MessageSquare className="size-4" />}
            label="Chat"
          />
          <TabButton
            active={tab === "helpdesk"}
            onClick={() => setTab("helpdesk")}
            icon={<LifeBuoy className="size-4" />}
            label="Help"
          />
        </nav>
      ) : null}

      <div className="min-h-0 flex-1">
        {tab === "helpdesk" &&
        appId &&
        (faqEnabled || articleSlug || helpSearch) ? (
          <HelpdeskTab
            workspaceId={appId}
            requestedSlug={articleSlug}
            onArticleConsumed={() => setArticleSlug(null)}
            requestedSearch={helpSearch}
            onSearchConsumed={() => setHelpSearch(null)}
            faqEnabled={faqEnabled}
            onExit={exitHelp}
          />
        ) : chatView === "list" ? (
          <ConversationList
            conversations={conversations}
            onOpen={openConversation}
            onNew={startNewChat}
          />
        ) : (
          <div className="flex h-full flex-col">
            <button
              type="button"
              onClick={backToConversations}
              className="group flex shrink-0 items-center gap-1.5 border-b border-neutral-100 bg-white px-3.5 py-2.5 text-xs font-medium text-neutral-500 transition hover:text-neutral-900"
            >
              <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" />
              All conversations
            </button>
            <div className="min-h-0 flex-1">
              {leadGateActive && appId && visitorId ? (
                <LeadCaptureForm
                  workspaceId={appId}
                  visitorId={visitorId}
                  conversationId={conversationId}
                  requiredFields={config!.settings.leadCapture.requiredFields}
                  onCaptured={() => setLeadCaptured(true)}
                />
              ) : (
                <ChatTab
                  key={conversationId ?? "new"}
                  conversationId={conversationId}
                  visitorId={visitorId}
                  proactiveText={proactiveText}
                  onNewAgentMessage={onNewAgentMessage}
                  onOpenArticle={openArticle}
                  onSearchHelp={searchHelp}
                  onEnsureConversation={ensureConversation}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* "Powered by" footer — hidden when the workspace's plan removes branding
          (Pro/Scale). Only rendered once config has loaded (config === undefined
          while loading) to avoid a flash of branding on remove-branding plans. */}
      {config && !config.removeBranding ? <PoweredByFooter /> : null}
    </div>
  );
}

// Subtle, themed attribution. The accent color is driven by the same
// `--wc-button` appearance var the rest of the widget uses, so it stays on-brand
// without crowding the chat. Opens the marketing site in a new tab.
function PoweredByFooter() {
  return (
    <a
      href="/"
      target="_blank"
      rel="noopener noreferrer"
      className="group flex shrink-0 items-center justify-center gap-1 border-t border-neutral-100 bg-white py-2.5 text-[11px] tracking-tight text-neutral-400 transition-colors hover:text-[var(--wc-button)]"
    >
      Powered by{" "}
      <span className="font-semibold text-neutral-500 transition-colors group-hover:text-[var(--wc-button)]">
        MyChat
      </span>
    </a>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-t-lg pb-3 pt-2.5 text-sm font-medium transition ${
        active
          ? "text-neutral-900"
          : "text-neutral-400 hover:bg-neutral-50 hover:text-neutral-700"
      }`}
    >
      {icon}
      {label}
      <span
        className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-opacity ${
          active ? "opacity-100" : "opacity-0"
        }`}
        style={{ background: "var(--wc-button)" }}
      />
    </button>
  );
}
