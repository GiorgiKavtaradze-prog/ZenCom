import Link from "next/link";
import { ArrowLeft, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "./_components/brand-mark";

export default function NotFound() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-ink px-6 text-center text-white">
      {/* Aurora backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="animate-aurora absolute -top-32 left-1/4 size-[32rem] rounded-full bg-brand/40 blur-[130px]" />
        <div
          className="animate-aurora absolute bottom-0 right-1/4 size-[28rem] rounded-full bg-brand-2/30 blur-[130px]"
          style={{ animationDelay: "-7s" }}
        />
      </div>
      <div
        aria-hidden
        className="bg-dotgrid pointer-events-none absolute inset-0 opacity-[0.15] [mask-image:radial-gradient(60%_50%_at_50%_40%,black,transparent)]"
      />

      <div className="relative">
        <Link href="/" aria-label="MyChat home" className="inline-block">
          <BrandMark wordClassName="text-white" />
        </Link>

        <p className="text-gradient mt-10 text-7xl font-semibold tracking-tight sm:text-8xl">
          404
        </p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
          This page wandered off
        </h1>
        <p className="mx-auto mt-3 max-w-md text-pretty text-white/60">
          The page you&apos;re looking for doesn&apos;t exist or has moved. Let&apos;s
          get you back on track.
        </p>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button
            asChild
            size="lg"
            className="h-12 w-full rounded-full bg-gradient-to-br from-brand to-brand-2 px-7 text-white shadow-[0_10px_40px_-10px_var(--brand)] hover:opacity-95 sm:w-auto"
          >
            <Link href="/">
              <Home className="size-4" />
              Back home
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            className="h-12 w-full rounded-full border-white/20 bg-white/5 px-7 text-white hover:bg-white/10 hover:text-white sm:w-auto"
          >
            <Link href="/dashboard">
              <ArrowLeft className="size-4" />
              Go to dashboard
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
