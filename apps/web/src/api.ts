export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly body?: unknown) {
    super(`${status} ${code}`);
  }
}

export interface Api {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function createApi(options: { getToken: () => string | null; onUnauthorized: () => void; fetchImpl?: typeof fetch }): Api {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = options.getToken();
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await doFetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), cache: "no-store" });
    } catch {
      throw new ApiError(0, "network_error");
    }
    let parsed: unknown = null;
    try { parsed = await response.json(); } catch { /* non-JSON body */ }
    if (!response.ok) {
      const code = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : "http_error";
      if (response.status === 401) options.onUnauthorized();
      throw new ApiError(response.status, code, parsed);
    }
    return parsed as T;
  }
  return {
    get: (path, params) => {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") query.set(k, String(v));
      const qs = query.toString();
      return request("GET", qs ? `${path}?${qs}` : path);
    },
    post: (path, body) => request("POST", path, body),
  };
}

export function describeError(error: unknown): { title: string; detail: string } {
  if (error instanceof ApiError) {
    if (error.status === 0) return { title: "Cannot reach the backend", detail: "The request did not complete. Check the connection and try again." };
    if (error.status === 401) return { title: "Locked", detail: "The access token was rejected." };
    if (error.code === "api_auth_not_configured") return { title: "Backend has no access token configured", detail: "The server refuses all API calls until API_BEARER_TOKEN is set." };
    if (error.code === "database_not_configured") return { title: "Backend has no database configured", detail: "The API is running without a database, so there are no records to show." };
    if (error.status === 404) return { title: "Not found", detail: "That record does not exist." };
    return { title: `Backend error (${error.status})`, detail: error.code };
  }
  return { title: "Unexpected error", detail: error instanceof Error ? error.message : String(error) };
}
