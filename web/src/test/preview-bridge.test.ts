import { describe, expect, it } from "vitest";

import {
  MAX_PREVIEW_TABS,
  parsePreviewBridgeMessage,
  previewBase,
  previewRoutePath,
  routePreviewPopup,
  sanitizePopupFeatures,
} from "@/lib/preview-bridge";

const previewUrl = `https://gera-backend.rork.app/repo-preview/${"a".repeat(24)}.${"b".repeat(32)}.${"c".repeat(24)}/${"d".repeat(48)}/`;

describe("preview bridge routing", () => {
  it("keeps pages under the artifact root inside the panel and sends other sites to the browser", () => {
    expect(routePreviewPopup(`${previewUrl}settings?tab=1#x`, previewUrl)).toEqual({ kind: "tab", url: `${previewUrl}settings?tab=1#x` });
    expect(routePreviewPopup("docs/", previewUrl)).toEqual({ kind: "tab", url: `${previewUrl}docs/` });
    expect(routePreviewPopup("https://github.com/login/oauth/authorize?client_id=x", previewUrl)).toEqual({
      kind: "external",
      url: "https://github.com/login/oauth/authorize?client_id=x",
    });
    expect(routePreviewPopup("http://localhost:5173/callback", previewUrl)).toEqual({ kind: "external", url: "http://localhost:5173/callback" });
  });

  it("folds root-relative and other same-origin paths back under the artifact root", () => {
    // An app built for `/` that opens `/settings` must land in its own namespace, never on the raw backend.
    expect(routePreviewPopup("/settings?tab=1", previewUrl)).toEqual({ kind: "tab", url: `${previewUrl}settings?tab=1` });
    expect(routePreviewPopup("https://gera-backend.rork.app/mcp/oauth/callback#x", previewUrl)).toEqual({
      kind: "tab",
      url: `${previewUrl}mcp/oauth/callback#x`,
    });
    expect(routePreviewPopup("https://gera-backend.rork.app/repo-preview/other-id/x/", previewUrl)).toEqual({
      kind: "tab",
      url: `${previewUrl}repo-preview/other-id/x/`,
    });
  });

  it("refuses non-web schemes, embedded credentials and garbage", () => {
    expect(routePreviewPopup("javascript:alert(1)", previewUrl)).toEqual({ kind: "blocked", reason: "scheme" });
    expect(routePreviewPopup("data:text/html,hi", previewUrl)).toEqual({ kind: "blocked", reason: "scheme" });
    expect(routePreviewPopup("https://user:pw@evil.example/", previewUrl)).toEqual({ kind: "blocked", reason: "credentials" });
    expect(routePreviewPopup("::not a url::", "not-a-url")).toEqual({ kind: "blocked", reason: "invalid-url" });
  });

  it("derives the in-app route for the address bar and tab labels", () => {
    expect(previewBase(`${previewUrl}index.html?x=1`)?.href).toBe(previewUrl);
    expect(previewRoutePath(previewUrl, previewUrl)).toBe("/");
    expect(previewRoutePath(`${previewUrl}index.html`, previewUrl)).toBe("/");
    expect(previewRoutePath(`${previewUrl}settings?tab=1#x`, previewUrl)).toBe("/settings?tab=1#x");
    expect(previewRoutePath(null, previewUrl)).toBe("/");
    expect(previewRoutePath("about:srcdoc", previewUrl)).toBe("/");
    expect(previewRoutePath("https://elsewhere.example/a", previewUrl)).toBe("/");
  });

  it("accepts only the documented message shapes and bounds their strings", () => {
    expect(parsePreviewBridgeMessage(null)).toBeNull();
    expect(parsePreviewBridgeMessage("open")).toBeNull();
    expect(parsePreviewBridgeMessage({ source: "other", type: "open", url: "https://x" })).toBeNull();
    expect(parsePreviewBridgeMessage({ source: "gera-preview", type: "open", url: 42 })).toBeNull();
    expect(parsePreviewBridgeMessage({ source: "gera-preview", type: "open", url: "https://x/" })).toEqual({
      type: "open",
      url: "https://x/",
      target: "_blank",
      id: null,
      features: "",
    });
    // A proxied `window.open`: the popup id rides along, placement hints survive, opener-severing tokens do not.
    expect(
      parsePreviewBridgeMessage({ source: "gera-preview", type: "open", url: "https://x/", target: "oauth", id: "w2", features: "popup,width=560,noopener,noreferrer" }),
    ).toEqual({ type: "open", url: "https://x/", target: "oauth", id: "w2", features: "popup,width=560" });
    const badId = parsePreviewBridgeMessage({ source: "gera-preview", type: "open", url: "https://x/", id: "../w" });
    expect(badId?.type === "open" ? badId.id : "unexpected").toBeNull();
    expect(parsePreviewBridgeMessage({ source: "gera-preview", type: "close", id: "w2" })).toEqual({ type: "close", id: "w2" });
    expect(parsePreviewBridgeMessage({ source: "gera-preview", type: "close" })).toBeNull();
    expect(parsePreviewBridgeMessage({ source: "gera-preview", type: "focus", id: 7 })).toBeNull();
    expect(parsePreviewBridgeMessage({ source: "gera-preview", type: "message", id: "w2", data: { hello: 1 }, targetOrigin: "https://auth.example" })).toEqual({
      type: "message",
      id: "w2",
      data: { hello: 1 },
      targetOrigin: "https://auth.example",
    });
    expect(parsePreviewBridgeMessage({ source: "gera-preview", type: "message", id: "w2" })?.type).toBe("message");
    expect(parsePreviewBridgeMessage({ source: "gera-preview", type: "state", href: "https://x/a", title: `  ${"t".repeat(300)} ` })).toEqual({
      type: "state",
      href: "https://x/a",
      title: "t".repeat(200),
    });
    expect(parsePreviewBridgeMessage({ source: "gera-preview", type: "evil" })).toBeNull();
    expect(MAX_PREVIEW_TABS).toBeGreaterThan(1);
  });

  it("keeps window placement hints but never lets the app sever the proxy's handle", () => {
    expect(sanitizePopupFeatures("")).toBe("");
    expect(sanitizePopupFeatures(" popup, width=500 ,height=650")).toBe("popup,width=500,height=650");
    expect(sanitizePopupFeatures("noopener,noreferrer=yes,width=1")).toBe("width=1");
    expect(sanitizePopupFeatures("x".repeat(1_000)).length).toBe(256);
  });
});
