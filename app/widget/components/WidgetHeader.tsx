"use client";

import { X } from "lucide-react";

type RosterMember = { name: string; avatarUrl?: string; online: boolean };

type Props = {
  title: string;
  logoUrl: string | null;
  roster?: { anyOnline: boolean; members: RosterMember[] };
  onClose: () => void;
};

// Header: title/logo + a stacked team-avatar row + a presence-driven status
// line ("Team is online" vs "We typically reply in minutes"). Themed via the
// inline CSS vars (--wc-theme background, --wc-title text).
export function WidgetHeader({ title, logoUrl, roster, onClose }: Props) {
  const members = roster?.members ?? [];
  const anyOnline = roster?.anyOnline ?? false;
  const status = anyOnline ? "Team is online" : "We typically reply in minutes";

  return (
    <header
      className="relative overflow-hidden px-5 pb-5 pt-5"
      style={{ background: "var(--wc-theme)", color: "var(--wc-title)" }}
    >
      {/* Soft depth: a faint top-light sheen + grain-free radial glow that reads
          on top of whatever theme color the workspace has chosen. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.08] to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-16 size-44 rounded-full bg-white/[0.07] blur-2xl"
      />

      <button
        aria-label="Close chat"
        onClick={onClose}
        className="absolute right-3.5 top-3.5 z-10 flex size-7 items-center justify-center rounded-full opacity-80 transition hover:bg-white/15 hover:opacity-100"
        style={{ color: "var(--wc-title)" }}
      >
        <X className="size-4" />
      </button>

      <div className="relative flex items-center gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt=""
            className="size-9 rounded-xl bg-white/20 object-contain ring-1 ring-white/25"
          />
        ) : null}
        <h1 className="text-[1.35rem] font-semibold leading-tight tracking-tight">
          {title}
        </h1>
      </div>

      {members.length > 0 ? (
        <div className="relative mt-3.5 flex items-center gap-2.5">
          <div className="flex -space-x-2.5">
            {members.slice(0, 5).map((m, i) => (
              <Avatar key={`${m.name}-${i}`} member={m} />
            ))}
          </div>
          <StatusLine anyOnline={anyOnline} status={status} />
        </div>
      ) : (
        <div className="relative mt-2.5">
          <StatusLine anyOnline={anyOnline} status={status} />
        </div>
      )}
    </header>
  );
}

function StatusLine({
  anyOnline,
  status,
}: {
  anyOnline: boolean;
  status: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[13px] font-medium opacity-90">
      <span className="relative flex size-2">
        {anyOnline ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/70" />
        ) : null}
        <span
          className={`relative inline-flex size-2 rounded-full ${
            anyOnline
              ? "bg-emerald-400 shadow-[0_0_0_3px_rgba(110,231,183,0.25)]"
              : "bg-white/40"
          }`}
        />
      </span>
      {status}
    </div>
  );
}

function Avatar({ member }: { member: RosterMember }) {
  const initial = member.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="relative inline-block">
      {member.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={member.avatarUrl}
          alt={member.name}
          title={member.name}
          className="size-8 rounded-full object-cover ring-2 ring-white/80"
        />
      ) : (
        <span
          title={member.name}
          className="flex size-8 items-center justify-center rounded-full bg-white/20 text-xs font-semibold ring-2 ring-white/80"
        >
          {initial}
        </span>
      )}
      {member.online ? (
        <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[var(--wc-theme)] bg-emerald-400" />
      ) : null}
    </span>
  );
}
