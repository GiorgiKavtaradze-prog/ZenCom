import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// Same-origin proxy to the Convex `GET /widget-config` HTTP endpoint.
//
// The framework-free `public/loader.js` runs on the CUSTOMER's page and only
// knows the Next.js host it was served from (its <script src> origin) — it has
// NO way to learn the `*.convex.site` URL. Rather than hardcode that into the
// static loader (brittle across deploys), the loader fetches THIS route on the
// same origin, and we forward to Convex server-side using the deployment's
// `NEXT_PUBLIC_CONVEX_*` env. The bubble config is purely cosmetic, so on any
// failure we still return safe defaults with 200 so the loader can render.
//
// CORS '*' so a cross-origin embedding site can call it (the loader fetch is
// cross-origin whenever the customer's page is on a different domain than the
// Next app — which is the normal embed case).
// ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=60",
};

// MUST stay in sync with convex widget.ts DEFAULT_APPEARANCE / http.ts DEFAULT_BUBBLE.
const DEFAULT_BUBBLE = {
  themeColor: "#0F172A",
  buttonColor: "#4F46E5",
  cornerRadius: 16,
  title: "Chat with us",
  titleColor: "#FFFFFF",
  logoUrl: null as string | null,
  position: "bottom-right",
  bottomMargin: 20,
  sideMargin: 20,
  notificationSound: true,
};

// Derive the Convex HTTP site origin (`*.convex.site`) from the public env.
// Prefer an explicit site URL; otherwise convert the `.convex.cloud` deployment
// URL to its `.convex.site` HTTP-actions counterpart.
function convexSiteOrigin(): string | null {
  const explicit = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const cloud = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (cloud) return cloud.replace(/\.convex\.cloud\/?$/, ".convex.site");
  return null;
}

export async function GET(req: NextRequest) {
  const appId = req.nextUrl.searchParams.get("app_id");
  const site = convexSiteOrigin();

  if (!appId || !site) {
    return NextResponse.json(DEFAULT_BUBBLE, { status: 200, headers: CORS });
  }

  try {
    const upstream = await fetch(
      `${site}/widget-config?app_id=${encodeURIComponent(appId)}`,
      { cache: "no-store" },
    );
    const body = await upstream.json();
    return NextResponse.json(body, { status: 200, headers: CORS });
  } catch (err) {
    // Network/parse failure — bubble config is cosmetic; never break the loader.
    console.error("[widget-config proxy] upstream fetch failed:", err);
    return NextResponse.json(DEFAULT_BUBBLE, { status: 200, headers: CORS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
