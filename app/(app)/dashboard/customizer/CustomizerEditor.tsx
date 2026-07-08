"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  ImageIcon,
  Loader2,
  MessageSquareText,
  Monitor,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Terminal,
  Upload,
  Users,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { WidgetPreview } from "./WidgetPreview";

// ─────────────────────────────────────────────────────────────────────────────
// The editor: a controlled form whose state mirrors the loaded server values.
// "Save" is explicit (the appearance + behaviour saves are two separate Convex
// mutations, run in parallel; only dirty sections are written). A faithful mock
// preview re-renders live as the form changes; a re-keyable iframe shows the
// REAL rendered widget on demand. Logo upload uses generateUploadUrl →
// finalizeImageUpload (server validates MIME/size, rejects SVG) before the id is
// stored on save.
// ─────────────────────────────────────────────────────────────────────────────

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

type RequiredField = "firstName" | "lastName" | "email" | "phone";
const LEAD_FIELDS: { value: RequiredField; label: string }[] = [
  { value: "firstName", label: "First name" },
  { value: "lastName", label: "Last name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
];

const POSITIONS = [
  { value: "bottom-left" as const, label: "Lower left" },
  { value: "bottom-right" as const, label: "Lower right" },
];

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

type Settings = {
  proactiveMessage: { enabled: boolean; delaySeconds: number; text: string };
  leadCapture: { enabled: boolean; requiredFields: RequiredField[] };
  faqEnabled: boolean;
};

function convexErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
  }
  return fallback;
}

