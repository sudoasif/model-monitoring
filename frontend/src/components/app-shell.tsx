"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Activity,
  Aperture,
  BellRing,
  Boxes,
  BrainCircuit,
  ChevronsLeft,
  ChevronsRight,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorCheck,
  Moon,
  PackageCheck,
  Rocket,
  Settings,
  Sun,
  UserRound,
  Workflow,
  X,
} from "lucide-react";

import { Badge, Button, Spinner } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { Hint } from "@/components/ui/tooltip";
import { useAuth } from "@/components/providers";
import { useAlertSummary, useDemoStatus } from "@/lib/hooks";
import { cn, titleCase } from "@/lib/utils";

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ href: string; label: string; icon: React.ComponentType<{ className?: string }> }>;
}> = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/experiments", label: "Experiments", icon: FlaskConical },
      { href: "/registry", label: "Model Registry", icon: PackageCheck },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/deployments", label: "Deployments", icon: Rocket },
      { href: "/monitoring", label: "Monitoring", icon: Activity },
      { href: "/explainability", label: "Explainability", icon: BrainCircuit },
      { href: "/alerts", label: "Alerts & Incidents", icon: BellRing },
      { href: "/pipelines", label: "Pipelines", icon: Workflow },
    ],
  },
  {
    label: "System",
    items: [{ href: "/settings", label: "Settings", icon: Settings }],
  },
];

const TITLES: Record<string, string> = {
  "/": "Overview",
  "/projects": "Projects",
  "/experiments": "Experiments",
  "/registry": "Model Registry",
  "/deployments": "Deployments",
  "/monitoring": "Monitoring",
  "/explainability": "Explainability",
  "/alerts": "Alerts & Incidents",
  "/pipelines": "Pipelines",
  "/settings": "Settings",
};

function sectionTitle(pathname: string): string {
  if (pathname === "/") return "Overview";
  const root = `/${pathname.split("/")[1] ?? ""}`;
  return TITLES[root] ?? titleCase(pathname.split("/")[1] ?? "");
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5 overflow-hidden" aria-label="Aperture home">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(135deg,var(--primary),var(--chart-2))] text-white shadow-sm">
        <Aperture className="size-4.5" strokeWidth={2.2} />
      </span>
      {!collapsed ? (
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold tracking-tight">Aperture</span>
          <span className="block truncate text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">MLOps control plane</span>
        </span>
      ) : null}
    </Link>
  );
}

