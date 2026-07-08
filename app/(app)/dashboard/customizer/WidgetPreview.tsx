"use client";

import { MessageSquare, Search, Send } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// A faithful, dependency-free MOCK of the widget that re-renders instantly as
// the customizer form changes — no save round-trip, no iframe reload. It mirrors
// the real widget's structure (header with title + optional logo, a couple of
// messages, an optional helpdesk affordance, a composer, and the launcher bubble
// in the chosen corner) styled from the live appearance values.
// ─────────────────────────────────────────────────────────────────────────────

type Appearance = {
  themeColor: string;
  buttonColor: string;
  cornerRadius: number;
  title: string;
  titleColor: string;
  logoUrl: string | null;
  position: "bottom-right" | "bottom-left";
  bottomMargin: number;
  sideMargin: number;
  notificationSound: boolean;
};

export function WidgetPreview({
  appearance,
  faqEnabled,
  proactiveText,
}: {
  appearance: Appearance;
  faqEnabled: boolean;
  proactiveText: string | null;
}) {
  const {
    themeColor,
    buttonColor,
    cornerRadius,
    title,
    titleColor,
    logoUrl,
    position,
  } = appearance;
  const isLeft = position === "bottom-left";

  return (
    <div
      className="bg-muted/40 relative h-[420px] w-full overflow-hidden rounded-lg border"
      style={{
        backgroundImage:
          "radial-gradient(circle at 1px 1px, var(--border) 1px, transparent 0)",
        backgroundSize: "16px 16px",
      }}
    >
      {/* Proactive bubble (when enabled) */}
      {proactiveText ? (
        <div
          className="absolute bottom-[84px] max-w-[220px] rounded-2xl bg-white px-3 py-2 text-xs text-slate-700 shadow-md"
          style={
            isLeft ? { left: 16 } : { right: 16 }
          }
        >
          {proactiveText.slice(0, 120) || "Hi there! 👋"}
        </div>
      ) : null}

      {/* The widget panel */}
      <div
        className="absolute top-4 w-[280px] overflow-hidden bg-white shadow-xl"
        style={{
          borderRadius: cornerRadius,
          ...(isLeft ? { left: 16 } : { right: 16 }),
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ backgroundColor: themeColor }}
        >
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className="size-6 rounded-md bg-white/20 object-contain"
            />
          ) : (
            <div className="grid size-6 place-items-center rounded-md bg-white/20">
              <MessageSquare className="size-3.5" style={{ color: titleColor }} />
            </div>
          )}
          <span
            className="text-sm font-semibold"
            style={{ color: titleColor }}
          >
            {title || "Chat with us"}
          </span>
        </div>

        {/* Optional helpdesk search affordance */}
        {faqEnabled ? (
          <div className="border-b px-3 py-2">
            <div className="flex items-center gap-2 rounded-md border bg-slate-50 px-2 py-1.5 text-xs text-slate-400">
              <Search className="size-3.5" />
              Search for help…
            </div>
          </div>
        ) : null}

        {/* Messages */}
        <div className="space-y-2 px-3 py-3">
          <div className="flex">
            <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-slate-100 px-3 py-2 text-xs text-slate-700">
              Hey! 👋 How can we help today?
            </div>
          </div>
          <div className="flex justify-end">
            <div
              className="max-w-[80%] rounded-2xl rounded-tr-sm px-3 py-2 text-xs text-white"
              style={{ backgroundColor: buttonColor }}
            >
              I have a question about pricing.
            </div>
          </div>
        </div>

        {/* Composer */}
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <div className="flex-1 truncate text-xs text-slate-400">
            Type a message…
          </div>
          <div
            className="grid size-7 shrink-0 place-items-center rounded-full"
            style={{ backgroundColor: buttonColor }}
          >
            <Send className="size-3.5 text-white" />
          </div>
        </div>
      </div>

      {/* Launcher bubble */}
      <div
        className="absolute bottom-4 grid size-12 place-items-center rounded-full shadow-lg"
        style={{
          backgroundColor: buttonColor,
          ...(isLeft ? { left: 16 } : { right: 16 }),
        }}
      >
        <MessageSquare className="size-5 text-white" />
      </div>
    </div>
  );
}
