// Encryption at rest for every credential the Durable Objects store: OAuth
// grants and refresh tokens, pasted API keys and custom headers, bot tokens,
// signing secrets, client secrets, PKCE verifiers, browser/callback proofs and
// device codes.
//
// AES-256-GCM under a data key derived (HKDF-SHA-256) from the
// SECRETS_ENCRYPTION_KEY Worker secret. Every ciphertext is bound to the row it
// belongs to through additional authenticated data (the "scope"), so a value
// copied from one row into another — or one field into another — fails to
// open. The key never touches storage; a storage dump alone yields nothing.
//
// Key material must be base64 / base64url / hex of at least 32 random bytes
// (`openssl rand -base64 32`). The key id stored in every envelope is a hash
// of the material, and an AES-GCM tag is itself an offline brute-force
// oracle — only genuine entropy protects a dump, so passphrases are refused.
//
// Envelope: `enc1:<kid>:<iv>:<ciphertext+tag>` (base64url). `kid` names the
// key the value was sealed under, so SECRETS_ENCRYPTION_KEY can rotate with
// the previous key kept in SECRETS_ENCRYPTION_KEY_PREVIOUS (comma-separated)
// for decrypt-only use until the next store sweep has re-sealed every row.
//
// Fail-closed: without a usable key nothing is sealed or opened (callers
// surface `secrets_key_unavailable`). `open` accepts only sealed envelopes —
// a plaintext value found where a credential should be is refused
// (`secret_unreadable`), so a row swapped for plaintext in storage never
// authenticates. The only reader of plaintext is `reseal`, which the stores
// call from their one-time sweep before serving the first request.

export const SEALED_PREFIX = "enc1:";

/** Minimum decoded bytes of key material — 256 bits of randomness. */
export const MIN_KEY_BYTES = 32;

const HKDF_SALT = "gera.secret-vault.v1";
const HKDF_INFO = "aes-256-gcm/data-key";
const KID_DOMAIN = "gera.secret-vault.kid\u0000";
const AAD_DOMAIN = "gera/v1/";
const IV_BYTES = 12;

export type SecretVaultEnv = {
  SECRETS_ENCRYPTION_KEY?: string;
  SECRETS_ENCRYPTION_KEY_PREVIOUS?: string;
};

export type SecretVaultErrorCode = "secrets_key_unavailable" | "secret_unreadable";

/** Why a vault refuses to work; "" when it is enabled. Coarse, safe to log and to show. */
export type SecretVaultDisabledReason =
  | ""
  | "secrets_key_missing"
  | "secrets_key_malformed"
  | "secrets_key_too_short";

/** A typed vault failure — callers map it to a 503 with an honest message. */
export class SecretVaultError extends Error {
  readonly code: SecretVaultErrorCode;

  constructor(code: SecretVaultErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SecretVaultError";
    this.code = code;
  }
}

/** User-facing copy for a vault failure; never includes key material. */
export function describeSecretVaultError(error: SecretVaultError): string {
  return error.code === "secrets_key_unavailable"
    ? "Server-side encryption is not configured — SECRETS_ENCRYPTION_KEY must be base64 or hex of at least 32 random bytes."
    : "A stored credential could not be decrypted with the current encryption key — reconnect it, or restore the previous key.";
}

type KeyEntry = { kid: string; key: CryptoKey };
type Keyring = { current: KeyEntry; byKid: Map<string, KeyEntry> };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  const stripped = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/_-]*$/.test(stripped) || stripped.length % 4 === 1) {
    return null;
  }
  const standard = stripped.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    return null;
  }
  return decodeBase64(text);
}

/**
 * How many random bytes a key string encodes: hex or base64/base64url with
 * optional padding; whitespace (line breaks from a wrapped `openssl rand
 * -base64`, spaces from a paste) is ignored. Null when it is neither — a
 * passphrase with punctuation, or copy-paste damage. Validation only: the
 * data key is always derived from the string as given, so accepting a wrapped
 * key never changes what it decrypts.
 */
export function keyMaterialBytes(material: string): number | null {
  const compact = material.replace(/\s+/g, "");
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) {
    return compact.length / 2;
  }
  return decodeBase64(compact)?.length ?? null;
}

/** Classifies one key string the way `SecretVault.fromEnv` does: only random bytes pass. */
export function keyMaterialProblem(material: string): SecretVaultDisabledReason {
  if (!material) {
    return "secrets_key_missing";
  }
  const bytes = keyMaterialBytes(material);
  if (bytes === null) {
    return "secrets_key_malformed";
  }
  return bytes < MIN_KEY_BYTES ? "secrets_key_too_short" : "";
}

async function keyIdFor(material: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(KID_DOMAIN + material));
  return toBase64Url(new Uint8Array(digest)).slice(0, 12);
}

