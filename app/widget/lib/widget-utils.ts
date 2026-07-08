"use client";

import type { CSSProperties } from "react";

// Persisted anonymous identity (matches the legacy widget's keys so returning
// visitors keep their conversation).
export function loadOrMint(key: string, make: () => string): string {
  let v = localStorage.getItem(key);
  if (!v) {
    v = make();
    localStorage.setItem(key, v);
  }
  return v;
}

export const VISITOR_ID_KEY = "mychat_visitor_id";
export const VISITOR_NAME_KEY = "mychat_visitor_name";

export type WidgetAppearance = {
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

// Build the inline CSS custom properties that theme the whole widget. Every
// component reads these vars (var(--wc-theme) etc.) so the customizer's
// appearance fully drives the look without recompiling Tailwind.
export function appearanceVars(a: WidgetAppearance): CSSProperties {
  return {
    // The header/accent color.
    ["--wc-theme" as string]: a.themeColor,
    // The send button / primary action color.
    ["--wc-button" as string]: a.buttonColor,
    // Header text/icon color.
    ["--wc-title" as string]: a.titleColor,
    // Outer corner radius (clamped server-side 0–32).
    ["--wc-radius" as string]: `${a.cornerRadius}px`,
  };
}
