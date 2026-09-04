import { describe, expect, it } from "vitest";

import {
  deviceCodeScope,
  GRANT_SECRET_FIELDS,
  grantScope,
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
  MIN_KEY_CHARS,
  openFields,
  openJson,
  SEALED_PREFIX,
  sealFields,
  sealJson,
  SecretVault,
  SecretVaultError,
} from "../../../functions/secret-vault";

const KEY_A = "a".repeat(20) + "ROTATION-KEY-A-0123456789";
const KEY_B = "b".repeat(20) + "ROTATION-KEY-B-0123456789";

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

  it("passes pre-vault plaintext through and keeps empties empty", async () => {
    expect(await vault.open("xoxb-legacy-plaintext", "any")).toBe("xoxb-legacy-plaintext");
    expect(await vault.seal("", "any")).toBe("");
    expect(vault.isSealed("xoxb-legacy")).toBe(false);
    expect(await vault.isCurrent("xoxb-legacy")).toBe(false);
  });

  it("fails closed without a usable key", async () => {
    const missing = SecretVault.fromEnv({});
    expect(missing.enabled).toBe(false);
    expect(missing.disabledReason).toBe("secrets_key_missing");
    expect((await vaultError(() => missing.seal("x", "s"))).code).toBe("secrets_key_unavailable");
    // Legacy plaintext still opens — a deploy never locks anyone out.
    expect(await missing.open("plain", "s")).toBe("plain");
    const sealed = await vault.seal("x", "s");
    expect((await vaultError(() => missing.open(sealed, "s"))).code).toBe("secrets_key_unavailable");

    const short = SecretVault.fromEnv({ SECRETS_ENCRYPTION_KEY: "x".repeat(MIN_KEY_CHARS - 1) });
    expect(short.enabled).toBe(false);
    expect(short.disabledReason).toBe("secrets_key_too_short");
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
  });

  it("sealJson wraps whole values and openJson passes legacy values through", async () => {
    const value = { bases: ["tok-1"], token: { accessToken: "tok-2" } };
    const envelope = await sealJson(vault, value, "rot");
    expect(isSealedEnvelope(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("tok-");
    expect(await openJson(vault, envelope, "rot")).toEqual(value);
    expect(await openJson(vault, value, "rot")).toEqual(value);
    expect(isSealedEnvelope({ sealed: "not-an-envelope" })).toBe(false);
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

  it("pre-vault grant rows still open, so existing sign-ins survive the deploy", async () => {
    const legacy = JSON.stringify({ accessToken: "legacy-access", tokenEndpoint: "https://idp.test/token", clientId: "c" });
    const opened = await openGrantPayload(vault, "o@x", "linear", legacy);
    expect(opened?.accessToken).toBe("legacy-access");
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
    expect(await openRotationValue(vault, "o@x", "srv", rotation)).toEqual(rotation);
  });

  it("names distinct scopes for the pending-flow columns", () => {
    expect(oauthPendingFieldScope("o@x", "st", "verifier")).toBe("mcp-oauth-pending:o@x:st#verifier");
    expect(oauthPendingFieldScope("o@x", "st", "authorization_code")).toBe(
      "mcp-oauth-pending:o@x:st#authorization_code",
    );
    expect(deviceCodeScope("o@x", "flow")).toBe("mcp-github-device:o@x:flow#device_code");
  });
});
