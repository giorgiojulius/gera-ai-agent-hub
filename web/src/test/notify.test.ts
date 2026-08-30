// Completion signals: the pure chime-scope rule and the normalization of the
// new notification/composer settings (defaults, explicit choices, garbage).
import { describe, expect, it } from "vitest";

import { normalizeStoredSettings } from "@/lib/history";
import { shouldPlaySound } from "@/lib/notify";

describe("shouldPlaySound", () => {
  it("never plays when off", () => {
    expect(shouldPlaySound("off", true)).toBe(false);
    expect(shouldPlaySound("off", false)).toBe(false);
  });

  it("always plays when always", () => {
    expect(shouldPlaySound("always", true)).toBe(true);
    expect(shouldPlaySound("always", false)).toBe(true);
  });

  it("background plays only for out-of-view finishes", () => {
    expect(shouldPlaySound("background", true)).toBe(true);
    expect(shouldPlaySound("background", false)).toBe(false);
  });
});

describe("notification settings normalization", () => {
  it("defaults: background chime, no desktop notifications, Enter sends", () => {
    const settings = normalizeStoredSettings({});
    expect(settings.notifySound).toBe("background");
    expect(settings.notifyDesktop).toBe(false);
    expect(settings.enterSends).toBe(true);
  });

  it("keeps explicit choices", () => {
    const settings = normalizeStoredSettings({
      notifySound: "always",
      notifyDesktop: true,
      enterSends: false,
    });
    expect(settings.notifySound).toBe("always");
    expect(settings.notifyDesktop).toBe(true);
    expect(settings.enterSends).toBe(false);
  });

  it("falls back on garbage values instead of crashing or mis-reading them", () => {
    const settings = normalizeStoredSettings({
      notifySound: "loud",
      notifyDesktop: "yes",
      enterSends: "no",
    } as unknown);
    expect(settings.notifySound).toBe("background");
    expect(settings.notifyDesktop).toBe(false);
    expect(settings.enterSends).toBe(true);
  });
});

// The home strip (projects/screens) and the composer profile row are on by
// default; only an explicit false hides them.
describe("shortcut settings normalization", () => {
  it("defaults both shortcut strips to on", () => {
    const settings = normalizeStoredSettings({});
    expect(settings.homeShortcuts).toBe(true);
    expect(settings.composerProfiles).toBe(true);
  });

  it("keeps an explicit off", () => {
    const settings = normalizeStoredSettings({ homeShortcuts: false, composerProfiles: false });
    expect(settings.homeShortcuts).toBe(false);
    expect(settings.composerProfiles).toBe(false);
  });

  it("treats garbage as the default on", () => {
    const settings = normalizeStoredSettings({ homeShortcuts: "nope", composerProfiles: 0 } as unknown);
    expect(settings.homeShortcuts).toBe(true);
    expect(settings.composerProfiles).toBe(true);
  });
});
