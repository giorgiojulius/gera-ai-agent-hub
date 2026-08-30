// Create-the-Slack-bot-from-Gera contracts: the app manifest Gera mints via
// apps.manifest.create, credential parsing from Slack's response, and the
// signed OAuth install state that rides the callback.
import { describe, expect, it } from "vitest";

import {
  SLACK_BOT_SCOPES,
  SLACK_CONFIG_ROTATE_MARGIN_MS,
  buildSlackAppManifest,
  buildSlackInstallState,
  classifySlackConfigToken,
  decodeSlackInstallState,
  isSlackConfigAccessFresh,
  parseSlackAppCreation,
  parseSlackConfigRotation,
  slackAuthorizeUrl,
  verifySlackInstallState,
} from "../../../functions/native-slack";

describe("buildSlackAppManifest", () => {
  it("names the app and bot after the agent", () => {
    const manifest = buildSlackAppManifest({
      botName: "Repo Guide",
      redirectUrl: "https://w.example/slack/oauth/callback",
    });
    const display = manifest.display_information as Record<string, unknown>;
    const features = manifest.features as { bot_user: Record<string, unknown> };
    expect(display.name).toBe("Repo Guide");
    expect(features.bot_user.display_name).toBe("Repo Guide");
  });

  it("clamps the name to Slack's 35-char limit and falls back when blank", () => {
    const long = buildSlackAppManifest({ botName: "x".repeat(60), redirectUrl: "https://w.example/cb" });
    expect(((long.display_information as Record<string, unknown>).name as string).length).toBe(35);
    const blank = buildSlackAppManifest({ botName: "   ", redirectUrl: "https://w.example/cb" });
    expect((blank.display_information as Record<string, unknown>).name).toBe("Gera Agent");
  });

  it("registers the OAuth redirect and the full bot scope set", () => {
    const manifest = buildSlackAppManifest({
      botName: "A",
      redirectUrl: "https://w.example/slack/oauth/callback",
    });
    const oauth = manifest.oauth_config as { redirect_urls: string[]; scopes: { bot: string[] } };
    expect(oauth.redirect_urls).toEqual(["https://w.example/slack/oauth/callback"]);
    expect(oauth.scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
    expect(oauth.scopes.bot).toContain("app_mentions:read");
    expect(oauth.scopes.bot).toContain("chat:write");
    expect(oauth.scopes.bot).toContain("channels:history");
  });

  it("adds event subscriptions only when the events URL is provided", () => {
    const bare = buildSlackAppManifest({ botName: "A", redirectUrl: "https://w.example/cb" });
    expect((bare.settings as Record<string, unknown>).event_subscriptions).toBeUndefined();
    const wired = buildSlackAppManifest({
      botName: "A",
      redirectUrl: "https://w.example/cb",
      eventsUrl: "https://w.example/slack/events/p1/a1",
    });
    expect((wired.settings as Record<string, unknown>).event_subscriptions).toEqual({
      request_url: "https://w.example/slack/events/p1/a1",
      bot_events: ["app_mention"],
    });
  });
});

describe("parseSlackAppCreation", () => {
  it("extracts app id + credentials from the create response", () => {
    expect(
      parseSlackAppCreation({
        ok: true,
        app_id: "A0AB12CD3",
        credentials: {
          client_id: "111.222",
          client_secret: "cs-secret",
          verification_token: "vt",
          signing_secret: "ss-secret",
        },
        oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=111.222",
      }),
    ).toEqual({
      appId: "A0AB12CD3",
      clientId: "111.222",
      clientSecret: "cs-secret",
      signingSecret: "ss-secret",
    });
  });

  it("returns null when any credential is missing", () => {
    expect(parseSlackAppCreation({ ok: true, app_id: "A1" })).toBeNull();
    expect(parseSlackAppCreation({ ok: true, app_id: "A1", credentials: { client_id: "1" } })).toBeNull();
    expect(parseSlackAppCreation({ ok: true, credentials: { client_id: "1", client_secret: "2", signing_secret: "3" } })).toBeNull();
    expect(parseSlackAppCreation({})).toBeNull();
  });
});

describe("Slack install state", () => {
  const payload = { projectId: "p123456789012345678ab", agentId: "aXYZ", exp: Date.now() + 60_000 };

  it("roundtrips build → decode → verify", async () => {
    const state = await buildSlackInstallState("client-secret", payload);
    expect(decodeSlackInstallState(state)).toEqual(payload);
    expect(await verifySlackInstallState("client-secret", state)).toEqual(payload);
  });

  it("rejects a foreign secret and a tampered signature", async () => {
    const state = await buildSlackInstallState("client-secret", payload);
    expect(await verifySlackInstallState("other-secret", state)).toBeNull();
    const [encoded] = state.split(".");
    expect(await verifySlackInstallState("client-secret", `${encoded}.deadbeef`)).toBeNull();
  });

  it("rejects a swapped payload — the signature covers project and agent ids", async () => {
    const state = await buildSlackInstallState("client-secret", payload);
    const forged = await buildSlackInstallState("client-secret", { ...payload, agentId: "attacker" });
    const [, realSig] = state.split(".");
    const [forgedEncoded] = forged.split(".");
    expect(await verifySlackInstallState("client-secret", `${forgedEncoded}.${realSig}`)).toBeNull();
  });

  it("rejects an expired state and garbage input", async () => {
    const stale = await buildSlackInstallState("client-secret", { ...payload, exp: Date.now() - 1 });
    expect(await verifySlackInstallState("client-secret", stale)).toBeNull();
    expect(decodeSlackInstallState("not-a-state")).toBeNull();
    expect(decodeSlackInstallState("")).toBeNull();
    expect(await verifySlackInstallState("client-secret", "junk.junk")).toBeNull();
    expect(await verifySlackInstallState("", "a.b")).toBeNull();
  });
});

describe("slackAuthorizeUrl", () => {
  it("carries client id, the scope list, redirect and state", () => {
    const url = new URL(
      slackAuthorizeUrl("111.222", "https://w.example/slack/oauth/callback", "abc.def"),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("111.222");
    expect(url.searchParams.get("scope")).toBe(SLACK_BOT_SCOPES.join(","));
    expect(url.searchParams.get("redirect_uri")).toBe("https://w.example/slack/oauth/callback");
    expect(url.searchParams.get("state")).toBe("abc.def");
  });
});

describe("slack app-manager connection", () => {
  it("classifies refresh and access tokens", () => {
    expect(classifySlackConfigToken(" xoxe-1-ABC ")).toBe("refresh");
    expect(classifySlackConfigToken("xoxe.xoxp-1-ABC")).toBe("access");
    expect(classifySlackConfigToken("xoxb-123")).toBeNull();
    expect(classifySlackConfigToken("")).toBeNull();
  });

  it("parses a tooling.tokens.rotate response (exp seconds → ms)", () => {
    expect(
      parseSlackConfigRotation({
        ok: true,
        token: "xoxe.xoxp-1-fresh",
        refresh_token: "xoxe-1-next",
        team_id: "T123",
        user_id: "U456",
        exp: 1_700_000_000,
      }),
    ).toEqual({
      accessToken: "xoxe.xoxp-1-fresh",
      refreshToken: "xoxe-1-next",
      teamId: "T123",
      userId: "U456",
      expiresAt: 1_700_000_000_000,
    });
  });

  it("rejects rotate responses missing either token", () => {
    expect(parseSlackConfigRotation({ ok: true, token: "xoxe.xoxp-1-fresh" })).toBeNull();
    expect(parseSlackConfigRotation({ ok: true, refresh_token: "xoxe-1-next" })).toBeNull();
    expect(parseSlackConfigRotation({})).toBeNull();
  });

  it("treats the access token as stale inside the rotate margin", () => {
    const now = 1_000_000_000_000;
    expect(isSlackConfigAccessFresh(now + SLACK_CONFIG_ROTATE_MARGIN_MS + 1_000, now)).toBe(true);
    expect(isSlackConfigAccessFresh(now + SLACK_CONFIG_ROTATE_MARGIN_MS - 1_000, now)).toBe(false);
    expect(isSlackConfigAccessFresh(0, now)).toBe(false);
  });
});
