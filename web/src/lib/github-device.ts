// GitHub sign-in via the OAuth 2.0 device flow — the same pattern VS Code
// and other editors use for the GitHub MCP server. GitHub's authorization
// server refuses dynamic client registration (probed live; confirmed by the
// GitHub MCP team: "we will never implement DCR"), so popup sign-in cannot
// work for arbitrary apps. Instead the workspace registers ONE GitHub OAuth
// app (client ID only — the device flow needs no secret) and every member
// signs in with a one-time code. All requests go through the Gera relay
// because github.com's OAuth endpoints send no CORS headers; the relay
// forwards them verbatim and never stores tokens.
import { authedFetch } from "@/lib/backend";
import { withDiagnosticContext } from "@/lib/diagnostic-context";
import {
  beginOAuthGrantFlow,
  finishOAuthGrantFlow,
  type OAuthGrantFlow,
} from "@/lib/mcp-oauth";

/** A credential is absent or definitively rejected; only a fresh sign-in/key can repair it. */
export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

/** The workspace's GitHub OAuth app client ID, or null when not configured. */
export function githubDeviceClientId(): string | null {
  const id = import.meta.env.EXPO_PUBLIC_GITHUB_OAUTH_CLIENT_ID;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

export type GitHubDeviceSession = {
  flowId: string;
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
  const accountPrefix = "gera-account:";
  const serverId = authorization.startsWith(accountPrefix)
    ? authorization.slice(accountPrefix.length) || "github"
    : null;
  const response = serverId
    ? await authedFetch(
        `/github-proxy?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent("/user")}`,
        { headers: { "X-Gera-GitHub-Accept": "application/vnd.github+json" } },
      )
    : await fetch("https://api.github.com/user", {
        headers: {
          Authorization: authorization,
          Accept: "application/vnd.github+json",
        },
      });
  if (!response.ok) {
    // GitHub's own words ("Bad credentials", "Request forbidden by administrative
    // rules…", rate-limit notices) or the relay's code — the journal needs the
    // real reason, not just a status number.
    let reason = "";
    try {
      const body = (await response.clone().json()) as { message?: unknown; error?: unknown };
      reason =
        typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "";
    } catch {
      // Non-JSON error body — the status alone has to do.
    }
    const context = {
      path: serverId ? `GET /github-proxy → /user (serverId=${serverId})` : "GET https://api.github.com/user",
      status: response.status,
      reason: reason || undefined,
      rateLimitRemaining: response.headers.get("X-RateLimit-Remaining") ?? undefined,
      retryAfter: response.headers.get("Retry-After") ?? undefined,
      oauthScopes: response.headers.get("X-OAuth-Scopes") ?? undefined,
    };
    if (response.status === 401) {
      throw withDiagnosticContext(
        new GitHubAuthError(
          reason === "github_sign_in_required"
            ? 'GitHub has no sign-in for this account — press "Sign in with GitHub".'
            : "GitHub rejected this credential — sign in again or paste a fresh PAT.",
        ),
        context,
      );
    }
    throw withDiagnosticContext(
      new Error(
        `GitHub could not verify the credential right now (HTTP ${response.status}${reason ? `: ${reason.slice(0, 160)}` : ""}) — retry shortly.`,
      ),
      context,
    );
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

/** Requests a user code; the sensitive device_code stays in the account shard. */
export async function startGitHubDeviceFlow(): Promise<GitHubDeviceSession> {
  if (!githubDeviceClientId()) {
    throw new Error("GitHub sign-in is not configured for this workspace yet.");
  }
  const operationFlow = beginOAuthGrantFlow("github");
  try {
    const response = await authedFetch("/mcp/github-device-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const flowId = typeof data.flowId === "string" ? data.flowId : "";
    const userCode = typeof data.userCode === "string" ? data.userCode : "";
    if (!response.ok || !flowId || !userCode) {
      throw new Error(deviceErrorMessage(data));
    }
    return {
      flowId,
      userCode,
      verificationUri:
        typeof data.verificationUri === "string" && data.verificationUri
          ? data.verificationUri
          : "https://github.com/login/device",
      intervalMs:
        typeof data.intervalMs === "number" ? Math.max(data.intervalMs, 5_000) : 5_000,
      expiresAt:
        typeof data.expiresAt === "number" ? data.expiresAt : Date.now() + 15 * 60_000,
      operationFlow,
    };
  } catch (error) {
    finishOAuthGrantFlow(operationFlow);
    throw error;
  }
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
      const response = await authedFetch(
        `/mcp/github-device-status?flowId=${encodeURIComponent(session.flowId)}`,
      );
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (isCancelled()) {
        return false;
      }
      if (data.status === "completed") {
        return true;
      }
      if (data.status === "pending") {
        if (typeof data.retryAfterMs === "number") {
          interval = Math.max(1_000, data.retryAfterMs);
        }
        continue;
      }
      if (!response.ok && response.status >= 500) {
        interval = Math.max(interval, 5_000);
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
