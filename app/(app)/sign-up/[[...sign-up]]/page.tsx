import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { Check, Globe, Sparkles, Zap } from "lucide-react";
import { BrandMark } from "@/app/_components/brand-mark";

const BENEFITS = [
  {
    icon: Globe,
    title: "Crawl your site in minutes",
    body: "Point MyChat at your website and it builds the knowledge base your AI answers from.",
  },
  {
    icon: Zap,
    title: "Live without engineering",
    body: "Customize the widget to your brand, paste one snippet, and you're answering instantly.",
  },
];

const PLAN_POINTS = [
  "AI answers from your knowledge base",
  "Shared inbox with human takeover",
  "No credit card required",
];

// Clerk appearance tuned to the MyChat brand: indigo primary, rounded inputs,
// and a transparent card so it sits cleanly on the right-hand panel.
const clerkAppearance = {
  variables: {
    colorPrimary: "#5746f0",
    colorText: "#0a0918",
    colorTextSecondary: "#6b7280",
    borderRadius: "0.75rem",
    fontFamily: "var(--font-geist-sans, inherit)",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full shadow-none",
    card: "bg-transparent shadow-none border-0 p-0",
    headerTitle: "text-2xl font-semibold tracking-tight",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButton:
      "rounded-xl border-border hover:bg-muted transition-colors",
    formButtonPrimary:
      "rounded-xl bg-gradient-to-br from-brand to-brand-2 shadow-[0_8px_24px_-8px_var(--brand)] hover:opacity-95 text-sm normal-case",
    formFieldInput: "rounded-xl",
    footerActionLink: "text-brand hover:text-brand-2",
  },
} as const;

export default function SignUpPage() {
  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      {/* Left: branded panel (hidden on small screens) */}
      <section className="relative hidden overflow-hidden bg-ink text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        {/* Aurora */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="animate-aurora absolute -top-32 left-[10%] size-[30rem] rounded-full bg-brand/40 blur-[130px]" />
          <div
            className="animate-aurora absolute bottom-[-8rem] right-[5%] size-[26rem] rounded-full bg-brand-2/30 blur-[130px]"
            style={{ animationDelay: "-6s" }}
          />
        </div>
        {/* Dotgrid + grain texture */}
        <div
          aria-hidden
          className="bg-dotgrid pointer-events-none absolute inset-0 opacity-[0.18] [mask-image:radial-gradient(70%_60%_at_30%_30%,black,transparent)]"
        />
        <div
          aria-hidden
          className="grain pointer-events-none absolute inset-0 opacity-[0.05] mix-blend-soft-light"
        />

        <div className="relative">
          <Link href="/" aria-label="MyChat home">
            <BrandMark wordClassName="text-white" />
          </Link>
        </div>

        <div className="relative max-w-md">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-white/80 backdrop-blur">
            <Sparkles className="size-3.5 text-brand-2" />
            Start free in minutes
          </span>
          <h2 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight text-balance">
            Turn support into your best channel.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-pretty text-white/60">
            Deploy an AI agent trained on your knowledge base, capture leads, and
            hand the hard questions to your team — all from one widget.
          </p>

          <ul className="mt-10 space-y-5">
            {BENEFITS.map((b) => (
              <li key={b.title} className="flex items-start gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-brand-2 ring-1 ring-white/10 backdrop-blur">
                  <b.icon className="size-5" />
                </span>
                <div>
                  <p className="font-medium text-white">{b.title}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-white/55">
                    {b.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <ul className="mt-10 flex flex-col gap-2.5 border-t border-white/10 pt-8">
            {PLAN_POINTS.map((p) => (
              <li key={p} className="flex items-center gap-2.5 text-sm text-white/70">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand/20 text-brand-2">
                  <Check className="size-3" />
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-sm text-white/55">
          <span className="font-semibold text-white">2,000+</span> support teams
          onboard with MyChat
        </div>
      </section>

      {/* Right: Clerk sign-up on a clean background */}
      <section className="relative flex flex-col items-center justify-center bg-background px-6 py-12 sm:px-10">
        {/* Brand mark for mobile, where the left panel is hidden */}
        <div className="mb-10 lg:hidden">
          <Link href="/" aria-label="MyChat home">
            <BrandMark />
          </Link>
        </div>

        <div className="w-full max-w-sm">
          <SignUp appearance={clerkAppearance} />
        </div>

        <p className="mt-10 text-center text-xs text-muted-foreground">
          By creating an account you agree to MyChat&apos;s{" "}
          <Link href="#" className="text-foreground/70 underline-offset-4 hover:underline">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="#" className="text-foreground/70 underline-offset-4 hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
