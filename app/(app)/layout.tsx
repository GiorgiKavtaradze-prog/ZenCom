import { Providers } from "./Providers";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

// All routes in this group (dashboard, sign-in, sign-up) get Clerk + Convex.
// TooltipProvider + the sonner <Toaster/> are mounted here so tooltips and
// toast notifications are available everywhere inside the app group.
export default function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <TooltipProvider delayDuration={200}>
        {children}
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </Providers>
  );
}
