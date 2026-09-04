import { describe, expect, it } from "vitest";

import {
  deviceCodeScope,
  GRANT_SECRET_FIELDS,
  grantScope,
  OAUTH_PENDING_SECRET_FIELDS,
  oauthPendingFieldScope,
  openGrantPayload,
  openRotationValue,
  openServerSecret,
  sealGrantPayload,
  sealRotationValue,
  sealServerSecret,
} from "../../../functions/secret-rows";
import {
  fieldsNeedReseal,
  isSealedEnvelope,
  keyMaterialBytes,
  keyMaterialProblem,
  MIN_KEY_BYTES,
  openFields,
  openJson,
  SEALED_PREFIX,
  sealFields,
  sealJson,
  SecretVault,
  SecretVaultError,
  tallySealed,
} from "../../../functions/secret-vault";

// `openssl rand -base64 32` / `-hex 32` / `-base64 48` — the formats operators paste.
const KEY_A = "XWtIHN16zXsdcxtMZnNBsL6qQxVqG45bVMb1llWkYtg=";
const KEY_B = "FZXHZFktqlW7bDR/KrNvi1ygqUNc4H+TSmsE4JV9238=";
const KEY_HEX = "fd2b2eeb06164105e55b90d5753d15a8768e1b6303cb0232843bfe2ac318012c";
const KEY_48 = "+B56yeb8TLv++x0/Xfyy442fuRnxOPAaL7k5B9wepL6qbLUpY1Ytjl72h9FJ50Vq";

async function vaultError(run: () => Promise<unknown>): Promise<SecretVaultError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SecretVaultError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a SecretVaultError");
}

