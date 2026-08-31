// GitHub sign-in via the OAuth 2.0 device flow — the same pattern VS Code
// and other editors use for the GitHub MCP server. GitHub's authorization
// server refuses dynamic client registration (probed live; confirmed by the
// GitHub MCP team: "we will never implement DCR"), so popup sign-in cannot
// work for arbitrary apps. Instead the workspace registers ONE GitHub OAuth
// app (client ID only — the device flow needs no secret) and every member
// signs in with a one-time code. All requests go through the Gera relay
// because github.com's OAuth endpoints send no CORS headers; the relay
// forwards them verbatim and never stores tokens.
import { relayFetch } from "@/lib/backend";
import {
  beginOAuthGrantFlow,
  finishOAuthGrantFlow,
  storeExternalOAuthToken,
  type OAuthGrantFlow,
} from "@/lib/mcp-oauth";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

/** A credential is absent or definitively rejected; only a fresh sign-in/key can repair it. */
export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

/**
 * Subset of the GitHub MCP server's published scopes_supported — enough for
 * repos, issues, PRs, Actions, gists, notifications and projects. Excludes
 * destructive/rare scopes (delete_repo, packages, codespace) on purpose.
 */
const SCOPES = "repo read:org read:user user:email gist notifications workflow read:project";

/** The workspace's GitHub OAuth app client ID, or null when not configured. */
export function githubDeviceClientId(): string | null {
  const id = import.meta.env.EXPO_PUBLIC_GITHUB_OAUTH_CLIENT_ID;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

export type GitHubDeviceSession = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
  /** Per-server attempt + cross-tab account boundary. */
  operationFlow: OAuthGrantFlow;
};

/** Identity + granted scopes behind a GitHub token — the honest "who am I". */
export type GitHubViewer = {
  login: string;
  name: string | null;
  /** Classic OAuth scopes on the token, or null when GitHub omits the header (fine-grained PATs). */
  scopes: string[] | null;
};

/** Parses GitHub's X-OAuth-Scopes header ("repo, read:org") into a scope list. */
export function parseOAuthScopes(header: string | null): string[] | null {
  if (header === null) {
    return null;
  }
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * Scopes the GitHub MCP needs that the token lacks. `repo` is the one that
 * makes private repositories visible — without it GitHub silently returns
 * public data only, which reads as "my repos are missing".
 */
export function missingGitHubScopes(scopes: string[] | null): string[] {
  if (scopes === null) {
    return [];
  }
  return ["repo"].filter((required) => !scopes.includes(required));
}

/** One-line identity for the server card: who the token belongs to and whether private repos are reachable. */
export function githubIdentityLabel(viewer: GitHubViewer): string {
  const missing = missingGitHubScopes(viewer.scopes);
  if (missing.length > 0) {
    return `@${viewer.login} — token lacks ${missing.map((scope) => `"${scope}"`).join(", ")}; private repos are hidden. Sign in again`;
  }
  if (viewer.scopes === null) {
    return `@${viewer.login}`;
  }
  return `@${viewer.login} · repo access OK`;
}

/** GitHub settings page where the member reviews/grants this OAuth app access to org-owned private repos. */
export function githubOrgAccessUrl(): string | null {
  const clientId = githubDeviceClientId();
  return clientId ? `https://github.com/settings/connections/applications/${clientId}` : null;
}

/**
 * Asks api.github.com who the token belongs to and which scopes it carries.
 * GitHub's REST API sends CORS headers (Access-Control-Allow-Origin: * with
 * X-OAuth-Scopes in the expose list — verified live), so this runs directly
 * in the browser and the token never leaves it.
 */
export async function fetchGitHubViewer(authorization: string): Promise<GitHubViewer> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: authorization,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new GitHubAuthError("GitHub rejected this credential — sign in again or paste a fresh PAT.");
    }
    throw new Error(`GitHub could not verify the credential right now (HTTP ${response.status}) — retry shortly.`);
  }
  const data = (await response.json()) as { login?: unknown; name?: unknown };
  const login = typeof data.login === "string" ? data.login : "";
  if (!login) {
    throw new Error("GitHub returned no account for this token.");
  }
  return {
    login,
    name: typeof data.name === "string" ? data.name : null,
    scopes: parseOAuthScopes(response.headers.get("X-OAuth-Scopes")),
  };
}

