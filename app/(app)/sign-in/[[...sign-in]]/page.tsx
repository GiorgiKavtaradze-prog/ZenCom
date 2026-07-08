import Link from "next/link";
import { SignIn } from "@clerk/nextjs";
import { Bot, Inbox, ShieldCheck, Sparkles } from "lucide-react";
import { BrandMark } from "@/app/_components/brand-mark";

const HIGHLIGHTS = [
  {
    icon: Bot,
    title: "AI that knows your product",
    body: "Instant, on-brand answers pulled straight from your knowledge base — 24/7.",
  },
  {
    icon: Inbox,
    title: "One shared inbox",
    body: "Every conversation in one place, with human takeover whenever it matters.",
  },
  {
    icon: ShieldCheck,
    title: "Secure by default",
    body: "Enterprise-grade auth and data protection your customers can trust.",
  },
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

export default function SignInPage() {
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
            AI-native customer support
          </span>
          <h2 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight text-balance">
            Welcome back to your support desk.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-pretty text-white/60">
            Pick up every conversation where you left off — AI answers, captured
            leads, and your shared inbox, all in one place.
          </p>

          <ul className="mt-10 space-y-5">
            {HIGHLIGHTS.map((h) => (
              <li key={h.title} className="flex items-start gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-brand-2 ring-1 ring-white/10 backdrop-blur">
                  <h.icon className="size-5" />
                </span>
                <div>
                  <p className="font-medium text-white">{h.title}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-white/55">
                    {h.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center gap-3 text-sm text-white/55">
          <div className="flex -space-x-2.5">
            {[
              "from-rose-400 to-orange-400",
              "from-sky-400 to-indigo-400",
              "from-emerald-400 to-teal-400",
            ].map((c, i) => (
              <span
                key={i}
                className={`flex size-8 items-center justify-center rounded-full bg-gradient-to-br ${c} text-[10px] font-semibold text-white ring-2 ring-ink`}
              >
                {["JD", "MK", "AL"][i]}
              </span>
            ))}
          </div>
          <span>
            <span className="font-semibold text-white">2,000+</span> support
            teams trust MyChat
          </span>
        </div>
      </section>

      {/* Right: Clerk sign-in on a clean background */}
      <section className="relative flex flex-col items-center justify-center bg-background px-6 py-12 sm:px-10">
        {/* Brand mark for mobile, where the left panel is hidden */}
        <div className="mb-10 lg:hidden">
          <Link href="/" aria-label="MyChat home">
            <BrandMark />
          </Link>
        </div>

        <div className="w-full max-w-sm">
          <SignIn appearance={clerkAppearance} />
        </div>

        <p className="mt-10 text-center text-xs text-muted-foreground">
          By continuing you agree to MyChat&apos;s{" "}
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