export function CustomizerEditor({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const serverAppearance = useQuery(api.widget.getAppearance, {});
  const serverSettings = useQuery(api.widget.getSettings, {});

  const updateAppearance = useMutation(api.widget.updateAppearance);
  const updateSettings = useMutation(api.widget.updateSettings);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const finalizeImageUpload = useMutation(api.files.finalizeImageUpload);

  // Local working copy. Initialized from the server once it loads; thereafter
  // the form owns the truth until a Save (which re-syncs from the server).
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  // Logo: a pending storageId not yet persisted (cleared on save). `null` here
  // distinguishes "clear the logo" from "leave unchanged" (undefined).
  const [pendingLogoId, setPendingLogoId] = useState<
    Id<"_storage"> | null | undefined
  >(undefined);
  const [pendingLogoUrl, setPendingLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // Hydrate local state once the server values arrive (and only then — never
  // clobber in-flight edits on a reactive re-fire after our own save resolves).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (serverAppearance && serverSettings) {
      setAppearance(serverAppearance);
      setSettings(serverSettings);
      hydratedRef.current = true;
    }
  }, [serverAppearance, serverSettings]);

  const loading = !appearance || !settings;

  // Resolve the logo URL shown in the preview: a freshly-uploaded (pending) logo
  // wins; otherwise the saved one; `pendingLogoId === null` means "cleared".
  const effectiveLogoUrl =
    pendingLogoId === null
      ? null
      : pendingLogoId !== undefined
        ? pendingLogoUrl
        : (appearance?.logoUrl ?? null);

  function patchAppearance(p: Partial<Appearance>) {
    setAppearance((prev) => (prev ? { ...prev, ...p } : prev));
  }
  function patchSettings(p: Partial<Settings>) {
    setSettings((prev) => (prev ? { ...prev, ...p } : prev));
  }

  async function handleLogoFile(file: File) {
    setUploading(true);
    try {
      const postUrl = await generateUploadUrl();
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { storageId } = (await res.json()) as {
        storageId: Id<"_storage">;
      };
      // Server validates MIME + size and rejects SVG here, returning a URL.
      const { url } = await finalizeImageUpload({ storageId });
      setPendingLogoId(storageId);
      setPendingLogoUrl(url);
      toast.success("Logo uploaded — Save to apply it.");
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not upload the logo."));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function clearLogo() {
    setPendingLogoId(null);
    setPendingLogoUrl(null);
  }

  async function handleSave() {
    if (!appearance || !settings) return;

    // Validate the three hex colors client-side for a friendly message; the
    // server re-validates regardless.
    for (const [field, value] of [
      ["Theme color", appearance.themeColor],
      ["Button color", appearance.buttonColor],
      ["Title color", appearance.titleColor],
    ] as const) {
      if (!HEX_COLOR.test(value)) {
        toast.error(`${field} must be a hex value like #4F46E5.`);
        return;
      }
    }

    setSaving(true);
    try {
      await Promise.all([
        updateAppearance({
          themeColor: appearance.themeColor,
          buttonColor: appearance.buttonColor,
          cornerRadius: appearance.cornerRadius,
          title: appearance.title,
          titleColor: appearance.titleColor,
          // undefined ⇒ leave as-is; null ⇒ clear; id ⇒ set.
          logoStorageId: pendingLogoId,
          position: appearance.position,
          bottomMargin: appearance.bottomMargin,
          sideMargin: appearance.sideMargin,
          notificationSound: appearance.notificationSound,
        }),
        updateSettings({
          proactiveMessage: settings.proactiveMessage,
          leadCapture: settings.leadCapture,
          faqEnabled: settings.faqEnabled,
        }),
      ]);
      // Re-sync from server on next reactive fire + reset pending logo state.
      hydratedRef.current = false;
      setPendingLogoId(undefined);
      setPendingLogoUrl(null);
      setPreviewNonce((n) => n + 1); // refresh the live iframe to the saved state
      toast.success("Widget updated.");
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not save your changes."));
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    if (serverAppearance && serverSettings) {
      setAppearance(serverAppearance);
      setSettings(serverSettings);
      setPendingLogoId(undefined);
      setPendingLogoUrl(null);
      toast.info("Reverted unsaved changes.");
    }
  }

  const snippet = useMemo(
    () =>
      origin
        ? `<script async src="${origin}/loader.js?app_id=${workspaceId}"></script>`
        : "",
    [origin, workspaceId],
  );

  async function copySnippet() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(320px,440px)]">
        <Skeleton className="h-[600px] w-full rounded-2xl" />
        <Skeleton className="h-[600px] w-full rounded-2xl" />
      </div>
    );
  }

  const previewAppearance: Appearance = {
    ...appearance!,
    logoUrl: effectiveLogoUrl,
  };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_minmax(320px,440px)]">
      {/* ── LEFT: the editor ──────────────────────────────────────────────── */}
      <div className="space-y-6">
        <Tabs defaultValue="appearance" className="w-full">
          <TabsList className="grid w-full grid-cols-3 sm:w-auto sm:inline-grid">
            <TabsTrigger value="appearance" className="gap-1.5">
              <Palette className="size-4" />
              Appearance
            </TabsTrigger>
            <TabsTrigger value="behaviour" className="gap-1.5">
              <Sparkles className="size-4" />
              Behaviour
            </TabsTrigger>
            <TabsTrigger value="install" className="gap-1.5">
              <Code2 className="size-4" />
              Install
            </TabsTrigger>
          </TabsList>

          {/* APPEARANCE */}
          <TabsContent value="appearance" className="mt-6 space-y-6">
            <Section
              icon={Palette}
              title="Colors & theme"
              description="Match the widget to your brand."
            >
              <div className="space-y-5">
                <ColorRow
                  label="Header / theme color"
                  value={appearance!.themeColor}
                  onChange={(v) => patchAppearance({ themeColor: v })}
                />
                <ColorRow
                  label="Launcher button color"
                  value={appearance!.buttonColor}
                  onChange={(v) => patchAppearance({ buttonColor: v })}
                />
                <ColorRow
                  label="Title text color"
                  value={appearance!.titleColor}
                  onChange={(v) => patchAppearance({ titleColor: v })}
                />
              </div>
            </Section>

            <Section
              icon={MessageSquareText}
              title="Copy & logo"
              description="The header text and brand mark visitors see."
            >
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="title">Header title</Label>
                  <Input
                    id="title"
                    value={appearance!.title}
                    maxLength={60}
                    onChange={(e) => patchAppearance({ title: e.target.value })}
                    placeholder="Chat with us"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Logo</Label>
                  <div className="bg-muted/40 flex items-center gap-4 rounded-xl border border-dashed p-3">
                    <div className="bg-background grid size-14 shrink-0 place-items-center overflow-hidden rounded-xl border">
                      {effectiveLogoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={effectiveLogoUrl}
                          alt="Logo"
                          className="size-full object-contain"
                        />
                      ) : (
                        <ImageIcon className="text-muted-foreground size-5" />
                      )}
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleLogoFile(f);
                      }}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={uploading}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {uploading ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Upload className="size-4" />
                        )}
                        {uploading ? "Uploading…" : "Upload"}
                      </Button>
                      {effectiveLogoUrl ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={clearLogo}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    PNG, JPG, WebP or GIF up to 5 MB. SVG isn&apos;t supported.
                  </p>
                </div>
              </div>
            </Section>

            <Section
              icon={Monitor}
              title="Shape & position"
              description="Where the launcher sits and how it's rounded."
            >
              <div className="space-y-6">
                <SliderRow
                  label="Corner radius"
                  value={appearance!.cornerRadius}
                  min={0}
                  max={32}
                  step={1}
                  unit="px"
                  onChange={(v) => patchAppearance({ cornerRadius: v })}
                />
                <SliderRow
                  label="Bottom margin"
                  value={appearance!.bottomMargin}
                  min={0}
                  max={120}
                  step={1}
                  unit="px"
                  onChange={(v) => patchAppearance({ bottomMargin: v })}
                />
                <SliderRow
                  label="Side margin"
                  value={appearance!.sideMargin}
                  min={0}
                  max={120}
                  step={1}
                  unit="px"
                  onChange={(v) => patchAppearance({ sideMargin: v })}
                />

                <div className="space-y-2">
                  <Label htmlFor="position">Launcher position</Label>
                  <Select
                    value={appearance!.position}
                    onValueChange={(v) =>
                      patchAppearance({
                        position: v as Appearance["position"],
                      })
                    }
                  >
                    <SelectTrigger id="position" className="w-full">
                      <SelectValue placeholder="Choose a position" />
                    </SelectTrigger>
                    <SelectContent>
                      {POSITIONS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <ToggleRow
                  id="sound"
                  label="Notification sound"
                  description="Play a chime when a new reply arrives."
                  checked={appearance!.notificationSound}
                  onCheckedChange={(v) =>
                    patchAppearance({ notificationSound: v })
                  }
                />
              </div>
            </Section>

            <TeamAvatarsCard />
          </TabsContent>

          {/* BEHAVIOUR */}
          <TabsContent value="behaviour" className="mt-6 space-y-6">
            <Section
              icon={Sparkles}
              title="Proactive message"
              description="Pop a message after a visitor lingers."
              action={
                <Switch
                  aria-label="Enable proactive message"
                  checked={settings!.proactiveMessage.enabled}
                  onCheckedChange={(v) =>
                    patchSettings({
                      proactiveMessage: {
                        ...settings!.proactiveMessage,
                        enabled: v,
                      },
                    })
                  }
                />
              }
            >
              {settings!.proactiveMessage.enabled ? (
                <div className="space-y-5">
                  <SliderRow
                    label="Delay before showing"
                    value={settings!.proactiveMessage.delaySeconds}
                    min={0}
                    max={600}
                    step={5}
                    unit="s"
                    onChange={(v) =>
                      patchSettings({
                        proactiveMessage: {
                          ...settings!.proactiveMessage,
                          delaySeconds: v,
                        },
                      })
                    }
                  />
                  <div className="space-y-2">
                    <Label htmlFor="proactive-text">Message</Label>
                    <Textarea
                      id="proactive-text"
                      rows={3}
                      maxLength={280}
                      value={settings!.proactiveMessage.text}
                      onChange={(e) =>
                        patchSettings({
                          proactiveMessage: {
                            ...settings!.proactiveMessage,
                            text: e.target.value,
                          },
                        })
                      }
                      placeholder="Hi there! 👋 Can we help you with anything?"
                    />
                  </div>
                </div>
              ) : null}
            </Section>

            <Section
              icon={Users}
              title="Lead capture"
              description="Ask visitors for their contact details."
              action={
                <Switch
                  aria-label="Enable lead capture"
                  checked={settings!.leadCapture.enabled}
                  onCheckedChange={(v) =>
                    patchSettings({
                      leadCapture: { ...settings!.leadCapture, enabled: v },
                    })
                  }
                />
              }
            >
              {settings!.leadCapture.enabled ? (
                <div className="space-y-3">
                  <Label>Required fields</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {LEAD_FIELDS.map((f) => {
                      const checked =
                        settings!.leadCapture.requiredFields.includes(f.value);
                      return (
                        <button
                          key={f.value}
                          type="button"
                          aria-pressed={checked}
                          onClick={() => {
                            const set = new Set(
                              settings!.leadCapture.requiredFields,
                            );
                            if (set.has(f.value)) set.delete(f.value);
                            else set.add(f.value);
                            patchSettings({
                              leadCapture: {
                                ...settings!.leadCapture,
                                requiredFields: Array.from(set),
                              },
                            });
                          }}
                          className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
                            checked
                              ? "border-brand bg-brand/10 text-brand font-medium"
                              : "hover:border-border hover:bg-muted/60"
                          }`}
                        >
                          <span
                            className={`grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors ${
                              checked
                                ? "border-brand bg-brand text-white"
                                : "border-input"
                            }`}
                          >
                            {checked ? <Check className="size-3" /> : null}
                          </span>
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </Section>

            <Section
              icon={MessageSquareText}
              title="Helpdesk / FAQ tab"
              description="Show a searchable articles tab in the widget."
              action={
                <Switch
                  aria-label="Enable helpdesk tab"
                  checked={settings!.faqEnabled}
                  onCheckedChange={(v) => patchSettings({ faqEnabled: v })}
                />
              }
            />
          </TabsContent>

          {/* INSTALL */}
          <TabsContent value="install" className="mt-6 space-y-6">
            <Section
              icon={Terminal}
              title="Install snippet"
              description={
                <>
                  Paste this just before{" "}
                  <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[11px]">
                    &lt;/body&gt;
                  </code>{" "}
                  on every page. Your{" "}
                  <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[11px]">
                    app_id
                  </code>{" "}
                  is your workspace id — safe to expose publicly.
                </>
              }
            >
              <div className="space-y-4">
                <div className="overflow-hidden rounded-xl border bg-ink shadow-soft">
                  <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3.5 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="flex gap-1.5" aria-hidden>
                        <span className="size-2.5 rounded-full bg-rose-400/80" />
                        <span className="size-2.5 rounded-full bg-amber-400/80" />
                        <span className="size-2.5 rounded-full bg-emerald-400/80" />
                      </span>
                      <span className="ml-1 font-mono text-[11px] text-white/40">
                        index.html
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 px-2.5 text-white/70 hover:bg-white/10 hover:text-white"
                      onClick={copySnippet}
                      disabled={!snippet}
                    >
                      {copied ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  <pre className="overflow-x-auto px-4 py-3.5 font-mono text-xs leading-relaxed text-white/90">
                    {snippet || "Loading…"}
                  </pre>
                </div>
                {origin ? (
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={`${origin}/demo.html?app_id=${workspaceId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="size-4" />
                      Open demo site
                    </a>
                  </Button>
                ) : null}
              </div>
            </Section>
          </TabsContent>
        </Tabs>

        {/* Sticky save bar */}
        <div className="bg-background/80 sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-2 rounded-t-xl border-t px-1 py-3 backdrop-blur">
          <Button
            type="button"
            variant="ghost"
            onClick={resetForm}
            disabled={saving}
          >
            <RotateCcw className="size-4" />
            Revert
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="bg-gradient-to-br from-brand to-brand-2 text-white shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      {/* ── RIGHT: live preview ──────────────────────────────────────────── */}
      <div className="lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-2xl border bg-card p-1.5 shadow-card">
          {/* Browser-style chrome */}
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="flex gap-1.5" aria-hidden>
                <span className="size-2.5 rounded-full bg-rose-300" />
                <span className="size-2.5 rounded-full bg-amber-300" />
                <span className="size-2.5 rounded-full bg-emerald-300" />
              </span>
              <Badge variant="outline" className="ml-1 gap-1">
                <span className="bg-emerald-500 size-1.5 rounded-full" />
                Live preview
              </Badge>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setPreviewNonce((n) => n + 1)}
              title="Refresh real-widget preview"
            >
              <RefreshCw className="size-3.5" />
              <span className="sr-only">Refresh preview</span>
            </Button>
          </div>

          {/* The framed preview surface */}
          <div className="bg-muted/30 overflow-hidden rounded-xl border">
            <WidgetPreview
              appearance={previewAppearance}
              faqEnabled={settings!.faqEnabled}
              proactiveText={
                settings!.proactiveMessage.enabled
                  ? settings!.proactiveMessage.text
                  : null
              }
            />
          </div>

          <div className="space-y-2.5 px-3 py-3">
            <p className="text-muted-foreground text-xs leading-relaxed">
              The mock above updates as you edit. To see the real rendered widget
              with your saved settings:
            </p>
            {origin ? (
              <details className="group">
                <summary className="text-brand hover:text-brand/80 inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium">
                  <Monitor className="size-3.5" />
                  Load real widget
                </summary>
                <div className="mt-3 overflow-hidden rounded-xl border">
                  <iframe
                    key={previewNonce}
                    src={`${origin}/widget?app_id=${workspaceId}`}
                    title="Widget preview"
                    className="h-[420px] w-full"
                  />
                </div>
              </details>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section shell ───────────────────────────────────────────────────────────
// A grouped settings card: an icon chip + title + (optional) description, an
// optional header action (e.g. a master Switch), and the controls beneath.
function Section({
  icon: Icon,
  title,
  description,
  action,
  children,
}: {
  icon: typeof Palette;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="bg-card rounded-2xl border p-6 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="bg-brand/10 text-brand flex size-10 shrink-0 items-center justify-center rounded-xl">
            <Icon className="size-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight">{title}</h3>
            {description ? (
              <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
      </div>
      {children ? <div className="mt-6">{children}</div> : null}
    </section>
  );
}

// ── A label + helper text on the left, a Switch on the right ─────────────────
function ToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="bg-muted/40 flex items-center justify-between gap-4 rounded-xl border p-4">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

// ── Per-member widget avatars ───────────────────────────────────────────────
// Admins set the photo shown next to each teammate in the widget header / inbox.
// Unlike the appearance form, these apply IMMEDIATELY (own upload → finalize →
// setMemberAvatar round-trip) rather than being staged into the explicit Save —
// each member is an independent write, so there's nothing to batch. A member's
// custom avatar overrides their Clerk photo everywhere it's displayed.
function TeamAvatarsCard() {
  const members = useQuery(api.widget.listTeamAvatars, {});
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const finalizeImageUpload = useMutation(api.files.finalizeImageUpload);
  const setMemberAvatar = useMutation(api.widget.setMemberAvatar);

  // The clerkUserId of the row currently uploading/clearing (locks that row).
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputsRef = useRef<Record<string, HTMLInputElement | null>>({});

  async function uploadFor(clerkUserId: string, file: File) {
    setBusyId(clerkUserId);
    try {
      const postUrl = await generateUploadUrl();
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { storageId } = (await res.json()) as {
        storageId: Id<"_storage">;
      };
      // Server validates MIME + size and rejects SVG here.
      await finalizeImageUpload({ storageId });
      await setMemberAvatar({ clerkUserId, avatarStorageId: storageId });
      toast.success("Avatar updated.");
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not update the avatar."));
    } finally {
      setBusyId(null);
      const input = fileInputsRef.current[clerkUserId];
      if (input) input.value = "";
    }
  }

  async function clearFor(clerkUserId: string) {
    setBusyId(clerkUserId);
    try {
      await setMemberAvatar({ clerkUserId, avatarStorageId: null });
      toast.success("Avatar reset to default.");
    } catch (err) {
      toast.error(convexErrorMessage(err, "Could not reset the avatar."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section
      icon={Users}
      title="Team avatars"
      description="Set the photo shown next to each teammate in the widget header and inbox. Changes apply immediately — no need to Save."
    >
      <div className="space-y-3">
        {members === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl border p-3"
              >
                <Skeleton className="size-10 rounded-full" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))}
          </div>
        ) : members.length === 0 ? (
          <div className="bg-muted/40 rounded-xl border border-dashed py-8 text-center">
            <p className="text-muted-foreground text-sm">
              No active team members yet.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {members.map((m) => {
              const shown = m.customAvatarUrl ?? m.clerkImageUrl;
              const busy = busyId === m.clerkUserId;
              return (
                <div
                  key={m.clerkUserId}
                  className="hover:bg-muted/50 flex items-center gap-3 rounded-xl border p-3 transition-colors"
                >
                  <div className="bg-muted grid size-10 shrink-0 place-items-center overflow-hidden rounded-full border">
                    {shown ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={shown}
                        alt={m.name}
                        className="size-full object-cover"
                      />
                    ) : (
                      <span className="text-muted-foreground text-sm font-semibold">
                        {m.name.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="text-muted-foreground text-xs capitalize">
                      {m.role}
                      {m.customAvatarUrl ? " · custom photo" : ""}
                    </p>
                  </div>
                  <input
                    ref={(el) => {
                      fileInputsRef.current[m.clerkUserId] = el;
                    }}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadFor(m.clerkUserId, f);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      fileInputsRef.current[m.clerkUserId]?.click()
                    }
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Upload className="size-4" />
                    )}
                    {busy ? "Saving…" : "Upload"}
                  </Button>
                  {m.customAvatarUrl ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void clearFor(m.clerkUserId)}
                    >
                      Reset
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          PNG, JPG, WebP or GIF up to 5 MB. SVG isn&apos;t supported.
        </p>
      </div>
    </Section>
  );
}

// ── Small controlled sub-rows ───────────────────────────────────────────────

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const valid = HEX_COLOR.test(value);
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-sm font-normal">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-[112px] font-mono text-sm uppercase ${
            valid ? "" : "border-destructive focus-visible:ring-destructive/30"
          }`}
          placeholder="#4F46E5"
        />
        <div className="border-input relative size-9 shrink-0 overflow-hidden rounded-lg border shadow-soft">
          <input
            type="color"
            value={valid ? expandHex(value) : "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="absolute -inset-1 size-[calc(100%+0.5rem)] cursor-pointer border-0 bg-transparent p-0"
            aria-label={`${label} swatch`}
          />
        </div>
      </div>
    </div>
  );
}

// <input type=color> requires 6-digit hex; expand #abc → #aabbcc.
function expandHex(hex: string): string {
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return (
      "#" +
      hex
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
    );
  }
  return hex;
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-normal">{label}</Label>
        <span className="bg-muted text-foreground rounded-md px-2 py-0.5 font-mono text-xs tabular-nums">
          {value}
          {unit}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0] ?? value)}
      />
    </div>
  );
}