async function deriveDataKey(material: string): Promise<CryptoKey> {
  const kek = await crypto.subtle.importKey("raw", encoder.encode(material), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(HKDF_SALT), info: encoder.encode(HKDF_INFO) },
    kek,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Splits the comma-separated previous-key list, dropping blanks, weak keys and duplicates. */
function previousMaterials(raw: string | undefined, current: string): string[] {
  const seen = new Set<string>([current]);
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const material = part.trim();
    if (keyMaterialProblem(material) === "" && !seen.has(material)) {
      seen.add(material);
      out.push(material);
    }
  }
  return out;
}

const keyringCache = new Map<string, Promise<Keyring>>();

async function buildKeyring(current: string, previous: string[]): Promise<Keyring> {
  const entries = await Promise.all(
    [current, ...previous].map(async (material) => ({
      kid: await keyIdFor(material),
      key: await deriveDataKey(material),
    })),
  );
  const byKid = new Map<string, KeyEntry>();
  for (const entry of entries) {
    if (!byKid.has(entry.kid)) {
      byKid.set(entry.kid, entry);
    }
  }
  return { current: entries[0], byKid };
}

function aadFor(scope: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(AAD_DOMAIN + scope);
}

/**
 * The per-isolate vault. Construct once per Durable Object from its env; key
 * derivation is cached across objects sharing the same material.
 */
export class SecretVault {
  /** False when no usable SECRETS_ENCRYPTION_KEY is configured. */
  readonly enabled: boolean;
  /** Why the vault is disabled ("" when enabled) — coarse, safe to log. */
  readonly disabledReason: SecretVaultDisabledReason;
  private readonly keyring: Promise<Keyring> | null;

  private constructor(material: string, previous: string[], disabledReason: SecretVaultDisabledReason) {
    this.disabledReason = disabledReason;
    this.enabled = disabledReason === "";
    if (!this.enabled) {
      this.keyring = null;
      return;
    }
    const cacheKey = [material, ...previous].join("\u0000");
    let ring = keyringCache.get(cacheKey);
    if (!ring) {
      ring = buildKeyring(material, previous);
      ring.catch(() => keyringCache.delete(cacheKey));
      keyringCache.set(cacheKey, ring);
    }
    this.keyring = ring;
  }

  static fromEnv(env: unknown): SecretVault {
    const record = env && typeof env === "object" ? (env as SecretVaultEnv) : {};
    const material = (record.SECRETS_ENCRYPTION_KEY ?? "").trim();
    const problem = keyMaterialProblem(material);
    if (problem !== "") {
      return new SecretVault("", [], problem);
    }
    return new SecretVault(material, previousMaterials(record.SECRETS_ENCRYPTION_KEY_PREVIOUS, material), "");
  }

  /** A vault for tests — the same derivation path, explicit key material. */
  static forTesting(material: string, previous: string[] = []): SecretVault {
    return SecretVault.fromEnv({
      SECRETS_ENCRYPTION_KEY: material,
      SECRETS_ENCRYPTION_KEY_PREVIOUS: previous.join(","),
    });
  }

  /** True for values carrying the sealed envelope (any key id). */
  isSealed(value: string): boolean {
    return value.startsWith(SEALED_PREFIX);
  }

  /** The identifier of the key new values are sealed under. */
  async currentKid(): Promise<string> {
    return (await this.ring()).current.kid;
  }

  /** True when a sealed value already uses the current key (no re-seal needed). */
  async isCurrent(value: string): Promise<boolean> {
    if (!this.isSealed(value)) {
      return false;
    }
    return value.split(":")[1] === (await this.currentKid());
  }

  /** Encrypts `plain` for exactly this `scope`; empty input stays empty. */
  async seal(plain: string, scope: string): Promise<string> {
    if (plain === "") {
      return "";
    }
    const ring = await this.ring();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(scope) },
      ring.current.key,
      encoder.encode(plain),
    );
    return `${SEALED_PREFIX}${ring.current.kid}:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(ciphertext))}`;
  }

  /**
   * Decrypts a sealed value for `scope`. Only envelopes are accepted: a
   * plaintext string where a credential should be is refused, so a value
   * planted in storage never authenticates. Empty stays empty (absent).
   */
  async open(stored: string, scope: string): Promise<string> {
    if (stored === "") {
      return "";
    }
    if (!this.keyring) {
      throw new SecretVaultError("secrets_key_unavailable", this.disabledReason);
    }
    if (!this.isSealed(stored)) {
      throw new SecretVaultError("secret_unreadable", "plaintext rejected");
    }
    return this.decrypt(stored, scope);
  }

  /**
   * Migration-only: seals a pre-vault plaintext value, or re-seals one sealed
   * under a previous key; values already under the current key are returned
   * as-is. The store sweeps are the only callers that should meet plaintext.
   */
  async reseal(stored: string, scope: string): Promise<string> {
    if (stored === "" || (await this.isCurrent(stored))) {
      return stored;
    }
    const plain = this.isSealed(stored) ? await this.decrypt(stored, scope) : stored;
    return this.seal(plain, scope);
  }

  private async decrypt(stored: string, scope: string): Promise<string> {
    const parts = stored.slice(SEALED_PREFIX.length).split(":");
    if (parts.length !== 3) {
      throw new SecretVaultError("secret_unreadable", "malformed envelope");
    }
    const [kid, ivText, bodyText] = parts;
    const ring = await this.ring();
    const entry = ring.byKid.get(kid);
    if (!entry) {
      throw new SecretVaultError("secret_unreadable", "unknown key id");
    }
    const iv = fromBase64Url(ivText);
    const body = fromBase64Url(bodyText);
    if (!iv || iv.length !== IV_BYTES || !body) {
      throw new SecretVaultError("secret_unreadable", "malformed envelope");
    }
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(scope) },
        entry.key,
        body,
      );
      return decoder.decode(plain);
    } catch {
      throw new SecretVaultError("secret_unreadable", "authentication failed");
    }
  }

  private ring(): Promise<Keyring> {
    if (!this.keyring) {
      throw new SecretVaultError("secrets_key_unavailable", this.disabledReason);
    }
    return this.keyring;
  }
}

