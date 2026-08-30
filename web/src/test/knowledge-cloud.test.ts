/**
 * Stage-3 knowledge tests: cloud placement decisions, local excerpts, OCR
 * page batching, and full-text resolution with honest fallbacks. Everything
 * here is pure or dependency-injected — no network, no IndexedDB.
 */

import { describe, expect, it, vi } from "vitest";

import { ocrPageBatches } from "@/lib/file-extract";
import {
  LOCAL_EXCERPT_CHARS,
  capKnowledgeText,
  formatDocSize,
  knowledgeFullChars,
  makeLocalExcerpt,
  planKnowledgePlacement,
} from "@/lib/knowledge";
import { resolveKnowledgeDocs } from "@/lib/knowledge-store";
import type { KnowledgeDoc } from "@/lib/types";

const doc = (over: Partial<KnowledgeDoc>): KnowledgeDoc => ({
  id: "d1",
  name: "doc.txt",
  text: "local excerpt",
  addedAt: 1,
  ...over,
});

describe("planKnowledgePlacement", () => {
  it("keeps small files local when the budget fits", () => {
    expect(planKnowledgePlacement(100_000, 1_000_000)).toBe("local");
    expect(planKnowledgePlacement(50_000, 50_000)).toBe("local");
  });

  it("sends oversized files to the cloud", () => {
    expect(planKnowledgePlacement(120_001, 10_000_000)).toBe("cloud");
  });

  it("sends local-budget overflow to the cloud instead of refusing", () => {
    expect(planKnowledgePlacement(50_000, 40_000)).toBe("cloud");
  });
});

describe("makeLocalExcerpt", () => {
  it("returns short text unchanged", () => {
    expect(makeLocalExcerpt("hello")).toBe("hello");
  });

  it("caps long text with an honest cloud marker", () => {
    const full = "x".repeat(LOCAL_EXCERPT_CHARS + 5_000);
    const excerpt = makeLocalExcerpt(full);
    expect(excerpt.length).toBeLessThan(full.length);
    expect(excerpt.startsWith("x".repeat(100))).toBe(true);
    expect(excerpt).toContain("cloud storage");
  });

  it("strips NUL bytes", () => {
    expect(makeLocalExcerpt("a\u0000b")).toBe("ab");
  });
});

describe("capKnowledgeText with a custom cap", () => {
  it("uses the provided cap in the trim marker", () => {
    const trimmed = capKnowledgeText("abcdefghijklmnop", 10);
    expect(trimmed).toContain("abcdefghij");
    expect(trimmed).toContain("[file trimmed at 10 characters]");
  });
});

describe("formatDocSize", () => {
  it("formats chars, thousands, and millions", () => {
    expect(formatDocSize(500)).toBe("500 chars");
    expect(formatDocSize(12_345)).toBe("12k chars");
    expect(formatDocSize(1_234_567)).toBe("1.2M chars");
  });
});

describe("knowledgeFullChars", () => {
  it("counts the cloud copy for cloud-stored docs", () => {
    const docs = [doc({ text: "abc" }), doc({ id: "d2", text: "abc", r2Key: "k", fullChars: 100 })];
    expect(knowledgeFullChars(docs)).toBe(103);
  });
});

describe("ocrPageBatches", () => {
  it("groups pages into ordered batches", () => {
    expect(ocrPageBatches(10, 4, 40)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10],
    ]);
  });

  it("returns nothing for an empty document", () => {
    expect(ocrPageBatches(0)).toEqual([]);
  });

  it("honours the page ceiling", () => {
    const pages = ocrPageBatches(200, 4, 40).flat();
    expect(pages).toHaveLength(40);
    expect(pages[pages.length - 1]).toBe(40);
  });
});

describe("resolveKnowledgeDocs", () => {
  it("leaves local docs untouched without calling the fetcher", async () => {
    const fetcher = vi.fn(async () => "never");
    const out = await resolveKnowledgeDocs([doc({})], fetcher);
    expect(out[0].text).toBe("local excerpt");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("swaps in the full cloud text when the fetch succeeds", async () => {
    const out = await resolveKnowledgeDocs(
      [doc({ r2Key: "k", fullChars: 15 })],
      async () => "full cloud text",
    );
    expect(out[0].text).toBe("full cloud text");
    expect(out[0].r2Key).toBe("k");
  });

  it("keeps the local excerpt when the fetch fails or is empty", async () => {
    const empty = await resolveKnowledgeDocs([doc({ r2Key: "k" })], async () => null);
    expect(empty[0].text).toBe("local excerpt");
    const thrown = await resolveKnowledgeDocs([doc({ r2Key: "k" })], async () => {
      throw new Error("offline");
    });
    expect(thrown[0].text).toBe("local excerpt");
  });
});
