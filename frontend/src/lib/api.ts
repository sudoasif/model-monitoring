export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api").replace(/\/$/, "");

const ACCESS_KEY = "aperture.access_token";
const WORKSPACE_KEY = "aperture.workspace_id";
const UNAUTHORIZED_EVENT = "aperture:unauthorized";

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(message: string, status: number, code = "request_failed", details: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACCESS_KEY);
}

export function setAccessToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(ACCESS_KEY, token);
  else window.localStorage.removeItem(ACCESS_KEY);
}

export function getWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(WORKSPACE_KEY);
}

export function setWorkspaceId(workspaceId: string | null): void {
  if (typeof window === "undefined") return;
  if (workspaceId) window.localStorage.setItem(WORKSPACE_KEY, workspaceId);
  else window.localStorage.removeItem(WORKSPACE_KEY);
}

export function notifyUnauthorized(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
}

export function onUnauthorized(handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  skipAuth?: boolean;
  retry?: boolean;
  rawBody?: BodyInit;
};

let refreshInFlight: Promise<boolean> | null = null;

export async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { access_token?: string };
      if (!payload.access_token) return false;
      setAccessToken(payload.access_token);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

async function parseError(response: Response): Promise<ApiError> {
  let message = `Request failed (${response.status})`;
  let code = "request_failed";
  let details: unknown = null;
  try {
    const payload = await response.json();
    const body = payload?.error ?? payload;
    if (typeof body?.message === "string") message = body.message;
    else if (typeof payload?.detail === "string") message = payload.detail;
    else if (Array.isArray(payload?.detail) && payload.detail[0]?.msg) message = payload.detail[0].msg;
    code = body?.code ?? code;
    details = body?.details ?? payload?.detail ?? null;
  } catch {
    // The response was not JSON; keep the status-based message.
  }
  if (response.status === 429) message = message || "Too many requests. Please slow down and retry.";
  return new ApiError(message, response.status, code, details);
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipAuth, retry = true, rawBody, headers, ...rest } = options;
  const finalHeaders = new Headers(headers);
  finalHeaders.set("Accept", "application/json");
  if (!isFormData(body) && !rawBody && body !== undefined) {
    finalHeaders.set("Content-Type", "application/json");
  }
  const token = getAccessToken();
  if (token && !skipAuth) finalHeaders.set("Authorization", `Bearer ${token}`);
  const workspaceId = getWorkspaceId();
  if (workspaceId) finalHeaders.set("X-Workspace-Id", workspaceId);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: finalHeaders,
      credentials: "include",
      cache: "no-store",
      body: rawBody ?? (body === undefined ? undefined : isFormData(body) ? body : JSON.stringify(body)),
    });
  } catch {
    throw new ApiError(
      "Cannot reach the API. Check that the backend is running and NEXT_PUBLIC_API_URL is correct.",
      0,
      "network_error",
    );
  }

  if (
    response.status === 401 &&
    retry &&
    !skipAuth &&
    !path.startsWith("/auth/login") &&
    !path.startsWith("/auth/register") &&
    !path.startsWith("/auth/refresh")
  ) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return api<T>(path, { ...options, retry: false });
    }
    notifyUnauthorized();
  }

  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function apiDownload(path: string): Promise<{ blob: Blob; filename: string }> {
  const headers = new Headers();
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const workspaceId = getWorkspaceId();
  if (workspaceId) headers.set("X-Workspace-Id", workspaceId);
  const response = await fetch(`${API_BASE}${path}`, { headers, credentials: "include" });
  if (!response.ok) throw await parseError(response);
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|"?)([^";]+)/i.exec(disposition);
  return { blob, filename: match ? decodeURIComponent(match[1].replace(/"/g, "")) : "download" };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}

export function errorDetails(error: unknown): string | null {
  if (error instanceof ApiError && error.details) {
    try {
      return JSON.stringify(error.details, null, 2);
    } catch {
      return String(error.details);
    }
  }
  return null;
}