function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { workspaces, workspace, switchWorkspace } = useAuth();
  if (!workspace) return null;
  if (collapsed) {
    return (
      <Hint label={`${workspace.name} · ${workspace.role}`}>
        <div className="mx-auto flex size-8 items-center justify-center rounded-md border bg-card text-[10px] font-semibold uppercase">
          {workspace.name.slice(0, 2)}
        </div>
      </Hint>
    );
  }
  return (
    <div className="px-2">
      <label htmlFor="workspace-switcher" className="sr-only">
        Workspace
      </label>
      <select
        id="workspace-switcher"
        value={workspace.id}
        onChange={(event) => switchWorkspace(event.target.value)}
        className="h-8 w-full rounded-md border border-sidebar-border bg-card px-2 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {workspaces.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <p className="mt-1 px-1 text-[10px] text-muted-foreground">
        {titleCase(workspace.role)} access · {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function SidebarContent({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data: alertSummary } = useAlertSummary(30);
  const { data: demo } = useDemoStatus();
  const openAlerts = alertSummary?.unacknowledged ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex h-14 items-center border-b border-sidebar-border", collapsed ? "justify-center px-2" : "px-4")}>
        <Brand collapsed={collapsed} />
      </div>
      <div className={cn("py-3", collapsed ? "px-1.5" : "")}>
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-2 pb-4" aria-label="Primary">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {!collapsed ? (
              <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{group.label}</p>
            ) : (
              <div className="mx-2 mb-2 h-px bg-sidebar-border" />
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                const Icon = item.icon;
                const badge = item.href === "/alerts" && openAlerts > 0 ? openAlerts : null;
                const link = (
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                      collapsed && "justify-center px-0 py-2",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {!collapsed ? <span className="flex-1 truncate">{item.label}</span> : null}
                    {badge && !collapsed ? (
                      <span className="rounded-full bg-destructive/12 px-1.5 text-[10px] font-semibold text-destructive">{badge}</span>
                    ) : null}
                    {badge && collapsed ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive" /> : null}
                  </Link>
                );
                return (
                  <li key={item.href} className="relative">
                    {collapsed ? <Hint label={item.label}>{link}</Hint> : link}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className={cn("border-t border-sidebar-border p-3", collapsed && "px-2")}>
        {demo?.demo_mode && !collapsed ? (
          <div className="mb-2 rounded-md border border-dashed px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium">
              <span className="size-1.5 rounded-full bg-warning" />
              Demo mode enabled
            </div>
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">Synthetic traffic only starts when requested.</p>
          </div>
        ) : null}
        <div className={cn("flex items-center gap-2 text-[10px] text-muted-foreground", collapsed && "justify-center")}>
          <span className="size-1.5 rounded-full bg-success" />
          {!collapsed ? <span className="truncate">API connected</span> : null}
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, workspace, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => setMounted(true), []);
  React.useEffect(() => {
    const stored = window.localStorage.getItem("aperture.sidebar_collapsed");
    if (stored === "1") setCollapsed(true);
  }, []);
  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((current) => {
      window.localStorage.setItem("aperture.sidebar_collapsed", current ? "0" : "1");
      return !current;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading workspace…
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Redirecting to sign in…
        </div>
      </div>
    );
  }

  const initials = (user.full_name || user.email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <div className="min-h-screen bg-background">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex lg:flex-col",
          collapsed ? "w-[68px]" : "w-60",
        )}
      >
        <SidebarContent collapsed={collapsed} />
        <button
          type="button"
          onClick={toggleCollapsed}
          className="absolute -right-3 top-16 flex size-6 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronsRight className="size-3" /> : <ChevronsLeft className="size-3" />}
        </button>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-sidebar text-sidebar-foreground shadow-2xl">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-2 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-muted"
              aria-label="Close navigation"
            >
              <X className="size-4" />
            </button>
            <SidebarContent collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className={cn("flex min-h-screen flex-col transition-[padding] duration-200", collapsed ? "lg:pl-[68px]" : "lg:pl-60")}>
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-md sm:px-6">
          <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">Workspace</span>
            <span className="hidden text-xs text-muted-foreground/60 sm:inline">/</span>
            <span className="truncate text-sm font-medium">{sectionTitle(pathname)}</span>
            {workspace ? <Badge tone="muted" className="hidden md:inline-flex">{titleCase(workspace.role)}</Badge> : null}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Hint label="Toggle theme">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                aria-label="Toggle color theme"
              >
                {mounted && theme === "dark" ? <Sun /> : <Moon />}
              </Button>
            </Hint>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="ml-1 flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  aria-label="Account menu"
                >
                  <span className="flex size-6 items-center justify-center rounded-full bg-primary/12 text-[10px] font-semibold text-primary">{initials || <UserRound className="size-3" />}</span>
                  <span className="hidden max-w-28 truncate text-xs font-medium sm:block">{user.full_name || user.email}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <span className="block truncate text-xs font-medium text-foreground">{user.full_name}</span>
                  <span className="block truncate font-normal">{user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <UserRound /> Account & workspace
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings?tab=members">
                    <Boxes /> Members & access
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void logout()} className="text-destructive focus:text-destructive">
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 px-4 py-5 sm:px-6 lg:py-6">
          <div className="mx-auto w-full max-w-[1500px] animate-fade-in">{children}</div>
        </main>
        <footer className="border-t px-6 py-3 text-[10px] text-muted-foreground">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-2">
            <span>Aperture MLOps · human approval required for promotion and deployment</span>
            <span className="flex items-center gap-1.5">
              <MonitorCheck className="size-3" /> Local-first reference deployment
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
