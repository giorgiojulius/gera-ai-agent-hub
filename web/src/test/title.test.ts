import { describe, expect, it } from "vitest";

import { cleanGeneratedTitle } from "@/lib/title";

describe("cleanGeneratedTitle", () => {
  it("keeps a clean short title as is", () => {
    expect(cleanGeneratedTitle("План поездки в Токио")).toBe("План поездки в Токио");
    expect(cleanGeneratedTitle("Weekly budget review")).toBe("Weekly budget review");
  });

  it("strips wrapping quotes and trailing punctuation", () => {
    expect(cleanGeneratedTitle("«Рецепт борща».")).toBe("Рецепт борща");
    expect(cleanGeneratedTitle('"Trip to Tokyo!"')).toBe("Trip to Tokyo");
    expect(cleanGeneratedTitle("'Idea list…'")).toBe("Idea list");
  });

  it("strips label prefixes and markdown", () => {
    expect(cleanGeneratedTitle("Title: **Weekly budget**")).toBe("Weekly budget");
    expect(cleanGeneratedTitle("Название — Идеи подарков")).toBe("Идеи подарков");
    expect(cleanGeneratedTitle("# `Deploy checklist`")).toBe("Deploy checklist");
  });

  it("takes the first non-empty line only", () => {
    expect(cleanGeneratedTitle("\n\nПлан тренировок\nи вторая строка")).toBe("План тренировок");
  });

  it("rejects empty and runaway outputs so the fallback survives", () => {
    expect(cleanGeneratedTitle("")).toBeNull();
    expect(cleanGeneratedTitle("   \n  ")).toBeNull();
    expect(cleanGeneratedTitle("…!?")).toBeNull();
    // Longer than 60 chars means the model answered instead of titling.
    expect(cleanGeneratedTitle("a".repeat(80))).toBeNull();
  });

  it("trims 49-60 char titles at a word boundary with an ellipsis", () => {
    const long = "Очень длинное название которое надо аккуратно обрезать";
    expect(long.length).toBeGreaterThan(48);
    expect(long.length).toBeLessThanOrEqual(60);
    const result = cleanGeneratedTitle(long);
    expect(result).not.toBeNull();
    expect(result?.endsWith("…")).toBe(true);
    expect((result ?? "").length).toBeLessThanOrEqual(49);
  });
});
