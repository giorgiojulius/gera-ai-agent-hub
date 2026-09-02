import { describe, expect, it, vi } from "vitest";

import { authInitiateEnv } from "@/lib/auth-tokens";
import {
  PROXIED_POPUP_NAME_PREFIX,
  isProxiedPopupName,
  proxiedPopupName,
  relayAuthCallbackToOpener,
  rorkAuthCallbackPayload,
  trustedRelayOrigins,
} from "@/lib/proxied-popup";

describe("authInitiateEnv", () => {
  it("keeps Rork's own preview iframe on the preview flow and top-level documents on production", () => {
    expect(authInitiateEnv(true, false)).toBe("preview");
    expect(authInitiateEnv(false, false)).toBe("production");
  });

  it("sends a sandboxed (opaque-origin) build to the production flow, whose landing is Gera's own page", () => {
    expect(authInitiateEnv(true, true)).toBe("production");
    expect(authInitiateEnv(false, true)).toBe("production");
  });
});

describe("proxiedPopupName", () => {
  it("mints unique names only Gera's trusted document knows to mint", () => {
    const first = proxiedPopupName();
    const second = proxiedPopupName();
    expect(first.startsWith(PROXIED_POPUP_NAME_PREFIX)).toBe(true);
    expect(isProxiedPopupName(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("recognises nothing else as a proxied popup", () => {
    for (const name of ["_blank", "", "oauth", "gera-preview-popup-", "gera-preview-popup-ab", "GERA-PREVIEW-POPUP-abcdef", 42, null, undefined]) {
      expect(isProxiedPopupName(name)).toBe(false);
    }
  });
});

describe("trustedRelayOrigins", () => {
  it("names the deployment serving the callback page and the project's Rork web preview", () => {
    expect(trustedRelayOrigins("https://gera-ai-agent-hub.rork.app", "4dk0pad86vrg8v41n9wm2")).toEqual([
      "https://gera-ai-agent-hub.rork.app",
      "https://4dk0pad86vrg8v41n9wm2-web.rork.live",
    ]);
  });

  it("never yields a wildcard, an opaque origin, or a project id that is not one", () => {
    expect(trustedRelayOrigins("https://4dk0pad86vrg8v41n9wm2-web.rork.live", "4dk0pad86vrg8v41n9wm2")).toEqual([
      "https://4dk0pad86vrg8v41n9wm2-web.rork.live",
    ]);
    expect(trustedRelayOrigins("https://gera-ai-agent-hub.rork.app", undefined)).toEqual(["https://gera-ai-agent-hub.rork.app"]);
    expect(trustedRelayOrigins("https://gera-ai-agent-hub.rork.app", "evil.example/#")).toEqual([
      "https://gera-ai-agent-hub.rork.app",
    ]);
    expect(trustedRelayOrigins("null", "4dk0pad86vrg8v41n9wm2")).toEqual(["https://4dk0pad86vrg8v41n9wm2-web.rork.live"]);
    expect(trustedRelayOrigins("", "")).toEqual([]);
    expect(trustedRelayOrigins("https://gera-ai-agent-hub.rork.app/path", null)).toEqual([]);
  });
});

describe("rorkAuthCallbackPayload", () => {
  it("carries the authorization code when the landing has one", () => {
    expect(rorkAuthCallbackPayload("?code=abc123&state=s")).toEqual({ type: "rork_auth_callback", code: "abc123" });
  });

  it("carries the provider's refusal otherwise, description first, capped", () => {
    expect(rorkAuthCallbackPayload("?error=access_denied")).toEqual({ type: "rork_auth_callback", error: "access_denied" });
    expect(rorkAuthCallbackPayload("?error=access_denied&error_description=The+user+said+no")).toEqual({
      type: "rork_auth_callback",
      error: "The user said no",
    });
    expect(rorkAuthCallbackPayload(`?error=${"x".repeat(500)}`).error).toHaveLength(200);
    expect(rorkAuthCallbackPayload("")).toEqual({ type: "rork_auth_callback", error: "no_code" });
    expect(rorkAuthCallbackPayload("?code=+")).toEqual({ type: "rork_auth_callback", error: "no_code" });
  });
});

describe("relayAuthCallbackToOpener", () => {
  const payload = { type: "rork_auth_callback" as const, code: "abc" };

  it("posts once per trusted origin so the browser delivers to the one the opener has", () => {
    const postMessage = vi.fn();
    const posted = relayAuthCallbackToOpener({ postMessage }, payload, [
      "https://gera-ai-agent-hub.rork.app",
      "https://4dk0pad86vrg8v41n9wm2-web.rork.live",
    ]);
    expect(posted).toBe(2);
    expect(postMessage.mock.calls).toEqual([
      [payload, "https://gera-ai-agent-hub.rork.app"],
      [payload, "https://4dk0pad86vrg8v41n9wm2-web.rork.live"],
    ]);
    expect(postMessage).not.toHaveBeenCalledWith(expect.anything(), "*");
  });

  it("survives a closed opener and an origin the browser rejects", () => {
    const postMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new DOMException("bad origin", "SyntaxError");
      })
      .mockImplementationOnce(() => undefined);
    expect(relayAuthCallbackToOpener({ postMessage }, payload, ["https://a.example", "https://b.example"])).toBe(1);
    expect(relayAuthCallbackToOpener(null, payload, ["https://a.example"])).toBe(0);
    expect(relayAuthCallbackToOpener(undefined, payload, ["https://a.example"])).toBe(0);
    expect(relayAuthCallbackToOpener({ postMessage: vi.fn() }, payload, [])).toBe(0);
  });
});
