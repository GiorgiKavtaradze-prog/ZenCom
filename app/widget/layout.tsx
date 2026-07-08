import type { Viewport } from "next";
import { WidgetProvider } from "./WidgetProvider";

// Separate from the dashboard's Clerk layout — this renders inside an iframe
// on third-party sites and must not depend on a Clerk session.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function WidgetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <WidgetProvider>{children}</WidgetProvider>;
}
