"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BrandMark } from "./brand-mark";

const NAV = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how" },
  { label: "Pricing", href: "/pricing" },
];

/**
 * Marketing header. Transparent (light text) while over the dark hero, then
 * settles into a frosted-glass bar with dark text once the user scrolls past it.
 */
export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-border/70 bg-background/80 backdrop-blur-xl"
          : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-6">
        <Link href="/" aria-label="MyChat home">
          <BrandMark
            wordClassName={cn(
              "transition-colors",
              scrolled ? "text-foreground" : "text-white",
            )}
          />
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "rounded-full px-3.5 py-2 text-sm font-medium transition-colors",
                scrolled
                  ? "text-muted-foreground hover:text-foreground hover:bg-accent"
                  : "text-white/70 hover:text-white hover:bg-white/10",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className={cn(
              "hidden sm:inline-flex",
              !scrolled &&
                "text-white hover:bg-white/10 hover:text-white",
            )}
          >
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button
            asChild
            size="sm"
            className="group hidden rounded-full bg-gradient-to-br from-brand to-brand-2 text-white shadow-[0_6px_20px_-6px_var(--brand)] hover:opacity-95 sm:inline-flex"
          >
            <Link href="/sign-up">
              Start free
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-lg transition-colors md:hidden",
              scrolled
                ? "text-foreground hover:bg-accent"
                : "text-white hover:bg-white/10",
            )}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="border-t border-border/70 bg-background/95 backdrop-blur-xl md:hidden">
          <nav className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-5 py-4">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button
                asChild
                size="sm"
                className="bg-gradient-to-br from-brand to-brand-2 text-white"
              >
                <Link href="/sign-up">Start free</Link>
              </Button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
