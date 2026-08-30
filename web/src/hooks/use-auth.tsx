import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { clearLocalAccountState } from "@/lib/history";
import { clearMcpSessionCache } from "@/lib/mcp";
import { invalidateOAuthOperations } from "@/lib/mcp-oauth";
import {
  ACCESS_TOKEN_KEY,
  APP_KEY,
  AUTH_URL,
  CODE_VERIFIER_KEY,
  REFRESH_TOKEN_KEY,
  clearTokens,
  refreshAccessToken,
} from "@/lib/auth-tokens";

const ACCOUNT_OWNER_KEY = "rork:gera_account_owner";

export type AuthUser = {
  id: string;
  email: string;
  name?: string;
  picture?: string;
};

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decodes a base64url segment into UTF-8 text — atob alone mangles non-ASCII (e.g. Cyrillic names). */
function decodeBase64UrlUtf8(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Decodes the JWT payload for display identity and expiry checking. */
function userFromToken(token: string): AuthUser | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const payload = JSON.parse(decodeBase64UrlUtf8(parts[1])) as {
      sub?: string;
      email?: string;
      name?: string;
      picture?: string;
      exp?: number;
    };
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return null;
    }
    if (!payload.sub) {
      return null;
    }
    return {
      id: payload.sub,
      email: payload.email ?? "",
      name: payload.name,
      picture: payload.picture,
    };
  } catch {
    return null;
  }
}

type AuthContextType = {
  user: AuthUser | null;
  isLoading: boolean;
  isSigningIn: boolean;
  error: string | null;
  signIn: (provider: "google" | "apple") => Promise<void>;
  signOut: () => void;
  clearError: () => void;
  /** Exchanges a `code` for tokens — the production /auth/callback route calls this. */
  exchangeCode: (code: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const messageListenerRef = useRef<((event: MessageEvent) => void) | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const signOut = useCallback(() => {
    // GitHub/MCP credentials, private repo names, chats, and profile clocks
    // are account-scoped. Nothing from this identity may survive into the next.
    invalidateOAuthOperations();
    clearMcpSessionCache();
    clearLocalAccountState();
    localStorage.removeItem(ACCOUNT_OWNER_KEY);
    clearTokens();
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
        if (accessToken) {
          const decoded = userFromToken(accessToken);
          if (decoded) {
            if (!cancelled) {
              localStorage.setItem(ACCOUNT_OWNER_KEY, decoded.id);
              setUser(decoded);
            }
            return;
          }
        }
        if (localStorage.getItem(REFRESH_TOKEN_KEY)) {
          const refreshed = await refreshAccessToken();
          if (!cancelled) {
            if (refreshed) {
              const decoded = userFromToken(refreshed);
              if (decoded) {
                localStorage.setItem(ACCOUNT_OWNER_KEY, decoded.id);
              }
              setUser(decoded);
            } else {
              clearTokens();
              setUser(null);
            }
          }
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (messageListenerRef.current) {
        window.removeEventListener("message", messageListenerRef.current);
        messageListenerRef.current = null;
      }
    };
  }, []);

  const exchangeCode = useCallback(async (code: string) => {
    const verifier = localStorage.getItem(CODE_VERIFIER_KEY);
    if (!verifier) {
      setError("Sign-in session expired — please try again.");
      return;
    }
    localStorage.removeItem(CODE_VERIFIER_KEY);

    const response = await fetch(`${AUTH_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: APP_KEY, code, code_verifier: verifier }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `Sign in failed (${response.status})`);
      return;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      user: AuthUser;
    };
    // A different identity starts from a clean browser copy, then pulls only
    // its cloud state. Re-authenticating the same account keeps unsynced local
    // drafts/queue instead of destroying them.
    const nextUser = data.user ?? userFromToken(data.access_token);
    const previousOwner = localStorage.getItem(ACCOUNT_OWNER_KEY);
    clearMcpSessionCache();
    if (previousOwner && nextUser && previousOwner !== nextUser.id) {
      invalidateOAuthOperations();
      clearLocalAccountState();
    }
    if (nextUser) {
      localStorage.setItem(ACCOUNT_OWNER_KEY, nextUser.id);
    }
    localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token);
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
    setUser(nextUser);
  }, []);

  const signIn = useCallback(
    async (provider: "google" | "apple") => {
      setIsSigningIn(true);
      setError(null);
      try {
        const verifier = generateCodeVerifier();
        const challenge = await generateCodeChallenge(verifier);
        // Persist across the OAuth roundtrip — the popup closes and the
        // production flow navigates away and back.
        localStorage.setItem(CODE_VERIFIER_KEY, verifier);

        const isPreview = window.parent !== window;
        const body: Record<string, unknown> = {
          app_key: APP_KEY,
          provider,
          code_challenge: challenge,
          target: "web",
          env: isPreview ? "preview" : "production",
        };
        if (isPreview) {
          body.app_path = "web";
        }

        const response = await fetch(`${AUTH_URL}/oauth/initiate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          localStorage.removeItem(CODE_VERIFIER_KEY);
          const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
          setError(errorBody.error ?? `Sign in failed (${response.status})`);
          return;
        }

        const { auth_url: authUrl } = (await response.json()) as { auth_url: string };

        if (isPreview) {
          const popup = window.open(authUrl, "_blank", "width=500,height=650");
          if (!popup) {
            setError("Popup blocked — please allow popups for this site.");
            localStorage.removeItem(CODE_VERIFIER_KEY);
            return;
          }

          await new Promise<void>((resolve) => {
            const onMessage = (event: MessageEvent) => {
              const payload = event.data as { type?: string; code?: string } | null;
              if (!payload || payload.type !== "rork_auth_callback") {
                return;
              }
              window.removeEventListener("message", onMessage);
              messageListenerRef.current = null;
              clearInterval(pollTimer);
              const finish = async () => {
                if (payload.code) {
                  await exchangeCode(payload.code);
                }
                resolve();
              };
              void finish();
            };
            messageListenerRef.current = onMessage;
            window.addEventListener("message", onMessage);

            const pollTimer = window.setInterval(() => {
              if (popup.closed) {
                clearInterval(pollTimer);
                window.removeEventListener("message", onMessage);
                messageListenerRef.current = null;
                localStorage.removeItem(CODE_VERIFIER_KEY);
                resolve();
              }
            }, 500);
          });
        } else {
          window.location.href = authUrl;
        }
      } catch (err) {
        console.error("Sign in failed:", err);
        setError(err instanceof Error ? err.message : "Sign in failed");
        localStorage.removeItem(CODE_VERIFIER_KEY);
      } finally {
        setIsSigningIn(false);
      }
    },
    [exchangeCode],
  );

  const value = useMemo<AuthContextType>(
    () => ({ user, isLoading, isSigningIn, error, signIn, signOut, clearError, exchangeCode }),
    [user, isLoading, isSigningIn, error, signIn, signOut, clearError, exchangeCode],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
