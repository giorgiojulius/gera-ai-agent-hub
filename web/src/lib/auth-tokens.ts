// Shared Rork Auth token storage — used by the auth hook and the access API
// client so a mid-session token refresh works from either side.

export const ACCESS_TOKEN_KEY = "rork:access_token";
export const REFRESH_TOKEN_KEY = "rork:refresh_token";
export const CODE_VERIFIER_KEY = "rork:pkce_verifier";

export const AUTH_URL: string = import.meta.env.EXPO_PUBLIC_RORK_AUTH_URL ?? "";
export const APP_KEY: string = import.meta.env.EXPO_PUBLIC_RORK_APP_KEY ?? "";

export function getAccessToken(): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function clearTokens(): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(CODE_VERIFIER_KEY);
}

/**
 * Exchanges the stored refresh token for a fresh access token.
 * Returns the new token, or null when refresh is impossible/rejected.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (typeof localStorage === "undefined") {
    return null;
  }
  const refresh = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refresh || !AUTH_URL || !APP_KEY) {
    return null;
  }
  try {
    const response = await fetch(`${AUTH_URL}/oauth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: APP_KEY, refresh_token: refresh }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { access_token?: unknown };
    if (typeof data.access_token === "string" && data.access_token.length > 0) {
      localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token);
      return data.access_token;
    }
    return null;
  } catch {
    return null;
  }
}
