// Cron fires are the only unauthenticated door into the worker — the HMAC
// check is the lock. These tests pin the exact header contract
// (`sha256=<hex>` over the raw body with CRON_SECRET) and that malformed
// input degrades to a quiet rejection, never a throw.
import { describe, expect, it } from "vitest";

import { verifyCronSignature } from "../../../functions/cron-auth";

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

describe("verifyCronSignature (functions/cron-auth)", () => {
  const secret = "cron-secret-1";
  const body = JSON.stringify({ job: "automations", firedAt: 123 });

  it("accepts the exact sha256=<hex> header for the raw body", async () => {
    const header = await sign(secret, body);
    await expect(verifyCronSignature(secret, body, header)).resolves.toBe(true);
  });

  it("rejects a signature over a different body", async () => {
    const header = await sign(secret, body);
    await expect(verifyCronSignature(secret, `${body} `, header)).resolves.toBe(false);
  });

  it("rejects a signature minted with another secret", async () => {
    const header = await sign("other-secret", body);
    await expect(verifyCronSignature(secret, body, header)).resolves.toBe(false);
  });

  it("rejects missing or malformed headers without throwing", async () => {
    await expect(verifyCronSignature(secret, body, null)).resolves.toBe(false);
    await expect(verifyCronSignature(secret, body, undefined)).resolves.toBe(false);
    await expect(verifyCronSignature(secret, body, "")).resolves.toBe(false);
    const header = await sign(secret, body);
    // Raw hex without the scheme prefix, and a truncated signature.
    await expect(verifyCronSignature(secret, body, header.slice("sha256=".length))).resolves.toBe(false);
    await expect(verifyCronSignature(secret, body, header.slice(0, -2))).resolves.toBe(false);
  });
});
