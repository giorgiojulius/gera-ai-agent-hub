import { fetchPublicHttps, safePublicHttpsUrl } from "./network-safety";
import type { CloudOAuthToken } from "./mcp-cloud";

export type ServerOAuthDiscovery = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  issuer: string;
  resource?: string;
  scopes?: string[];
};

export type DynamicOAuthClient = {
  clientId: string;
  expiresAt?: number;
};

export class OAuthCodeExchangeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly transient: boolean;
  readonly ambiguous: boolean;

  constructor(input: { code: string; status: number; transient: boolean; ambiguous: boolean }) {
    super(`OAuth code exchange failed: ${input.code}`);
    this.name = "OAuthCodeExchangeError";
    this.code = input.code;
    this.status = input.status;
    this.transient = input.transient;
    this.ambiguous = input.ambiguous;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function publicHttps(value: string, label: string): URL {
  const parsed = safePublicHttpsUrl(value);
  if (!parsed) {
    throw new Error(`${label} must be a public HTTPS URL`);
  }
  parsed.hash = "";
  return parsed;
}

function sameEndpoint(left: string, right: string): boolean {
  return left.replace(/\/$/, "") === right.replace(/\/$/, "");
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchPublicHttps(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    }, { allowCrossOriginGet: true });
    if (!response.ok) {
      return null;
    }
    return record(await response.json().catch(() => null));
  } catch {
    return null;
  }
}

/** RFC 9728 + RFC 8414 discovery with issuer/resource/PKCE binding. */
export async function discoverMcpOAuth(mcpUrl: string): Promise<ServerOAuthDiscovery> {
  const target = publicHttps(mcpUrl, "MCP endpoint");
  const path = target.pathname.replace(/\/$/, "");
  let authorizationServers: string[] = [];
  let resource: string | undefined;
  let resourceScopes: string[] | undefined;
  const protectedResourceCandidates = [
    path ? `${target.origin}/.well-known/oauth-protected-resource${path}` : "",
    `${target.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean);
  for (const candidate of protectedResourceCandidates) {
    const metadata = await fetchJson(candidate);
    const servers = metadata?.authorization_servers;
    if (!Array.isArray(servers) || servers.length === 0) {
      continue;
    }
    authorizationServers = servers.map((server) => publicHttps(String(server), "OAuth issuer").toString());
    if (typeof metadata?.resource === "string") {
      const advertised = publicHttps(metadata.resource, "OAuth resource");
      if (advertised.origin !== target.origin) {
        throw new Error("OAuth resource origin does not match the MCP endpoint");
      }
      resource = advertised.toString();
    }
    if (Array.isArray(metadata?.scopes_supported)) {
      resourceScopes = metadata.scopes_supported.map(String);
    }
    break;
  }
  if (authorizationServers.length === 0) {
    authorizationServers = [target.origin];
  }
  resource ??= target.toString();

  for (const authorizationServer of authorizationServers) {
    const issuerUrl = publicHttps(authorizationServer, "OAuth issuer");
    const issuerPath = issuerUrl.pathname.replace(/\/$/, "");
    const candidates = [
      issuerPath ? `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}` : "",
      `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
      issuerPath ? `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}` : "",
      `${issuerUrl.origin}/.well-known/openid-configuration`,
    ].filter(Boolean);
    for (const candidate of candidates) {
      const metadata = await fetchJson(candidate);
      if (
        typeof metadata?.authorization_endpoint !== "string" ||
        typeof metadata?.token_endpoint !== "string"
      ) {
        continue;
      }
      const advertisedIssuer =
        typeof metadata.issuer === "string"
          ? publicHttps(metadata.issuer, "OAuth issuer").toString()
          : issuerUrl.toString();
      if (!sameEndpoint(advertisedIssuer, issuerUrl.toString())) {
        throw new Error("OAuth metadata issuer mismatch");
      }
      const challengeMethods = Array.isArray(metadata.code_challenge_methods_supported)
        ? metadata.code_challenge_methods_supported.map(String)
        : undefined;
      if (challengeMethods && !challengeMethods.includes("S256")) {
        throw new Error("OAuth server does not advertise S256 PKCE");
      }
      const serverScopes = Array.isArray(metadata.scopes_supported)
        ? metadata.scopes_supported.map(String)
        : undefined;
      const scopes = [...(resourceScopes ?? serverScopes ?? [])];
      if (serverScopes?.includes("offline_access") && !scopes.includes("offline_access")) {
        scopes.push("offline_access");
      }
      return {
        authorizationEndpoint: publicHttps(metadata.authorization_endpoint, "OAuth authorization endpoint").toString(),
        tokenEndpoint: publicHttps(metadata.token_endpoint, "OAuth token endpoint").toString(),
        registrationEndpoint:
          typeof metadata.registration_endpoint === "string"
            ? publicHttps(metadata.registration_endpoint, "OAuth registration endpoint").toString()
            : undefined,
        issuer: advertisedIssuer,
        resource,
        scopes: scopes.length > 0 ? scopes : undefined,
      };
    }
  }
  throw new Error("MCP server does not publish usable OAuth metadata");
}

