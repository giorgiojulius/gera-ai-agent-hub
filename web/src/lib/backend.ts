// Shared client for the Gera backend Worker — one base URL, one
// Bearer-token fetch with a single refresh retry, one error parser.
import { getAccessToken, refreshAccessToken } from "@/lib/auth-tokens";

export const FUNCTIONS_URL: string = (() => {
  const url = import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL;
  if (typeof url === "string" && url.length > 0) {
    return url.replace(/\/+$/, "");
  }
  return "https://gera-ai-agent-hub-backend.rork.app";
})();

/** Fetch with the stored Bearer token; retries once after a token refresh on 401. */
export async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const attempt = (token: string | null) =>
    fetch(`${FUNCTIONS_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  let response = await attempt(getAccessToken());
  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      response = await attempt(refreshed);
    }
  }
  return response;
}

/** Resolves the JSON body, or throws the backend's error code / a fallback. */
export async function parseOrThrow<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${fallback} (${response.status})`);
  }
  return (await response.json()) as T;
}
