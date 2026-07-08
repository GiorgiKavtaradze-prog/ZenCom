"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Lock, MessageSquareText } from "lucide-react";

type Field = "firstName" | "lastName" | "email" | "phone";

type Props = {
  workspaceId: Id<"workspaces">;
  visitorId: string;
  conversationId: Id<"conversations"> | null;
  requiredFields: Field[];
  onCaptured: () => void;
};

const LABELS: Record<Field, string> = {
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Gate the chat behind a small lead form when settings.leadCapture.enabled.
// `email` is always sent (the backend requires it); other required fields are
// driven by `requiredFields`. Validated client-side, then re-validated +
// rate-limited server-side by widget.captureLead.
export function LeadCaptureForm({
  workspaceId,
  visitorId,
  conversationId,
  requiredFields,
  onCaptured,
}: Props) {
  const capture = useMutation(api.widget.captureLead);

  // Always collect email (server requires it) plus any other required fields.
  const fields: Field[] = Array.from(
    new Set<Field>(["email", ...requiredFields]),
  );

  const [values, setValues] = useState<Record<Field, string>>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(field: Field, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    for (const f of fields) {
      if (!values[f].trim()) {
        setError(`${LABELS[f]} is required.`);
        return;
      }
    }
    if (!EMAIL_RE.test(values.email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }

    setSubmitting(true);
    try {
      await capture({
        workspaceId,
        visitorId,
        conversationId: conversationId ?? undefined,
        email: values.email.trim(),
        firstName: values.firstName.trim() || undefined,
        lastName: values.lastName.trim() || undefined,
        phone: values.phone.trim() || undefined,
      });
      // Remember so we don't re-gate on the next open.
      try {
        localStorage.setItem(`mychat_lead_${workspaceId}`, "1");
      } catch {
        /* ignore storage errors (private mode) */
      }
      onCaptured();
    } catch (err) {
      const code =
        (err as { data?: { code?: string } })?.data?.code ?? "ERROR";
      setError(
        code === "INVALID_EMAIL"
          ? "Please enter a valid email address."
          : code === "RateLimitError" || code === "leadCapture"
            ? "Too many attempts — please try again later."
            : "Something went wrong. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col justify-center bg-[#fafafb] p-6">
      <div className="mx-auto w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <span className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-[var(--wc-theme)]/10 text-[var(--wc-theme)]">
            <MessageSquareText className="size-6" />
          </span>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
            Before we start
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-500">
            Leave your details so we can follow up.
          </p>
        </div>

        <form onSubmit={submit} className="mt-6 space-y-3.5">
          {fields.map((f) => (
            <div key={f}>
              <label
                htmlFor={`lead-${f}`}
                className="mb-1.5 block text-xs font-medium text-neutral-600"
              >
                {LABELS[f]}
              </label>
              <input
                id={`lead-${f}`}
                type={f === "email" ? "email" : f === "phone" ? "tel" : "text"}
                value={values[f]}
                onChange={(e) => set(f, e.target.value)}
                autoComplete={
                  f === "email"
                    ? "email"
                    : f === "phone"
                      ? "tel"
                      : f === "firstName"
                        ? "given-name"
                        : "family-name"
                }
                className="w-full rounded-xl border border-neutral-200 bg-white px-3.5 py-2.5 text-sm outline-none transition placeholder:text-neutral-400 focus:border-transparent focus:ring-2 focus:ring-[var(--wc-button)]/30"
              />
            </div>
          ))}

          {error ? (
            <p className="text-center text-xs font-medium text-rose-500">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="mt-1 w-full rounded-xl py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-95 disabled:opacity-50"
            style={{ background: "var(--wc-button)" }}
          >
            {submitting ? "Starting…" : "Start chatting"}
          </button>
        </form>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-neutral-400">
          <Lock className="size-3" />
          We&apos;ll only use this to follow up on your request.
        </p>
      </div>
    </div>
  );
}
