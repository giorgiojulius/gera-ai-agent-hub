import { describe, expect, it } from "vitest";

import { clampPanelOffset, isDefaultPanelOffset, parsePanelOffset } from "@/lib/panel-position";

const BASE = { left: 500, top: 300, width: 400, height: 620 };
const VIEWPORT = { width: 1280, height: 960 };

describe("parsePanelOffset", () => {
  it("returns null for empty or garbage input", () => {
    expect(parsePanelOffset(null)).toBeNull();
    expect(parsePanelOffset(undefined)).toBeNull();
    expect(parsePanelOffset("")).toBeNull();
    expect(parsePanelOffset("not-json")).toBeNull();
    expect(parsePanelOffset("[]")).toBeNull();
    expect(parsePanelOffset('{"x":"1","y":2}')).toBeNull();
    expect(parsePanelOffset('{"x":1}')).toBeNull();
  });

  it("treats the default corner seat as unset", () => {
    expect(parsePanelOffset('{"x":0,"y":0}')).toBeNull();
  });

  it("rounds a valid offset", () => {
    expect(parsePanelOffset('{"x":-120.6,"y":35.2}')).toEqual({ x: -121, y: 35 });
  });
});

describe("isDefaultPanelOffset", () => {
  it("treats null and zeros as the stock corner", () => {
    expect(isDefaultPanelOffset(null)).toBe(true);
    expect(isDefaultPanelOffset(undefined)).toBe(true);
    expect(isDefaultPanelOffset({ x: 0, y: 0 })).toBe(true);
    expect(isDefaultPanelOffset({ x: 3, y: 0 })).toBe(false);
  });
});

describe("clampPanelOffset", () => {
  it("keeps an in-bounds offset as is", () => {
    expect(clampPanelOffset({ x: -200, y: -100 }, BASE, VIEWPORT)).toEqual({ x: -200, y: -100 });
  });

  it("stops at every viewport edge with the gutter", () => {
    expect(clampPanelOffset({ x: -9999, y: 0 }, BASE, VIEWPORT).x).toBe(8 - BASE.left);
    expect(clampPanelOffset({ x: 9999, y: 0 }, BASE, VIEWPORT).x).toBe(
      VIEWPORT.width - 8 - BASE.width - BASE.left,
    );
    expect(clampPanelOffset({ x: 0, y: -9999 }, BASE, VIEWPORT).y).toBe(8 - BASE.top);
    expect(clampPanelOffset({ x: 0, y: 9999 }, BASE, VIEWPORT).y).toBe(
      VIEWPORT.height - 8 - BASE.height - BASE.top,
    );
  });

  it("pins a panel taller than the viewport to the top edge so the header stays reachable", () => {
    const clamped = clampPanelOffset({ x: 0, y: 500 }, { ...BASE, height: 2000 }, VIEWPORT);
    expect(clamped.y).toBe(8 - BASE.top);
  });

  it("treats non-finite input as no offset", () => {
    expect(clampPanelOffset({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, BASE, VIEWPORT)).toEqual({
      x: 0,
      y: 0,
    });
  });
});
