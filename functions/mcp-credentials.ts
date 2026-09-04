// Credential leases for cloud MCP sessions.
//
// A resolved CloudMcpServer arrives with its credential material attached
// (Authorization header, custom headers, synced OAuth grant, key in the URL).
// The toolset turns that into a lease and keeps only a stripped copy of the
// server: the session object carries no credential strings, every request
// leases what it needs (mcp-protocol.ts calls `get` once per request and
// drops the result), and the redaction list for a response is built from
// that one lease.
//
// Two flavours:
// - resolver-backed: `get` re-resolves the server through the account each
//   time (the vault row is opened per request; an expiring grant refreshes
//   inside the resolver and is persisted there). No material is retained.
// - private: no resolver (health checks, tests, legacy `reconnect` callers)
//   — the material lives in this closure for the run, off every shared object.

import type { CloudMcpServer } from "./mcp-cloud";
import { cloudServerRedactions } from "./mcp-cloud";
import { redactMcpText, type McpLeasedCredential } from "./mcp-protocol";

/** Re-resolves one server with freshly opened credentials; `force` re-redeems the grant. */
export type CredentialResolver = (force: boolean) => Promise<CloudMcpServer | null>;

/** Redeems the private grant of a resolver-less lease after an auth rejection; true when it changed. */
export type GrantRepair = (server: CloudMcpServer) => Promise<boolean>;

export type CredentialLease = {
  /** Per-request credential; used for exactly one request. */
  get(): Promise<McpLeasedCredential>;
  /**
   * After an auth rejection: re-resolve with a forced refresh (resolver-backed)
   * or redeem the private grant. True when a different credential is now
   * available and the connect should be retried.
   */
  repair(): Promise<boolean>;
};

/** Thrown by `get` when the account no longer yields a credential for the server. */
export class McpCredentialUnavailableError extends Error {
  constructor(serverName: string) {
    super(`auth rejected (credential unavailable) — "${serverName}" has no usable sign-in or key on this account any more; open Gera and reconnect it`);
    this.name = "McpCredentialUnavailableError";
  }
}

/** The one-request credential a resolved server carries: URL, headers (+ Bearer from the grant), redactions. */
export function leasedCredentialFor(server: CloudMcpServer): McpLeasedCredential {
  const headers: Record<string, string> = { ...server.headers };
  if (server.oauth && !headers.Authorization) {
    headers.Authorization = `Bearer ${server.oauth.accessToken}`;
  }
  return { url: server.url, headers, redactions: cloudServerRedactions(server) };
}

/**
 * A copy of the server without credential material: no headers, key or grant;
 * a URL with a credential-shaped query value has that value redacted. Safe to
 * keep on run state, journals and diagnostics.
 */
export function stripCloudMcpCredentials(server: CloudMcpServer): CloudMcpServer {
  const stripped: CloudMcpServer = {
    id: server.id,
    name: server.name,
    kind: server.kind,
    url: redactMcpText(server.url, cloudServerRedactions(server)),
    headers: {},
    omitMcpHeaders: server.omitMcpHeaders,
    disabledTools: [...server.disabledTools],
  };
  return stripped;
}

/**
 * Builds the lease for one server. With a resolver nothing is retained; the
 * private flavour keeps `initial` in this closure only.
 */
export function createCredentialLease(
  initial: CloudMcpServer,
  options: { resolve?: CredentialResolver; repairGrant?: GrantRepair } = {},
): CredentialLease {
  const name = initial.name;
  if (options.resolve) {
    const resolve = options.resolve;
    return {
      async get() {
        const fresh = await resolve(false);
        if (!fresh) {
          throw new McpCredentialUnavailableError(name);
        }
        return leasedCredentialFor(fresh);
      },
      async repair() {
        return (await resolve(true).catch(() => null)) !== null;
      },
    };
  }
  // Private material: the only reference to the credential after arming.
  const material: CloudMcpServer = { ...initial, headers: { ...initial.headers }, disabledTools: [...initial.disabledTools] };
  const repairGrant = options.repairGrant;
  return {
    async get() {
      return leasedCredentialFor(material);
    },
    async repair() {
      if (!repairGrant || !material.oauth?.refreshToken) {
        return false;
      }
      return repairGrant(material);
    },
  };
}
