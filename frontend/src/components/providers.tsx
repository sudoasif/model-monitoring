"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  api,
  getAccessToken,
  getWorkspaceId,
  onUnauthorized,
  refreshSession,
  setAccessToken,
  setWorkspaceId,
} from "@/lib/api";
import type { AuthResponse, MeResponse, User, Workspace } from "@/lib/types";

interface AuthContextValue {
  user: User | null;
  workspaces: Workspace[];
  workspace: Workspace | null;
  workspaceId: string | null;
  loading: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: { email: string; password: string; full_name: string; workspace_name: string }) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside Providers");
  return context;
}

function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [user, setUser] = React.useState<User | null>(null);
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceIdState] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const applyMe = React.useCallback((payload: MeResponse) => {
    setUser(payload.user);
    setWorkspaces(payload.workspaces);
    const stored = getWorkspaceId();
    const valid = payload.workspaces.find((workspace) => workspace.id === stored);
    const selected = valid ?? payload.workspaces[0] ?? null;
    if (selected) {
      setWorkspaceId(selected.id);
      setWorkspaceIdState(selected.id);
    } else {
      setWorkspaceIdState(null);
    }
  }, []);

  const reload = React.useCallback(async () => {
    const payload = await api<MeResponse>("/auth/me");
    applyMe(payload);
  }, [applyMe]);

  React.useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        if (!getAccessToken()) {
          const refreshed = await refreshSession();
          if (!refreshed) {
            if (!cancelled) setLoading(false);
            return;
          }
        }
        const payload = await api<MeResponse>("/auth/me");
        if (!cancelled) applyMe(payload);
      } catch {
        if (!cancelled) {
          setAccessToken(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyMe]);

  React.useEffect(() => {
    return onUnauthorized(() => {
      setAccessToken(null);
      setUser(null);
      setWorkspaces([]);
      setLoading(false);
      router.replace("/login");
    });
  }, [router]);

  const login = React.useCallback(
    async (email: string, password: string) => {
      const response = await api<AuthResponse>("/auth/login", {
        method: "POST",
        body: { email, password },
        skipAuth: true,
      });
      setAccessToken(response.access_token);
      const payload = await api<MeResponse>("/auth/me");
      applyMe(payload);
    },
    [applyMe],
  );

  const register = React.useCallback(
    async (payload: { email: string; password: string; full_name: string; workspace_name: string }) => {
      const response = await api<AuthResponse>("/auth/register", {
        method: "POST",
        body: payload,
        skipAuth: true,
      });
      setAccessToken(response.access_token);
      const me = await api<MeResponse>("/auth/me");
      applyMe(me);
    },
    [applyMe],
  );

  const logout = React.useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST", skipAuth: true });
    } catch {
      // Best-effort cookie revocation; local state is still cleared.
    }
    setAccessToken(null);
    setWorkspaceId(null);
    setUser(null);
    setWorkspaces([]);
    queryClient.clear();
    router.replace("/login");
  }, [queryClient, router]);

  const switchWorkspace = React.useCallback(
    (nextWorkspaceId: string) => {
      setWorkspaceId(nextWorkspaceId);
      setWorkspaceIdState(nextWorkspaceId);
      queryClient.clear();
    },
    [queryClient],
  );

  const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0] ?? null;
  const isAdmin = user?.role === "admin" || workspace?.role === "owner" || workspace?.role === "admin";

  const value = React.useMemo<AuthContextValue>(
    () => ({
      user,
      workspaces,
      workspace,
      workspaceId: workspace?.id ?? null,
      loading,
      isAdmin,
      login,
      register,
      logout,
      reload,
      switchWorkspace,
    }),
    [user, workspaces, workspace, loading, isAdmin, login, register, logout, reload, switchWorkspace],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status;
          if (status === 401 || status === 403 || status === 404) return false;
          return failureCount < 2;
        },
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider delayDuration={250}>
          <AuthProvider>{children}</AuthProvider>
          <Toaster richColors closeButton position="top-right" />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
