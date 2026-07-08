import type { ReactNode } from "react";

// Shared placeholder for dashboard routes whose real pages land in later phases.
// Keeps every nav target resolvable so the sidebar never dead-links.
export function ComingSoon({
  title,
  description,
  icon,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="grid min-h-[calc(100svh-3.5rem)] place-items-center p-6">
      <div className="flex max-w-md flex-col items-center text-center">
        {icon ? (
          <div className="bg-muted text-muted-foreground mb-4 grid size-12 place-items-center rounded-xl">
            {icon}
          </div>
        ) : null}
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {description ?? "This section is coming soon."}
        </p>
      </div>
    </div>
  );
}
