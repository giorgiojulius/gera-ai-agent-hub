import { describe, expect, it } from "vitest";

import { fallbackQuery } from "@/lib/grounding";

describe("fallbackQuery", () => {
  it("collapses whitespace and trims", () => {
    expect(fallbackQuery("  что   нового\n\nв  react 19?  ")).toBe("что нового в react 19?");
  });

  it("caps the query at 160 characters", () => {
    const long = "a".repeat(500);
    expect(fallbackQuery(long)).toHaveLength(160);
  });

  it("keeps short prompts intact", () => {
    expect(fallbackQuery("курс биткоина")).toBe("курс биткоина");
  });

  it("returns an empty string for blank input", () => {
    expect(fallbackQuery("   \n  ")).toBe("");
  });
});
