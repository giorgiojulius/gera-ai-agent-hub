// Minimal GitHub Actions OIDC verifier for the repository-preview upload plane.
// No shared secret enters a runner: GitHub signs the job identity, and the
// Worker pins issuer, audience, repository, workflow path and provider run id.

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const AUDIENCE = "gera-repo-preview";
const CACHE_MS = 60 * 60_000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_CHARS = 20_000;

type GitHubOidcClaims = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  repository?: unknown;
  workflow_ref?: unknown;
  workflow?: unknown;
  event_name?: unknown;
  run_id?: unknown;
  runner_environment?: unknown;
};

type CachedKeys = { at: number; keys: JsonWebKey[] };
let cachedKeys: CachedKeys | null = null;

function decodeBase64Url(value: string): Uint8Array {
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return key.kty === "RSA" && typeof key.kid === "string" && typeof key.n === "string" && typeof key.e === "string";
}

async function getKeys(force: boolean): Promise<JsonWebKey[]> {
  if (!force && cachedKeys && Date.now() - cachedKeys.at < CACHE_MS) return cachedKeys.keys;
  const response = await fetch(JWKS_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`github_oidc_jwks_${response.status}`);
  const body = await response.json() as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? body.keys.filter(validJwk) : [];
  if (keys.length === 0) throw new Error("github_oidc_jwks_empty");
  cachedKeys = { at: Date.now(), keys };
  return keys;
}

function audienceMatches(value: unknown): boolean {
  return value === AUDIENCE || (Array.isArray(value) && value.includes(AUDIENCE));
}

/** Returns verified claims, or null for an invalid/unauthorized JWT. */
export async function verifyGitHubActionsOidc(token: string): Promise<GitHubOidcClaims | null> {
  if (!token || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  const claims = decodeJson(encodedClaims) as GitHubOidcClaims | null;
  const kid = typeof header?.kid === "string" ? header.kid : "";
  if (!header || !claims || header.alg !== "RS256" || header.typ !== "JWT" || !kid) return null;

  const now = Math.floor(Date.now() / 1_000);
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  const iat = typeof claims.iat === "number" ? claims.iat : 0;
  const nbf = typeof claims.nbf === "number" ? claims.nbf : iat;
  if (
    claims.iss !== ISSUER ||
    !audienceMatches(claims.aud) ||
    !exp ||
    !iat ||
    exp - iat > 20 * 60 ||
    now > exp + CLOCK_SKEW_SECONDS ||
    now + CLOCK_SKEW_SECONDS < nbf ||
    iat > now + CLOCK_SKEW_SECONDS
  ) {
    return null;
  }

  let keys = await getKeys(false);
  let jwk = keys.find((key) => key.kid === kid);
  if (!jwk) {
    keys = await getKeys(true);
    jwk = keys.find((key) => key.kid === kid);
  }
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
    return verified ? claims : null;
  } catch {
    return null;
  }
}

/** Pins a valid JWT to the exact preview job the Rork backend dispatched. */
export function authorizeGitHubPreviewClaims(
  claims: GitHubOidcClaims,
  expected: { repository: string; runId: string; workflowPath: string },
): boolean {
  const repository = typeof claims.repository === "string" ? claims.repository : "";
  const workflowRef = typeof claims.workflow_ref === "string" ? claims.workflow_ref : "";
  const runId = typeof claims.run_id === "string" ? claims.run_id : "";
  return repository.toLowerCase() === expected.repository.toLowerCase() &&
    runId === expected.runId &&
    claims.event_name === "workflow_dispatch" &&
    claims.runner_environment === "github-hosted" &&
    claims.workflow === "Gera web preview" &&
    workflowRef.toLowerCase().startsWith(
      `${expected.repository}/${expected.workflowPath}@refs/heads/`.toLowerCase(),
    );
}

export const GITHUB_PREVIEW_OIDC_AUDIENCE = AUDIENCE;
