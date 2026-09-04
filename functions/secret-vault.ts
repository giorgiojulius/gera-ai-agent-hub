// Encryption at rest for the credentials Gera's Durable Objects keep: OAuth
// grants and refresh tokens, pasted API keys and custom headers, bot tokens,
// signing secrets, client secrets, PKCE verifiers and device codes.
//
// AES-256-GCM under a data key derived (HKDF-SHA-256) from the
// SECRETS_ENCRYPTION_KEY Worker secret. Every ciphertext is bound to the row it
// belongs to through additional authenticated data (the "scope"), so a value
// copied from one row into another — or one field into another — fails to
// open. The key never touches storage; a storage dump alone yields nothing.
//
// Envelope: `enc1:<kid>:<iv>:<ciphertext+tag>` (base64url). `kid` names the
// key the value was sealed under, so SECRETS_ENCRYPTION_KEY can rotate with
// the previous key kept in SECRETS_ENCRYPTION_KEY_PREVIOUS (comma-separated)
// for decrypt-only use until the next store sweep has re-sealed every row.
//
// Fail-closed: without a usable key nothing new is sealed (writers surface
// `secrets_key_unavailable`), and sealed rows cannot be read. Legacy plaintext
// rows still open (passthrough) so a deploy never locks anyone out; the store
// sweeps seal them the first time the object wakes with a key.

export const SEALED_PREFIX = "enc1:";

/** Minimum characters for the key material — 32 random bytes in base64 are 44. */
export const MIN_KEY_CHARS = 32;

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
    ? "Server-side encryption is not configured — set SECRETS_ENCRYPTION_KEY on the backend before storing credentials."
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

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    return null;
  }
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
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

/** Splits the comma-separated previous-key list, dropping blanks and duplicates. */
function previousMaterials(raw: string | undefined, current: string): string[] {
  const seen = new Set<string>([current]);
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const material = part.trim();
    if (material.length >= MIN_KEY_CHARS && !seen.has(material)) {
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

function aadFor(scope: string): Uint8Array {
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
  readonly disabledReason: string;
  private readonly keyring: Promise<Keyring> | null;

  private constructor(material: string, previous: string[], disabledReason: string) {
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
    if (!material) {
      return new SecretVault("", [], "secrets_key_missing");
    }
    if (material.length < MIN_KEY_CHARS) {
      return new SecretVault("", [], "secrets_key_too_short");
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
   * Decrypts a sealed value for `scope`. Plaintext (pre-vault) values pass
   * through untouched so a deploy never strands existing connections.
   */
  async open(stored: string, scope: string): Promise<string> {
    if (!this.isSealed(stored)) {
      return stored;
    }
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

  /**
   * Seals a plaintext value, or re-seals one sealed under a previous key;
   * values already under the current key are returned as-is.
   */
  async reseal(stored: string, scope: string): Promise<string> {
    if (stored === "" || (await this.isCurrent(stored))) {
      return stored;
    }
    return this.seal(await this.open(stored, scope), scope);
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
  const out: Record<string, unknown> = { ...value };
  for (const field of fields) {
    const name = String(field);
    const current = out[name];
    if (typeof current === "string" && current !== "") {
      out[name] = await vault.reseal(current, fieldScope(scope, name));
    }
  }
  return out as T;
}

/** Returns a copy of `value` with the listed string fields decrypted. */
export async function openFields<T extends object>(
  vault: SecretVault,
  value: T,
  fields: readonly StringFields<T>[],
  scope: string,
): Promise<T> {
  const out: Record<string, unknown> = { ...value };
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

/** Opens `{ sealed }` back into its JSON value; non-envelopes (legacy) pass through. */
export async function openJson(vault: SecretVault, value: unknown, scope: string): Promise<unknown> {
  if (!isSealedEnvelope(value)) {
    return value;
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
