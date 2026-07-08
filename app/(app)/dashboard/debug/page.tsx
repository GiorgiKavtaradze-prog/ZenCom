import { auth } from "@clerk/nextjs/server";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DebugClaims } from "./DebugClaims";

// ─────────────────────────────────────────────────────────────────────────────
// /dashboard/debug — claim-verification surface (closes the #1 risk).
//
// Two independent views of the same org-claim contract, side by side:
//   • Server-side cross-check: Clerk backend SDK `auth()` (orgId / orgRole /
//     orgSlug) resolved on the server. This is the empirical fallback the
//     blueprint requires — if the `convex` JWT template ever fails to expose
//     {{org.role}}, this still shows the truth from Clerk.
//   • Client/Convex-side: the live `debug.whoami` query, rendered by
//     <DebugClaims> — proves the claim reaches ctx.auth.getUserIdentity().
//
// If these two agree (both show the same non-null orgId/orgRole), the claim
// propagation contract holds end-to-end.
// ─────────────────────────────────────────────────────────────────────────────
export default async function DebugPage() {
  const { userId, orgId, orgRole, orgSlug } = await auth();

  const serverRows: Array<{ label: string; value: string | null }> = [
    { label: "userId", value: userId ?? null },
    { label: "orgId", value: orgId ?? null },
    { label: "orgRole", value: orgRole ?? null },
    { label: "orgSlug", value: orgSlug ?? null },
  ];

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Auth claim verification
        </h1>
        <p className="text-muted-foreground text-sm">
          Confirms the Clerk org claims propagate to both the server (
          <code className="font-mono">auth()</code>) and Convex (
          <code className="font-mono">whoami</code>).
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">
              Server-side cross-check (Clerk <code className="font-mono">auth()</code>)
            </CardTitle>
            <Badge variant={orgId ? "default" : "secondary"}>
              {orgId ? "active org" : "no active org"}
            </Badge>
          </div>
          <CardDescription>
            Resolved on the server via the Clerk backend SDK — the empirical
            fallback if the JWT template misbehaves.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div>
            {serverRows.map((row) => (
              <div
                key={row.label}
                className="flex items-start justify-between gap-4 border-b py-2 last:border-b-0"
              >
                <span className="text-muted-foreground text-sm font-medium">
                  {row.label}
                </span>
                <span className="font-mono text-sm break-all text-right">
                  {row.value === null ? (
                    <span className="text-muted-foreground italic">null</span>
                  ) : (
                    row.value
                  )}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Live Convex-side claims (debug.whoami). */}
      <DebugClaims />
    </div>
  );
}
