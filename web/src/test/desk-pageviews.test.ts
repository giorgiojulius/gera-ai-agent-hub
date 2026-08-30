import { describe, expect, it } from "vitest";

import {
  PAGE_VIEW_BATCH_LIMIT,
  pageViewContactKeys,
  parsePageViewPayload,
  TRACKER_JS,
} from "../../../functions/desk-pageviews";

const KEY = "k".repeat(16);

describe("parsePageViewPayload", () => {
  it("maps a valid beacon, lowercases the email, and sorts views oldest-first", () => {
    const now = 1_000_000_000_000;
    const parsed = parsePageViewPayload(
      {
        k: KEY,
        email: " Anna@Site.COM ",
        userId: 42,
        views: [
          { url: "https://site.com/pricing", title: "Pricing", at: now - 1_000 },
          { url: "https://site.com/", title: "Home", at: now - 5_000 },
        ],
      },
      now,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.email).toBe("anna@site.com");
    expect(parsed?.userId).toBe("42");
    expect(parsed?.views.map((view) => view.title)).toEqual(["Home", "Pricing"]);
  });

  it("clamps timestamps into [now − 7d, now + 5m] and defaults missing ones to now", () => {
    const now = 1_000_000_000_000;
    const parsed = parsePageViewPayload(
      {
        k: KEY,
        email: "a@b.co",
        views: [
          { url: "https://s.com/old", at: 1 },
          { url: "https://s.com/future", at: now + 60 * 60 * 1000 },
          { url: "https://s.com/none" },
        ],
      },
      now,
    );
    const byUrl = new Map(parsed?.views.map((view) => [view.url, view.at]));
    expect(byUrl.get("https://s.com/old")).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(byUrl.get("https://s.com/future")).toBe(now + 5 * 60 * 1000);
    expect(byUrl.get("https://s.com/none")).toBe(now);
  });

  it("drops non-http(s) and unparseable URLs", () => {
    const parsed = parsePageViewPayload({
      k: KEY,
      email: "a@b.co",
      views: [{ url: "javascript:alert(1)" }, { url: "not a url" }, { url: "https://ok.example/page" }],
    });
    expect(parsed?.views.map((view) => view.url)).toEqual(["https://ok.example/page"]);
  });

  it("caps a beacon at the batch limit", () => {
    const views = Array.from({ length: 25 }, (_, index) => ({ url: `https://s.com/${index}` }));
    const parsed = parsePageViewPayload({ k: KEY, email: "a@b.co", views });
    expect(parsed?.views).toHaveLength(PAGE_VIEW_BATCH_LIMIT);
  });

  it("refuses beacons without identity, without views, or with a short key", () => {
    const view = { url: "https://s.com/" };
    expect(parsePageViewPayload({ k: KEY, email: "not-an-email", views: [view] })).toBeNull();
    expect(parsePageViewPayload({ k: KEY, email: "a@b.co", views: [] })).toBeNull();
    expect(parsePageViewPayload({ k: "short", email: "a@b.co", views: [view] })).toBeNull();
  });
});

describe("pageViewContactKeys", () => {
  it("keys by lowercased email and external user id", () => {
    expect(pageViewContactKeys(" Anna@Site.com ", " 42 ")).toEqual(["em:anna@site.com", "uid:42"]);
  });

  it("skips missing identities honestly", () => {
    expect(pageViewContactKeys("", "42")).toEqual(["uid:42"]);
    expect(pageViewContactKeys("no-at-sign", "")).toEqual([]);
  });
});

describe("TRACKER_JS", () => {
  it("auto-identifies from Intercom Messenger and hooks SPA navigation", () => {
    expect(TRACKER_JS).toContain("intercomSettings");
    expect(TRACKER_JS).toContain("sendBeacon");
    expect(TRACKER_JS).toContain("pushState");
    expect(TRACKER_JS).toContain("geraPageViews");
  });
});
