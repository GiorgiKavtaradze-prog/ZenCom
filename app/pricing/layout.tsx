import { ClerkProvider } from "@clerk/nextjs";

// The pricing page lives OUTSIDE the (app) group (root layout is Clerk-free so
// the widget can run anonymously). Clerk's <PricingTable> / <CheckoutButton> /
// <Show> still need ClerkProvider context, so we wrap just this route. This does
// NOT gate viewing — the page is public (proxy.ts doesn't protect /pricing);
// ClerkProvider only enables the billing components + signed-in/out branches.
export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ClerkProvider>{children}</ClerkProvider>;
}
