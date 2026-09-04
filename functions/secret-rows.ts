// The account shard's credential rows and how each one is sealed. Shared by
// ChatStore (interactive routes, cloud automations) and RunManager (interactive
// server runs) so both read and write the exact same envelope: a drift here
// would make a grant the run loop refreshed unreadable to the sync route.
//
// Only credential material is sealed; identifiers, endpoints and expiry stay
// plaintext so presence checks, diagnostics and expiry math never need a key.

import { cloudOAuthToken, type CloudOAuthToken } from "./mcp-cloud";
import { fieldScope, openFields, openJson, sealFields, sealJson, type SecretVault } from "./secret-vault";

/** `mcp_oauth_grants.payload` — a CloudOAuthToken with its tokens sealed. */
export const GRANT_SECRET_FIELDS = ["accessToken", "refreshToken"] as const;

export function grantScope(owner: string, serverId: string): string {
  return `mcp-oauth-grant:${owner}:${serverId}`;
}

/**
 * Serializes a grant for `mcp_oauth_grants.payload` with its tokens sealed.
 * Extra fields on the grant (e.g. `authorizationState`) are kept verbatim.
 */
export async function sealGrantPayload(
  vault: SecretVault,
  owner: string,
  serverId: string,
  token: CloudOAuthToken | (CloudOAuthToken & Record<string, unknown>),
): Promise<string> {
  const grant: CloudOAuthToken = token;
  return JSON.stringify(await sealFields(vault, grant, GRANT_SECRET_FIELDS, grantScope(owner, serverId)));
}

/** Parses and decrypts one `mcp_oauth_grants.payload`; null when malformed. */
export async function openGrantPayload(
  vault: SecretVault,
  owner: string,
  serverId: string,
  payload: string,
): Promise<CloudOAuthToken | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const stored = cloudOAuthToken(parsed);
  if (!stored) {
    return null;
  }
  return openFields(vault, stored, GRANT_SECRET_FIELDS, grantScope(owner, serverId));
}

/** `mcp_server_secrets.payload` — pasted key and/or custom headers JSON. */
export type ServerSecret = { token?: string; headersJson?: string };

export const SERVER_SECRET_FIELDS = ["token", "headersJson"] as const;

export function serverSecretScope(owner: string, serverId: string): string {
  return `mcp-server-secret:${owner}:${serverId}`;
}

export async function sealServerSecret(
  vault: SecretVault,
  owner: string,
  serverId: string,
  secret: ServerSecret,
): Promise<string> {
  return JSON.stringify(await sealFields(vault, secret, SERVER_SECRET_FIELDS, serverSecretScope(owner, serverId)));
}

export async function openServerSecret(
  vault: SecretVault,
  owner: string,
  serverId: string,
  secret: ServerSecret,
): Promise<ServerSecret> {
  return openFields(vault, secret, SERVER_SECRET_FIELDS, serverSecretScope(owner, serverId));
}

/** KV `oauthref:<owner>:<serverId>` — legacy rotation escrow, sealed whole. */
export function rotationScope(owner: string, serverId: string): string {
  return `mcp-oauth-rotation:${owner}:${serverId}`;
}

export function sealRotationValue(vault: SecretVault, owner: string, serverId: string, value: unknown): Promise<unknown> {
  return sealJson(vault, value, rotationScope(owner, serverId));
}

export function openRotationValue(vault: SecretVault, owner: string, serverId: string, value: unknown): Promise<unknown> {
  return openJson(vault, value, rotationScope(owner, serverId));
}

/** `mcp_oauth_pending` — the PKCE verifier and the one-time authorization code. */
export const OAUTH_PENDING_SECRET_FIELDS = ["verifier", "authorization_code"] as const;

export function oauthPendingScope(owner: string, state: string): string {
  return `mcp-oauth-pending:${owner}:${state}`;
}

/** Scope for one pending column, e.g. the code written by the public callback. */
export function oauthPendingFieldScope(
  owner: string,
  state: string,
  field: (typeof OAUTH_PENDING_SECRET_FIELDS)[number],
): string {
  return fieldScope(oauthPendingScope(owner, state), field);
}

/** `mcp_github_device_pending.device_code` — polled server-side until GitHub answers. */
export function deviceCodeScope(owner: string, flowId: string): string {
  return fieldScope(`mcp-github-device:${owner}:${flowId}`, "device_code");
}
