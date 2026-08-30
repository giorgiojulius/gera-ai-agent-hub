import { describe, expect, it } from "vitest";

import { clampImageCount, MAX_IMAGE_COUNT, parseImageCount } from "@/lib/image-count";

describe("parseImageCount", () => {
  it("reads digit counts before Russian media nouns", () => {
    expect(parseImageCount("Сделай 4 картинки кота")).toBe(4);
    expect(parseImageCount("нарисуй 2 варианта логотипа")).toBe(2);
    expect(parseImageCount("сделай 3 разных постера")).toBe(3);
    expect(parseImageCount("котов, 5 штук")).toBe(5);
  });

  it("reads digit counts before English media nouns", () => {
    expect(parseImageCount("make 4 images of a fox")).toBe(4);
    expect(parseImageCount("generate 2 pics please")).toBe(2);
    expect(parseImageCount("3 wallpapers with mountains")).toBe(3);
  });

  it("reads number words in both languages", () => {
    expect(parseImageCount("нарисуй три варианта логотипа")).toBe(3);
    expect(parseImageCount("сделай пару изображений заката")).toBe(2);
    expect(parseImageCount("несколько фотографий пляжа")).toBe(3);
    expect(parseImageCount("four versions of the logo")).toBe(4);
    expect(parseImageCount("a couple of pictures of Rome")).toBe(2);
    expect(parseImageCount("several renders of the chair")).toBe(3);
  });

  it("reads multiplier shorthand", () => {
    expect(parseImageCount("neon skyline x4")).toBe(4);
    expect(parseImageCount("постер 4x")).toBe(4);
    expect(parseImageCount("аватар х3")).toBe(3);
  });

  it("returns the raw count even above the cap", () => {
    expect(parseImageCount("10 картинок с котами")).toBe(10);
  });

  it("ignores prompts without an explicit count", () => {
    expect(parseImageCount("нарисуй кота на стуле")).toBeNull();
    expect(parseImageCount("сделай картинку заката")).toBeNull();
    expect(parseImageCount("a poster of a lion")).toBeNull();
  });

  it("never mistakes sizes or 4x4 for a count", () => {
    expect(parseImageCount("poster 1024x1536 style")).toBeNull();
    expect(parseImageCount("a 4x4 truck in the desert")).toBeNull();
    expect(parseImageCount("wallpaper in 4k")).toBeNull();
  });
});

describe("clampImageCount", () => {
  it("clamps into the 1..MAX range", () => {
    expect(clampImageCount(0)).toBe(1);
    expect(clampImageCount(10)).toBe(MAX_IMAGE_COUNT);
    expect(clampImageCount(2.6)).toBe(3);
    expect(clampImageCount(Number.NaN)).toBe(1);
  });
});
