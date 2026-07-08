import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { OrgGuard } from "./OrgGuard";
import { DashboardSidebar } from "./DashboardSidebar";

// Modern shadcn sidebar shell for the whole dashboard. The OrgGuard still wraps
// the content so org-less / unprovisioned users are routed to /onboarding before
// any dashboard UI renders. Toaster + TooltipProvider are mounted one level up
// in the app-group layout so they're available across sign-in/up too.
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <DashboardSidebar />
      <SidebarInset>
        <header className="bg-background/80 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 backdrop-blur-md lg:px-6">
          <SidebarTrigger className="-ml-1.5 text-muted-foreground" />
          <Separator
            orientation="vertical"
            className="data-[orientation=vertical]:h-5"
          />
          <span className="text-sm font-semibold tracking-tight">
            Dashboard
          </span>
        </header>
        <OrgGuard>{children}</OrgGuard>
      </SidebarInset>
    </SidebarProvider>
  );
}
