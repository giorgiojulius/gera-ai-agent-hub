import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { clearLocalAccountState } from "@/lib/history";
import { clearMcpSessionCache } from "@/lib/mcp";
import { invalidateOAuthOperations } from "@/lib/mcp-oauth";
import {
  ACCESS_TOKEN_KEY,
  APP_KEY,
  AUTH_FLOW_ATTEMPT_KEY,
  AUTH_FLOW_NONCE_KEY,
  AUTH_SESSION_NONCE_KEY,
  AUTH_URL,
  CODE_VERIFIER_KEY,
  REFRESH_TOKEN_KEY,
  authSessionSnapshot,
  clearTokens,
  invalidateAuthSession,
  isAuthSessionCurrent,
  refreshAccessTokenResult,
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

function isAuthFlowCurrent(attemptId: string, sessionNonce: string): boolean {
  return (
    attemptId.length > 0 &&
    sessionStorage.getItem(AUTH_FLOW_ATTEMPT_KEY) === attemptId &&
    isAuthSessionCurrent(sessionNonce)
  );
}

function clearAuthFlowIfCurrent(attemptId: string): void {
  if (sessionStorage.getItem(AUTH_FLOW_ATTEMPT_KEY) !== attemptId) {
    return;
  }
  sessionStorage.removeItem(CODE_VERIFIER_KEY);
  sessionStorage.removeItem(AUTH_FLOW_NONCE_KEY);
  sessionStorage.removeItem(AUTH_FLOW_ATTEMPT_KEY);
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
function userFromToken(token: string, allowExpired: boolean = false): AuthUser | null {
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
    if (!allowExpired && payload.exp && payload.exp * 1000 < Date.now()) {
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

function bindLocalStateToAccount(nextUser: AuthUser): void {
  const previousOwner = localStorage.getItem(ACCOUNT_OWNER_KEY);
  if (previousOwner && previousOwner !== nextUser.id) {
    invalidateAuthSession();
    invalidateOAuthOperations();
    clearMcpSessionCache();
    clearLocalAccountState();
  }
  localStorage.setItem(ACCOUNT_OWNER_KEY, nextUser.id);
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
  const signInAttemptRef = useRef<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const signOut = useCallback(() => {
    // GitHub/MCP credentials, private repo names, chats, and profile clocks
    // are account-scoped. Nothing from this identity may survive into the next.
    invalidateAuthSession();
    invalidateOAuthOperations();
    clearMcpSessionCache();
    clearLocalAccountState();
    localStorage.removeItem(ACCOUNT_OWNER_KEY);
    clearTokens();
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    const bootSession = authSessionSnapshot();
    const scheduleRetry = (): void => {
      if (cancelled || retryTimer !== null) {
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void boot();
      }, 5_000);
    };
    const boot = async (): Promise<void> => {
      try {
        const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
        const decoded = accessToken ? userFromToken(accessToken) : null;
        if (decoded) {
          if (!cancelled && isAuthSessionCurrent(bootSession)) {
            bindLocalStateToAccount(decoded);
            setUser(decoded);
          }
          return;
        }
        const staleIdentity = accessToken ? userFromToken(accessToken, true) : null;
        if (localStorage.getItem(REFRESH_TOKEN_KEY)) {
          const result = await refreshAccessTokenResult();
          if (!cancelled && isAuthSessionCurrent(bootSession)) {
            const renewed = result.status === "refreshed" ? userFromToken(result.accessToken) : null;
            if (renewed) {
              bindLocalStateToAccount(renewed);
              setUser(renewed);
            } else if (result.status === "rejected") {
              // Only an explicit invalid/revoked refresh grant signs out. A
              // deploy-time network/5xx gap keeps both tokens and retries.
              clearTokens();
              setUser(null);
            } else {
              if (staleIdentity) {
                // An expired JWT is identity context only; every server request
                // still requires a freshly platform-verified token.
                bindLocalStateToAccount(staleIdentity);
                setUser(staleIdentity);
              }
              scheduleRetry();
            }
          }
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    const onOnline = (): void => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      void boot();
    };
    window.addEventListener("online", onOnline);
    void boot();
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === AUTH_SESSION_NONCE_KEY) {
        invalidateOAuthOperations();
        clearMcpSessionCache();
      }
      if (event.key === ACCESS_TOKEN_KEY) {
        setUser(event.newValue ? userFromToken(event.newValue) : null);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      if (messageListenerRef.current) {
        window.removeEventListener("message", messageListenerRef.current);
        messageListenerRef.current = null;
      }
    };
  }, []);

  const exchangeCode = useCallback(async (code: string, expectedAttemptId?: string) => {
    const verifier = sessionStorage.getItem(CODE_VERIFIER_KEY);
    const flowNonce = sessionStorage.getItem(AUTH_FLOW_NONCE_KEY) ?? "";
    const attemptId = sessionStorage.getItem(AUTH_FLOW_ATTEMPT_KEY) ?? "";
    if (
      !verifier ||
      !isAuthFlowCurrent(attemptId, flowNonce) ||
      (expectedAttemptId !== undefined && expectedAttemptId !== attemptId)
    ) {
      setError("Sign-in session expired — please try again.");
      return;
    }

    const response = await fetch(`${AUTH_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: APP_KEY, code, code_verifier: verifier }),
    });
    if (!isAuthFlowCurrent(attemptId, flowNonce)) {
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (isAuthFlowCurrent(attemptId, flowNonce)) {
        setError(body.error ?? `Sign in failed (${response.status})`);
        clearAuthFlowIfCurrent(attemptId);
      }
      return;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      user: AuthUser;
    };
    if (!isAuthFlowCurrent(attemptId, flowNonce)) {
      return;
    }
    const nextUser = data.user ?? userFromToken(data.access_token);
    if (!nextUser) {
      setError("Sign in returned no account identity — please try again.");
      clearAuthFlowIfCurrent(attemptId);
      return;
    }
    // Every successful exchange starts a fresh async boundary. A different
    // identity also starts from an empty browser copy and pulls only its cloud state.
    const previousOwner = localStorage.getItem(ACCOUNT_OWNER_KEY);
    clearAuthFlowIfCurrent(attemptId);
    invalidateAuthSession();
    invalidateOAuthOperations();
    clearMcpSessionCache();
    if (previousOwner !== nextUser.id) {
      clearLocalAccountState();
    }
    localStorage.setItem(ACCOUNT_OWNER_KEY, nextUser.id);
    localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token);
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
    setUser(nextUser);
  }, []);

  const signIn = useCallback(
    async (provider: "google" | "apple") => {
      setIsSigningIn(true);
      setError(null);
      const flowNonce = authSessionSnapshot();
      const attemptId = generateCodeVerifier();
      signInAttemptRef.current = attemptId;
      try {
        const verifier = generateCodeVerifier();
        const challenge = await generateCodeChallenge(verifier);
        if (!isAuthSessionCurrent(flowNonce) || signInAttemptRef.current !== attemptId) {
          return;
        }
        // Persist across the OAuth roundtrip — the popup closes and the
        // production flow navigates away and back.
        sessionStorage.setItem(CODE_VERIFIER_KEY, verifier);
        sessionStorage.setItem(AUTH_FLOW_NONCE_KEY, flowNonce);
        sessionStorage.setItem(AUTH_FLOW_ATTEMPT_KEY, attemptId);

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

        if (!isAuthFlowCurrent(attemptId, flowNonce)) {
          return;
        }
        if (!response.ok) {
          clearAuthFlowIfCurrent(attemptId);
          const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
          setError(errorBody.error ?? `Sign in failed (${response.status})`);
          return;
        }

        const { auth_url: authUrl } = (await response.json()) as { auth_url: string };

        if (isPreview) {
          const popup = window.open(authUrl, "_blank", "width=500,height=650");
          if (!popup) {
            setError("Popup blocked — please allow popups for this site.");
            clearAuthFlowIfCurrent(attemptId);
            return;
          }

          await new Promise<void>((resolve) => {
            const onMessage = (event: MessageEvent) => {
              const payload = event.data as { type?: string; code?: string } | null;
              if (
                !payload ||
                payload.type !== "rork_auth_callback" ||
                !isAuthFlowCurrent(attemptId, flowNonce)
              ) {
                return;
              }
              window.removeEventListener("message", onMessage);
              messageListenerRef.current = null;
              clearInterval(pollTimer);
              const finish = async () => {
                if (payload.code) {
                  await exchangeCode(payload.code, attemptId);
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
                clearAuthFlowIfCurrent(attemptId);
                resolve();
              }
            }, 500);
          });
        } else {
          window.location.href = authUrl;
        }
      } catch (err) {
        if (isAuthFlowCurrent(attemptId, flowNonce)) {
          console.error("Sign in failed:", err);
          setError(err instanceof Error ? err.message : "Sign in failed");
          clearAuthFlowIfCurrent(attemptId);
        }
      } finally {
        if (signInAttemptRef.current === attemptId) {
          signInAttemptRef.current = null;
          setIsSigningIn(false);
        }
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