async function postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await relayFetch("/oauth-proxy", url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    throw new Error("Could not reach the Gera relay. Check your connection and try again.");
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data) {
    throw new Error(`GitHub returned an unreadable response (${response.status}).`);
  }
  return data;
}

function deviceErrorMessage(data: Record<string, unknown>): string {
  const code = typeof data.error === "string" ? data.error : "";
  if (code === "access_denied") {
    return "You declined the authorization on GitHub.";
  }
  if (code === "expired_token") {
    return "The code expired before authorization — start sign-in again.";
  }
  if (code === "device_flow_disabled") {
    return 'The GitHub OAuth app has "Device Flow" disabled. Enable it in the app settings on GitHub and try again.';
  }
  if (code === "incorrect_client_credentials" || code === "unauthorized_client") {
    return "GitHub rejected the configured client ID — double-check the OAuth app.";
  }
  const description =
    typeof data.error_description === "string" && data.error_description
      ? data.error_description
      : code || "unknown error";
  return `GitHub sign-in failed: ${description}`;
}

/** Requests a device + user code pair from GitHub. */
export async function startGitHubDeviceFlow(): Promise<GitHubDeviceSession> {
  const clientId = githubDeviceClientId();
  if (!clientId) {
    throw new Error("GitHub sign-in is not configured for this workspace yet.");
  }
  const operationFlow = beginOAuthGrantFlow("github");
  let data: Record<string, unknown>;
  try {
    data = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPES });
  } catch (error) {
    finishOAuthGrantFlow(operationFlow);
    throw error;
  }
  if (typeof data.error === "string" && data.error) {
    finishOAuthGrantFlow(operationFlow);
    throw new Error(deviceErrorMessage(data));
  }
  const deviceCode = typeof data.device_code === "string" ? data.device_code : "";
  const userCode = typeof data.user_code === "string" ? data.user_code : "";
  if (!deviceCode || !userCode) {
    finishOAuthGrantFlow(operationFlow);
    throw new Error("GitHub did not return a device code — double-check the OAuth app's client ID.");
  }
  const interval = typeof data.interval === "number" ? data.interval : 5;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 900;
  return {
    deviceCode,
    userCode,
    verificationUri:
      typeof data.verification_uri === "string" && data.verification_uri
        ? data.verification_uri
        : "https://github.com/login/device",
    intervalMs: Math.max(interval, 5) * 1000,
    expiresAt: Date.now() + expiresIn * 1000,
    operationFlow,
  };
}

/**
 * Polls GitHub until the member authorizes (stores the token and returns
 * true), the code expires or GitHub refuses (throws), or the caller cancels
 * (returns false). Respects GitHub's interval and slow_down back-pressure.
 */
export async function pollGitHubDeviceToken(
  session: GitHubDeviceSession,
  isCancelled: () => boolean,
): Promise<boolean> {
  const clientId = githubDeviceClientId();
  if (!clientId) {
    return false;
  }
  let interval = session.intervalMs;
  try {
    while (!isCancelled()) {
    if (Date.now() > session.expiresAt) {
      throw new Error("The code expired before authorization — start sign-in again.");
    }
    await sleep(interval);
    if (isCancelled()) {
      return false;
    }
      const data = await postForm(TOKEN_URL, {
        client_id: clientId,
        device_code: session.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (isCancelled()) {
        return false;
      }
      if (typeof data.access_token === "string" && data.access_token) {
      const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
      const stored = storeExternalOAuthToken("github", {
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
        tokenEndpoint: TOKEN_URL,
        clientId,
        mcpUrl: "https://api.github.com",
      }, session.operationFlow);
        return stored;
      }
    const code = typeof data.error === "string" ? data.error : "";
    if (code === "authorization_pending") {
      continue;
    }
    if (code === "slow_down") {
      interval += 5000;
      continue;
    }
      throw new Error(deviceErrorMessage(data));
    }
    return false;
  } finally {
    finishOAuthGrantFlow(session.operationFlow);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
