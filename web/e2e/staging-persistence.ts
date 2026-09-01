#!/usr/bin/env bun

/** Real Chromium reconnect against the public Cloudflare staging backend. */
import { chromium } from "playwright";

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const webUrl = required("STAGING_WEB_URL");
const backendUrl = required("STAGING_BACKEND_URL");
const accessToken = required("STAGING_ACCESS_TOKEN");
const chatMarker = required("STAGING_CHAT_MARKER");
const runMarker = required("STAGING_RUN_MARKER");
const redactionSentinel = required("STAGING_REDACTION_SENTINEL");
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext();
  await context.addInitScript((token: string) => {
    const seeded = window.localStorage.getItem("gera:staging-browser-seeded") === "1";
    if (!seeded) {
      window.localStorage.clear();
      window.localStorage.setItem("gera:staging-browser-seeded", "1");
    }
    window.localStorage.setItem("rork:access_token", token);
    if (!window.localStorage.getItem("rork:auth_session_nonce")) {
      window.localStorage.setItem("rork:auth_session_nonce", crypto.randomUUID());
    }
  }, accessToken);

  const page = await context.newPage();
  let syncResponses = 0;
  let responseCredentialLeak = false;
  const responseBodyReads: Promise<void>[] = [];
  page.on("response", (response) => {
    if (response.url().startsWith(`${backendUrl}/chats/sync`)) {
      syncResponses += 1;
      responseBodyReads.push(response.text().then((body) => {
        if (
          /"(?:access_?token|refresh_?token|client_?secret|code_?verifier|authorization_?code|token|headersJson|Authorization)"\s*:/i.test(body) ||
          body.includes(redactionSentinel)
        ) {
          responseCredentialLeak = true;
        }
      }).catch(() => undefined));
    }
  });
  const firstSync = page.waitForResponse(
    (response) => response.url().startsWith(`${backendUrl}/chats/sync`) && response.status() === 200,
    { timeout: 40_000 },
  );
  await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await firstSync;
  await page.waitForFunction(
    ({ expectedChat, expectedRun }) => {
      try {
        const conversations = JSON.parse(window.localStorage.getItem("gera.conversations.v1") ?? "[]") as unknown;
        const serialized = JSON.stringify(conversations);
        return serialized.includes(expectedChat) && serialized.includes(expectedRun);
      } catch {
        return false;
      }
    },
    { expectedChat: chatMarker, expectedRun: runMarker },
    { timeout: 40_000 },
  );
  const hydrated = await page.evaluate(
    ({ expectedChat, expectedRun }) => {
      const serialized = window.localStorage.getItem("gera.conversations.v1") ?? "";
      return serialized.includes(expectedChat) && serialized.includes(expectedRun);
    },
    { expectedChat: chatMarker, expectedRun: runMarker },
  );

  const reconnectSync = page.waitForResponse(
    (response) => response.url().startsWith(`${backendUrl}/chats/sync`) && response.status() === 200,
    { timeout: 40_000 },
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await reconnectSync;
  await page.waitForFunction(
    ({ expectedChat, expectedRun }) => {
      const serialized = window.localStorage.getItem("gera.conversations.v1") ?? "";
      return serialized.includes(expectedChat) && serialized.includes(expectedRun);
    },
    { expectedChat: chatMarker, expectedRun: runMarker },
    { timeout: 30_000 },
  );
  const result = await page.evaluate(
    ({ expectedChat, expectedRun }) => {
      const serialized = window.localStorage.getItem("gera.conversations.v1") ?? "";
      const hasCredential = (storage: Storage, key: string): boolean => {
        if (key === "gera.mcp.oauth.tokens.v1") {
          return (storage.getItem(key) ?? "{}") !== "{}";
        }
        return key.startsWith("gera.mcp.oauth.token.v2.") && Boolean(storage.getItem(key));
      };
      const credentialKeys = [
        ...Object.keys(window.localStorage).filter((key) => hasCredential(window.localStorage, key)),
        ...Object.keys(window.sessionStorage).filter((key) => hasCredential(window.sessionStorage, key)),
      ];
      return {
        hydrated: serialized.includes(expectedChat) && serialized.includes(expectedRun),
        reloaded: serialized.includes(expectedChat) && serialized.includes(expectedRun),
        oauthCredentialKeys: credentialKeys.length,
      };
    },
    { expectedChat: chatMarker, expectedRun: runMarker },
  );
  await Promise.all(responseBodyReads);
  const browserStores = await page.evaluate(async () => {
    const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    const cacheNames = "caches" in window ? await caches.keys() : [];
    return [...databases.map((item) => item.name ?? ""), ...cacheNames]
      .filter((name) => /oauth|credential|token/i.test(name)).length;
  });
  const storageCanaryLeak = await page.evaluate((sentinel: string) =>
    [window.localStorage, window.sessionStorage].some((storage) =>
      Object.keys(storage).some((key) => (storage.getItem(key) ?? "").includes(sentinel)),
    ), redactionSentinel);
  const finalResult = {
    ...result,
    syncResponses,
    responseCredentialLeak,
    oauthCredentialStores: browserStores,
    storageCanaryLeak,
  };
  if (
    !hydrated ||
    !result.reloaded ||
    result.oauthCredentialKeys !== 0 ||
    browserStores !== 0 ||
    syncResponses < 2 ||
    responseCredentialLeak ||
    storageCanaryLeak
  ) {
    throw new Error("frontend persistence assertion failed");
  }
  console.log(`STAGING_BROWSER_RESULT=${JSON.stringify(finalResult)}`);
  await context.close();
} finally {
  await browser.close();
}
