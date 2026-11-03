import * as React from "react";

import { AppShell } from "@/components/app-shell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
          Loading workspace…
        </div>
      }
    >
      <AppShell>{children}</AppShell>
    </React.Suspense>
  );
}
