import { describe, expect, it } from "vitest";

import {
  clampComposerOffset,
  isDefaultOffset,
  parseComposerOffset,
} from "@/lib/composer-position";

describe("parseComposerOffset", () => {
  it("returns null for empty or garbage input", () => {
    expect(parseComposerOffset(null)).toBeNull();
    expect(parseComposerOffset(undefined)).toBeNull();
    expect(parseComposerOffset("")).toBeNull();
    expect(parseComposerOffset("not-json")).toBeNull();
    expect(parseComposerOffset("[]")).toBeNull();
    expect(parseComposerOffset("{\"x\":\"1\",\"y\":2}")).toBeNull();
    expect(parseComposerOffset("{\"x\":1}")).toBeNull();
    expect(parseComposerOffset("{\"x\":NaN,\"y\":1}")).toBeNull();
    expect(parseComposerOffset("{\"x\":1,\"y\":Infinity}")).toBeNull();
  });

  it("treats the default dock as unset", () => {
    expect(parseComposerOffset("{\"x\":0,\"y\":0}")).toBeNull();
  });

  it("rounds a valid offset", () => {
    expect(parseComposerOffset("{\"x\":12.6,\"y\":40.2}")).toEqual({ x: 13, y: 40 });
  });
});

describe("isDefaultOffset", () => {
  it("treats null and zeros as the stock dock", () => {
    expect(isDefaultOffset(null)).toBe(true);
    expect(isDefaultOffset(undefined)).toBe(true);
    expect(isDefaultOffset({ x: 0, y: 0 })).toBe(true);
    expect(isDefaultOffset({ x: 1, y: 0 })).toBe(false);
  });
});

describe("clampComposerOffset", () => {
  const pane = { width: 800, height: 600 };
  const box = { width: 400, height: 160 };

  it("keeps a centered dock in place", () => {
    expect(clampComposerOffset({ x: 0, y: 0 }, pane, box)).toEqual({ x: 0, y: 0 });
  });

  it("clamps horizontal travel so the card stays on screen", () => {
    // defaultLeft = (800-400)/2 = 200, so x ∈ [-200, 200]
    expect(clampComposerOffset({ x: -500, y: 10 }, pane, box)).toEqual({ x: -200, y: 10 });
    expect(clampComposerOffset({ x: 500, y: 10 }, pane, box)).toEqual({ x: 200, y: 10 });
  });

  it("clamps vertical travel between the bottom and the top of the pane", () => {
    expect(clampComposerOffset({ x: 0, y: -40 }, pane, box)).toEqual({ x: 0, y: 0 });
    expect(clampComposerOffset({ x: 0, y: 900 }, pane, box)).toEqual({ x: 0, y: 440 });
  });

  it("pins a full-width card to x = 0", () => {
    expect(clampComposerOffset({ x: 80, y: 20 }, pane, { width: 800, height: 100 })).toEqual({
      x: 0,
      y: 20,
    });
  });

  it("does not travel when the pane is smaller than the card", () => {
    expect(clampComposerOffset({ x: 40, y: 40 }, { width: 100, height: 80 }, { width: 400, height: 160 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});