/** Registers one public PKCE client. Client IDs are metadata, never provider grants. */
export async function registerDynamicOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<DynamicOAuthClient> {
  const endpoint = publicHttps(registrationEndpoint, "OAuth registration endpoint");
  const response = await fetchPublicHttps(endpoint.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Gera AI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = record(await response.json().catch(() => null));
  if (!response.ok || typeof data?.client_id !== "string" || !data.client_id) {
    const code = typeof data?.error === "string" ? data.error : `HTTP ${response.status}`;
    throw new Error(`OAuth client registration failed: ${code}`);
  }
  const expiresSeconds = Number(data.client_secret_expires_at ?? 0);
  return {
    clientId: data.client_id,
    expiresAt:
      Number.isFinite(expiresSeconds) && expiresSeconds > 0
        ? expiresSeconds * 1_000
        : undefined,
  };
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function newOAuthState(): string {
  return randomHex(32);
}

export function newPkceVerifier(): string {
  return randomHex(32);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function buildAuthorizationUrl(input: {
  discovery: ServerOAuthDiscovery;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = publicHttps(input.discovery.authorizationEndpoint, "OAuth authorization endpoint");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.discovery.resource) {
    url.searchParams.set("resource", input.discovery.resource);
  }
  if (input.discovery.scopes && input.discovery.scopes.length > 0) {
    url.searchParams.set("scope", input.discovery.scopes.join(" "));
  }
  return url.toString();
}

/** Exchanges the one-time code server-side; no token is returned to the browser. */
export async function exchangeAuthorizationCode(input: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource?: string;
  mcpUrl: string;
}): Promise<CloudOAuthToken> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
  });
  if (input.resource) {
    params.set("resource", input.resource);
  }
  let response: Response;
  try {
    response = await fetchPublicHttps(input.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new OAuthCodeExchangeError({
      code: "temporarily_unavailable",
      status: 502,
      transient: true,
      ambiguous: true,
    });
  }
  const data = record(await response.json().catch(() => null));
  if (!response.ok) {
    const code = typeof data?.error === "string" && data.error ? data.error : `http_${response.status}`;
    const transient =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500 ||
      ["temporarily_unavailable", "server_error", "slow_down", "timeout"].includes(code);
    const explicitRetryable = ["temporarily_unavailable", "server_error", "slow_down"].includes(code);
    throw new OAuthCodeExchangeError({
      code,
      status: response.status,
      transient,
      ambiguous: transient && !explicitRetryable,
    });
  }
  if (typeof data?.access_token !== "string" || !data.access_token) {
    throw new OAuthCodeExchangeError({
      code: "invalid_response",
      status: 502,
      transient: true,
      ambiguous: true,
    });
  }
  const expiresIn = Number(data.expires_in ?? 0);
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1_000 : undefined,
    tokenEndpoint: input.tokenEndpoint,
    clientId: input.clientId,
    resource: input.resource,
    mcpUrl: publicHttps(input.mcpUrl, "MCP endpoint").toString(),
  };
}