describe("key material", () => {
  it("accepts base64, base64url and hex encodings of at least 32 random bytes", () => {
    expect(keyMaterialBytes(KEY_A)).toBe(32);
    expect(keyMaterialBytes(KEY_A.replace(/=+$/, ""))).toBe(32);
    // `openssl rand -base64 48` and longer wrap at 76 columns; a pasted key keeps the breaks.
    expect(keyMaterialBytes(`${KEY_48.slice(0, 40)}\n${KEY_48.slice(40)}\n`)).toBe(48);
    expect(keyMaterialProblem(`${KEY_48.slice(0, 40)}\r\n${KEY_48.slice(40)}`)).toBe("");
    expect(keyMaterialBytes(KEY_B.replace(/\+/g, "-").replace(/\//g, "_"))).toBe(32);
    expect(keyMaterialBytes(KEY_HEX)).toBe(32);
    expect(keyMaterialBytes(KEY_48)).toBe(48);
    for (const key of [KEY_A, KEY_B, KEY_HEX, KEY_48]) {
      expect(keyMaterialProblem(key)).toBe("");
      expect(SecretVault.forTesting(key).enabled).toBe(true);
    }
  });

  it("refuses passphrases and short keys — a dump must not become an offline guessing game", () => {
    expect(keyMaterialProblem("")).toBe("secrets_key_missing");
    expect(keyMaterialProblem("correct horse battery staple, correct horse!")).toBe("secrets_key_malformed");
    expect(keyMaterialProblem("this-is-not-random-but-it-is-quite-long!")).toBe("secrets_key_malformed");
    // Letters alone can look like base64 — a short sentence still comes out under 32 bytes.
    expect(keyMaterialProblem("please do not use a sentence as the key")).toBe("secrets_key_too_short");
    // Valid base64 alphabet, but only 24 bytes of it.
    expect(keyMaterialProblem("MySuperSecretPassphrase2026abcd0")).toBe("secrets_key_too_short");
    expect(keyMaterialProblem("a".repeat(MIN_KEY_BYTES * 2 - 2))).toBe("secrets_key_too_short");
    const short = SecretVault.fromEnv({ SECRETS_ENCRYPTION_KEY: KEY_A.slice(0, 24) });
    expect(short.enabled).toBe(false);
    expect(short.disabledReason).toBe("secrets_key_too_short");
    const phrase = SecretVault.fromEnv({ SECRETS_ENCRYPTION_KEY: "please, do not use a sentence as the key." });
    expect(phrase.disabledReason).toBe("secrets_key_malformed");
  });

  it("derives from the key exactly as given — line breaks are tolerated, not normalized away", async () => {
    const wrapped = `${KEY_48.slice(0, 40)}\n${KEY_48.slice(40)}`;
    const sealed = await SecretVault.forTesting(wrapped).seal("v", "s");
    expect(await SecretVault.forTesting(wrapped).open(sealed, "s")).toBe("v");
    // The same bytes pasted without the break are a different key: rotate, do not "clean up".
    expect((await vaultError(() => SecretVault.forTesting(KEY_48).open(sealed, "s"))).code).toBe("secret_unreadable");
  });

  it("ignores weak entries in the previous-key list", async () => {
    const sealedByA = await SecretVault.forTesting(KEY_A).seal("v", "s");
    const rotated = SecretVault.fromEnv({
      SECRETS_ENCRYPTION_KEY: KEY_B,
      SECRETS_ENCRYPTION_KEY_PREVIOUS: `not a key, ${KEY_A} , `,
    });
    expect(rotated.enabled).toBe(true);
    expect(await rotated.open(sealedByA, "s")).toBe("v");
  });
});

describe("SecretVault", () => {
  const vault = SecretVault.forTesting(KEY_A);

  it("seals into an envelope that only the same scope opens", async () => {
    const sealed = await vault.seal("ghp_secret", "agent:a1#githubToken");
    expect(sealed.startsWith(SEALED_PREFIX)).toBe(true);
    expect(sealed.split(":")).toHaveLength(4);
    expect(sealed).not.toContain("ghp_secret");
    expect(await vault.open(sealed, "agent:a1#githubToken")).toBe("ghp_secret");
    // Same ciphertext under another row's scope is a copy attack — refused.
    const moved = await vaultError(() => vault.open(sealed, "agent:a2#githubToken"));
    expect(moved.code).toBe("secret_unreadable");
  });

  it("uses a fresh IV per seal and detects tampering", async () => {
    const first = await vault.seal("same", "s");
    const second = await vault.seal("same", "s");
    expect(first).not.toBe(second);
    const [prefix, kid, iv, body] = first.split(":");
    const flipped = body[0] === "A" ? "B" : "A";
    const tampered = `${prefix}:${kid}:${iv}:${flipped}${body.slice(1)}`;
    expect((await vaultError(() => vault.open(tampered, "s"))).code).toBe("secret_unreadable");
    expect((await vaultError(() => vault.open("enc1:garbage", "s"))).code).toBe("secret_unreadable");
  });

  it("refuses plaintext where a credential should be — no passthrough", async () => {
    const planted = await vaultError(() => vault.open("xoxb-planted-plaintext", "any"));
    expect(planted.code).toBe("secret_unreadable");
    expect(planted.message).toContain("plaintext rejected");
    expect(vault.isSealed("xoxb-legacy")).toBe(false);
    expect(await vault.isCurrent("xoxb-legacy")).toBe(false);
    // Empty is "absent", never plaintext.
    expect(await vault.open("", "any")).toBe("");
    expect(await vault.seal("", "any")).toBe("");
  });

  it("reseal is the only reader of plaintext, and it produces a current envelope", async () => {
    const migrated = await vault.reseal("legacy-plaintext", "s");
    expect(migrated.startsWith(SEALED_PREFIX)).toBe(true);
    expect(await vault.isCurrent(migrated)).toBe(true);
    expect(await vault.open(migrated, "s")).toBe("legacy-plaintext");
    expect(await vault.reseal("", "s")).toBe("");
  });

  it("fails closed without a usable key", async () => {
    const missing = SecretVault.fromEnv({});
    expect(missing.enabled).toBe(false);
    expect(missing.disabledReason).toBe("secrets_key_missing");
    expect((await vaultError(() => missing.seal("x", "s"))).code).toBe("secrets_key_unavailable");
    expect((await vaultError(() => missing.open("plain", "s"))).code).toBe("secrets_key_unavailable");
    const sealed = await vault.seal("x", "s");
    expect((await vaultError(() => missing.open(sealed, "s"))).code).toBe("secrets_key_unavailable");
    expect((await vaultError(() => missing.reseal("plain", "s"))).code).toBe("secrets_key_unavailable");
  });

  it("rotates: the previous key opens old rows, reseal moves them to the new key", async () => {
    const old = await vault.seal("refresh-token", "grant#refreshToken");
    const rotated = SecretVault.forTesting(KEY_B, [KEY_A]);
    expect(await rotated.open(old, "grant#refreshToken")).toBe("refresh-token");
    expect(await rotated.isCurrent(old)).toBe(false);
    const resealed = await rotated.reseal(old, "grant#refreshToken");
    expect(await rotated.isCurrent(resealed)).toBe(true);
    expect(resealed.split(":")[1]).toBe(await rotated.currentKid());
    expect(await rotated.open(resealed, "grant#refreshToken")).toBe("refresh-token");
    // Already-current values are returned untouched by reseal.
    expect(await rotated.reseal(resealed, "grant#refreshToken")).toBe(resealed);
    // Without the previous key the old row is honestly unreadable, not silently empty.
    const onlyB = SecretVault.forTesting(KEY_B);
    expect((await vaultError(() => onlyB.open(old, "grant#refreshToken"))).code).toBe("secret_unreadable");
  });
});

describe("field helpers", () => {
  const vault = SecretVault.forTesting(KEY_A);
  type Blob = { githubToken?: string; slackToken?: string; slackTeam?: string; mcpSelection?: { owner: string } };

  it("seals only the listed non-empty string fields and keeps metadata readable", async () => {
    const plain: Blob = { githubToken: "ghp_x", slackToken: "", slackTeam: "Acme", mcpSelection: { owner: "o@x" } };
    const sealed = await sealFields(vault, plain, ["githubToken", "slackToken"], "agent:a1");
    expect(sealed.githubToken?.startsWith(SEALED_PREFIX)).toBe(true);
    expect(sealed.slackToken).toBe("");
    expect(sealed.slackTeam).toBe("Acme");
    expect(sealed.mcpSelection).toEqual({ owner: "o@x" });
    expect(await fieldsNeedReseal(vault, sealed, ["githubToken", "slackToken"])).toBe(false);
    expect(await fieldsNeedReseal(vault, plain, ["githubToken"])).toBe(true);
    const opened = await openFields(vault, sealed, ["githubToken", "slackToken"], "agent:a1");
    expect(opened).toEqual(plain);
    // Each field is its own scope: a token copied into another field fails.
    const swapped: Blob = { slackToken: sealed.githubToken };
    expect((await vaultError(() => openFields(vault, swapped, ["slackToken"], "agent:a1"))).code).toBe(
      "secret_unreadable",
    );
    // A plaintext field planted next to sealed ones is refused too.
    expect((await vaultError(() => openFields(vault, plain, ["githubToken"], "agent:a1"))).code).toBe(
      "secret_unreadable",
    );
  });

  it("sealJson wraps whole values and openJson refuses anything that is not an envelope", async () => {
    const value = { bases: ["tok-1"], token: { accessToken: "tok-2" } };
    const envelope = await sealJson(vault, value, "rot");
    expect(isSealedEnvelope(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("tok-");
    expect(await openJson(vault, envelope, "rot")).toEqual(value);
    expect((await vaultError(() => openJson(vault, value, "rot"))).code).toBe("secret_unreadable");
    expect(isSealedEnvelope({ sealed: "not-an-envelope" })).toBe(false);
  });

  it("tallySealed counts without opening: sealed, current-key, plaintext", async () => {
    const rotated = SecretVault.forTesting(KEY_B, [KEY_A]);
    const oldRow = await vault.seal("a", "s");
    const newRow = await rotated.seal("b", "s");
    const tally = await tallySealed(rotated, [oldRow, newRow, "planted", "", newRow]);
    expect(tally).toEqual({ total: 4, sealed: 3, current: 2, plaintext: 1 });
    const disabled = await tallySealed(SecretVault.fromEnv({}), [oldRow, "x"]);
    expect(disabled).toEqual({ total: 2, sealed: 1, current: 0, plaintext: 1 });
  });
});

describe("credential rows", () => {
  const vault = SecretVault.forTesting(KEY_A);

  it("seals grant tokens but leaves endpoint and expiry in the clear", async () => {
    const token = {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1_800_000_000_000,
      tokenEndpoint: "https://idp.test/token",
      clientId: "client-1",
      mcpUrl: "https://mcp.test",
      authorizationState: "st-1",
    };
    const payload = await sealGrantPayload(vault, "o@x", "linear", token);
    const stored = JSON.parse(payload) as Record<string, unknown>;
    expect(String(stored.accessToken).startsWith(SEALED_PREFIX)).toBe(true);
    expect(String(stored.refreshToken).startsWith(SEALED_PREFIX)).toBe(true);
    expect(stored.expiresAt).toBe(token.expiresAt);
    expect(stored.tokenEndpoint).toBe(token.tokenEndpoint);
    expect(stored.authorizationState).toBe("st-1");
    expect(payload).not.toContain("access-1");
    expect(payload).not.toContain("refresh-1");
    const opened = await openGrantPayload(vault, "o@x", "linear", payload);
    expect(opened?.accessToken).toBe("access-1");
    expect(opened?.refreshToken).toBe("refresh-1");
    expect(opened?.expiresAt).toBe(token.expiresAt);
    // A grant row copied under another owner or server id does not open.
    expect((await vaultError(() => openGrantPayload(vault, "other@x", "linear", payload))).code).toBe(
      "secret_unreadable",
    );
    expect((await vaultError(() => openGrantPayload(vault, "o@x", "github", payload))).code).toBe(
      "secret_unreadable",
    );
    expect(await openGrantPayload(vault, "o@x", "linear", "not json")).toBeNull();
    expect(await openGrantPayload(vault, "o@x", "linear", JSON.stringify({ accessToken: "" }))).toBeNull();
    expect(GRANT_SECRET_FIELDS).toEqual(["accessToken", "refreshToken"]);
    expect(grantScope("o@x", "linear")).toBe("mcp-oauth-grant:o@x:linear");
  });

  it("a pre-vault plaintext grant is refused on read and sealed by the sweep path", async () => {
    const legacy = { accessToken: "legacy-access", tokenEndpoint: "https://idp.test/token", clientId: "c" };
    const refused = await vaultError(() => openGrantPayload(vault, "o@x", "linear", JSON.stringify(legacy)));
    expect(refused.code).toBe("secret_unreadable");
    // The sweep re-serializes through sealGrantPayload, which reseals plaintext.
    const swept = await sealGrantPayload(vault, "o@x", "linear", legacy);
    expect(swept).not.toContain("legacy-access");
    expect((await openGrantPayload(vault, "o@x", "linear", swept))?.accessToken).toBe("legacy-access");
  });

  it("seals pasted keys and headers, and the rotation escrow as a whole", async () => {
    const payload = await sealServerSecret(vault, "o@x", "srv", { token: "sk-live", headersJson: '{"X-Key":"k"}' });
    expect(payload).not.toContain("sk-live");
    expect(payload).not.toContain("X-Key");
    const stored = JSON.parse(payload) as { token: string; headersJson: string };
    expect(await openServerSecret(vault, "o@x", "srv", stored)).toEqual({ token: "sk-live", headersJson: '{"X-Key":"k"}' });

    const rotation = { bases: ["old-access"], token: { accessToken: "new-access", refreshToken: "r" } };
    const escrow = await sealRotationValue(vault, "o@x", "srv", rotation);
    expect(JSON.stringify(escrow)).not.toContain("access");
    expect(await openRotationValue(vault, "o@x", "srv", escrow)).toEqual(rotation);
    expect((await vaultError(() => openRotationValue(vault, "o@x", "srv", rotation))).code).toBe("secret_unreadable");
  });

  it("names every pending-flow proof and gives each column its own scope", () => {
    expect(OAUTH_PENDING_SECRET_FIELDS).toEqual(["verifier", "authorization_code", "browser_nonce", "callback_challenge"]);
    expect(oauthPendingFieldScope("o@x", "st", "verifier")).toBe("mcp-oauth-pending:o@x:st#verifier");
    expect(oauthPendingFieldScope("o@x", "st", "authorization_code")).toBe(
      "mcp-oauth-pending:o@x:st#authorization_code",
    );
    expect(oauthPendingFieldScope("o@x", "st", "browser_nonce")).toBe("mcp-oauth-pending:o@x:st#browser_nonce");
    expect(oauthPendingFieldScope("o@x", "st", "callback_challenge")).toBe(
      "mcp-oauth-pending:o@x:st#callback_challenge",
    );
    expect(deviceCodeScope("o@x", "flow")).toBe("mcp-github-device:o@x:flow#device_code");
  });
});
