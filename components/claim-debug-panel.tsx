"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

// ─────────────────────────────────────────────────────────────────────────────
// Dev claim-verification surface (closes the #1 risk: org claim propagation).
//
// Renders the `debug.whoami` query output so the org claims emitted into the
// `convex` JWT template (org_id / org_role / org_slug) can be confirmed live in
// the browser. `hasActiveOrg === true` with non-null orgId/orgRole means the
// claim propagation contract holds end-to-end (Clerk active org → JWT custom
// claims → ctx.auth.getUserIdentity()).
// ─────────────────────────────────────────────────────────────────────────────

export type WhoamiResult = {
  authenticated: boolean;
  subject: string | null;
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
  hasActiveOrg: boolean;
};

function ClaimRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-b-0">
      <span className="text-muted-foreground text-sm font-medium">{label}</span>
      <span className="font-mono text-sm break-all text-right">
        {value === null ? (
          <span className="text-muted-foreground italic">null</span>
        ) : (
          value
        )}
      </span>
    </div>
  );
}

export function ClaimDebugPanel({
  whoami,
}: {
  whoami: WhoamiResult | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Claim verification (dev)</CardTitle>
          {whoami && (
            <Badge variant={whoami.hasActiveOrg ? "default" : "secondary"}>
              {whoami.hasActiveOrg ? "active org" : "no active org"}
            </Badge>
          )}
        </div>
        <CardDescription>
          Live output of <code className="font-mono">debug.whoami</code> — the
          org claims as Convex sees them on the JWT.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {whoami === undefined ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : (
          <div>
            <ClaimRow
              label="authenticated"
              value={String(whoami.authenticated)}
            />
            <ClaimRow label="subject" value={whoami.subject} />
            <ClaimRow label="orgId" value={whoami.orgId} />
            <ClaimRow label="orgRole" value={whoami.orgRole} />
            <ClaimRow label="orgSlug" value={whoami.orgSlug} />
            <ClaimRow
              label="hasActiveOrg"
              value={String(whoami.hasActiveOrg)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
