// Webhook triggers: token generation, URL building, and normalizer honesty —
// the token is the credential, so malformed stored values must die at load.
import { describe, expect, it } from "vitest";

import {
  AUTOMATION_TEMPLATES,
  WEBHOOK_TOKEN_PATTERN,
  newWebhookToken,
  normalizeAutomation,
  webhookUrlFor,
} from "@/lib/automations";

describe("webhook trigger tokens", () => {
  it("generates unique, pattern-valid tokens", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const token = newWebhookToken();
      expect(token).toMatch(WEBHOOK_TOKEN_PATTERN);
      seen.add(token);
    }
    expect(seen.size).toBe(20);
  });

  it("builds the public delivery URL from the token", () => {
    const token = newWebhookToken();
    const url = webhookUrlFor(token);
    expect(url).toContain("://");
    expect(url.endsWith(`/hooks/${token}`)).toBe(true);
  });
});

describe("normalizeAutomation · webhookToken", () => {
  it("defaults to null and keeps a valid token", () => {
    expect(normalizeAutomation({ id: "a1" }).webhookToken).toBeNull();
    const token = newWebhookToken();
    expect(normalizeAutomation({ id: "a1", webhookToken: token }).webhookToken).toBe(token);
  });

  it("rejects malformed stored tokens instead of trusting junk", () => {
    expect(normalizeAutomation({ id: "a1", webhookToken: "not-a-token" }).webhookToken).toBeNull();
    expect(normalizeAutomation({ id: "a1", webhookToken: "wh_short" }).webhookToken).toBeNull();
    expect(normalizeAutomation({ id: "a1", webhookToken: "wh_bad-chars-in-here!!" }).webhookToken).toBeNull();
    expect(
      normalizeAutomation({ id: "a1", webhookToken: 42 as unknown as string }).webhookToken,
    ).toBeNull();
  });

  it("templates ship without webhook triggers", () => {
    for (const template of AUTOMATION_TEMPLATES) {
      expect(template.webhookToken).toBeNull();
    }
  });
});
