// Inbound Slack bot contracts: the pure event classifier that decides what
// runs, and the v0 signature check that gates the public events endpoint.
import { describe, expect, it } from "vitest";

import {
  classifySlackEvent,
  stripSlackMention,
  verifySlackSignature,
} from "../../../functions/native-slack";

/** Computes a valid Slack v0 signature the same way Slack does. */
async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  return `v0=${Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("verifySlackSignature", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });

  it("accepts a fresh, correctly signed request", async () => {
    const now = Date.now();
    const ts = String(Math.floor(now / 1000));
    const signature = await sign(secret, ts, body);
    expect(await verifySlackSignature(secret, ts, body, signature, now)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const now = Date.now();
    const ts = String(Math.floor(now / 1000));
    const signature = await sign(secret, ts, body);
    expect(await verifySlackSignature(secret, ts, `${body} `, signature, now)).toBe(false);
  });

  it("rejects stale timestamps — the replay window", async () => {
    const now = Date.now();
    const staleTs = String(Math.floor(now / 1000) - 6 * 60);
    const signature = await sign(secret, staleTs, body);
    expect(await verifySlackSignature(secret, staleTs, body, signature, now)).toBe(false);
  });

  it("rejects wrong secrets and malformed inputs", async () => {
    const now = Date.now();
    const ts = String(Math.floor(now / 1000));
    const foreign = await sign("other-secret", ts, body);
    expect(await verifySlackSignature(secret, ts, body, foreign, now)).toBe(false);
    expect(await verifySlackSignature(secret, null, body, foreign, now)).toBe(false);
    expect(await verifySlackSignature(secret, ts, body, null, now)).toBe(false);
    expect(await verifySlackSignature(secret, ts, body, "v0=zz", now)).toBe(false);
    expect(await verifySlackSignature(secret, "not-a-number", body, foreign, now)).toBe(false);
    expect(await verifySlackSignature("", ts, body, foreign, now)).toBe(false);
  });
});

describe("classifySlackEvent", () => {
  it("echoes url_verification challenges", () => {
    expect(classifySlackEvent({ type: "url_verification", challenge: "abc" })).toEqual({
      kind: "challenge",
      challenge: "abc",
    });
  });

  it("turns app_mention into a runnable mention", () => {
    const decision = classifySlackEvent({
      type: "event_callback",
      event_id: "Ev123",
      event: { type: "app_mention", channel: "C1", ts: "111.222", user: "U7", text: "<@B1> hi" },
    });
    expect(decision).toEqual({
      kind: "mention",
      mention: {
        eventId: "Ev123",
        channel: "C1",
        threadTs: "111.222",
        eventTs: "111.222",
        userId: "U7",
        text: "<@B1> hi",
      },
    });
  });

  it("keeps the existing thread root when mentioned inside a thread", () => {
    const decision = classifySlackEvent({
      type: "event_callback",
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "222.333",
        thread_ts: "111.222",
        user: "U7",
        text: "x",
      },
    });
    expect(decision.kind).toBe("mention");
    if (decision.kind === "mention") {
      expect(decision.mention.threadTs).toBe("111.222");
      expect(decision.mention.eventTs).toBe("222.333");
    }
  });

  it("ignores bot-authored mentions — no reply loops", () => {
    const decision = classifySlackEvent({
      type: "event_callback",
      event: { type: "app_mention", channel: "C1", ts: "1.2", bot_id: "B99", text: "loop" },
    });
    expect(decision.kind).toBe("ignore");
  });

  it("ignores non-mention events and junk payloads", () => {
    expect(
      classifySlackEvent({ type: "event_callback", event: { type: "message", channel: "C1", ts: "1.2" } }).kind,
    ).toBe("ignore");
    expect(classifySlackEvent({ type: "event_callback", event: { type: "app_mention" } }).kind).toBe("ignore");
    expect(classifySlackEvent("nope").kind).toBe("ignore");
    expect(classifySlackEvent(null).kind).toBe("ignore");
  });

  it("falls back to channel:ts when Slack omits event_id", () => {
    const decision = classifySlackEvent({
      type: "event_callback",
      event: { type: "app_mention", channel: "C9", ts: "5.6", user: "U1", text: "t" },
    });
    expect(decision.kind).toBe("mention");
    if (decision.kind === "mention") {
      expect(decision.mention.eventId).toBe("C9:5.6");
    }
  });
});

describe("stripSlackMention", () => {
  it("removes the bot's own mention and tidies whitespace", () => {
    expect(stripSlackMention("<@U42>  deploy status?", "U42")).toBe("deploy status?");
    expect(stripSlackMention("hey <@U42> check <@U7>", "U42")).toBe("hey check <@U7>");
  });

  it("leaves text alone when the bot id is unknown", () => {
    expect(stripSlackMention("<@U42> hi", "")).toBe("<@U42> hi");
  });
});