/** Field-level scope: the row's scope plus the field name. */
export function fieldScope(scope: string, field: string): string {
  return `${scope}#${field}`;
}

type StringFields<T> = { [K in keyof T]: T[K] extends string | undefined ? K : never }[keyof T];

/**
 * Returns a copy of `value` with the listed string fields sealed (or
 * re-sealed under the current key). Non-string and empty fields are left
 * untouched; the object's shape is preserved so metadata stays readable.
 */
export async function sealFields<T extends object>(
  vault: SecretVault,
  value: T,
  fields: readonly StringFields<T>[],
  scope: string,
): Promise<T> {
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of fields) {
    const name = String(field);
    const current = out[name];
    if (typeof current === "string" && current !== "") {
      out[name] = await vault.reseal(current, fieldScope(scope, name));
    }
  }
  return out as T;
}

/** Returns a copy of `value` with the listed string fields decrypted (envelopes only). */
export async function openFields<T extends object>(
  vault: SecretVault,
  value: T,
  fields: readonly StringFields<T>[],
  scope: string,
): Promise<T> {
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of fields) {
    const name = String(field);
    const current = out[name];
    if (typeof current === "string" && current !== "") {
      out[name] = await vault.open(current, fieldScope(scope, name));
    }
  }
  return out as T;
}

/** True when any listed field is plaintext or sealed under a non-current key. */
export async function fieldsNeedReseal<T extends object>(
  vault: SecretVault,
  value: T,
  fields: readonly StringFields<T>[],
): Promise<boolean> {
  for (const field of fields) {
    const current = (value as Record<string, unknown>)[String(field)];
    if (typeof current === "string" && current !== "" && !(await vault.isCurrent(current))) {
      return true;
    }
  }
  return false;
}

/** Wrapper for whole-value sealing (KV entries whose shape is opaque). */
export type SealedEnvelope = { sealed: string };

export function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sealed?: unknown }).sealed === "string" &&
    (value as { sealed: string }).sealed.startsWith(SEALED_PREFIX)
  );
}

/** Seals an arbitrary JSON value into `{ sealed }`; already-current envelopes pass through. */
export async function sealJson(vault: SecretVault, value: unknown, scope: string): Promise<SealedEnvelope> {
  if (isSealedEnvelope(value)) {
    return { sealed: await vault.reseal(value.sealed, scope) };
  }
  return { sealed: await vault.seal(JSON.stringify(value), scope) };
}

/** Opens `{ sealed }` back into its JSON value; anything that is not an envelope is refused. */
export async function openJson(vault: SecretVault, value: unknown, scope: string): Promise<unknown> {
  if (!isSealedEnvelope(value)) {
    throw new SecretVaultError("secret_unreadable", "plaintext rejected");
  }
  try {
    return JSON.parse(await vault.open(value.sealed, scope)) as unknown;
  } catch (error) {
    if (error instanceof SecretVaultError) {
      throw error;
    }
    throw new SecretVaultError("secret_unreadable", "malformed sealed json");
  }
}

/** Counts only — how many stored credential values are sealed, and under which key. */
export type SealedTally = {
  /** Non-empty values inspected. */
  total: number;
  /** Values carrying the envelope (any key id). */
  sealed: number;
  /** Envelopes under the current key. */
  current: number;
  /** Non-empty values without an envelope — must be zero after the sweep. */
  plaintext: number;
};

/**
 * Tallies stored values without opening any of them, for the account's
 * self-check surface. Empty strings are absent credentials, not plaintext.
 */
export async function tallySealed(vault: SecretVault, values: readonly string[]): Promise<SealedTally> {
  const tally: SealedTally = { total: 0, sealed: 0, current: 0, plaintext: 0 };
  const kid = vault.enabled ? await vault.currentKid() : "";
  for (const value of values) {
    if (value === "") {
      continue;
    }
    tally.total += 1;
    if (!vault.isSealed(value)) {
      tally.plaintext += 1;
      continue;
    }
    tally.sealed += 1;
    if (kid && value.split(":")[1] === kid) {
      tally.current += 1;
    }
  }
  return tally;
}
