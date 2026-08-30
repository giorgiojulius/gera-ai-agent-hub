import { describe, expect, it } from "vitest";

import {
  MAX_FILE_CHARS,
  capKnowledgeText,
  chunkKnowledge,
  cosineSimilarity,
  fuseScores,
  keywordScoreChunks,
  knowledgeHeader,
  noMatchMessage,
  packExcerpts,
  retrieveKnowledge,
} from "@/lib/knowledge";
import type { KnowledgeDoc } from "@/lib/types";

function doc(name: string, text: string): KnowledgeDoc {
  return { id: name, name, text, addedAt: 0 };
}

describe("capKnowledgeText", () => {
  it("keeps short text untouched and strips NUL bytes", () => {
    expect(capKnowledgeText("hello\u0000world")).toBe("helloworld");
  });

  it("trims oversized text with an honest marker", () => {
    const capped = capKnowledgeText("x".repeat(MAX_FILE_CHARS + 50));
    expect(capped.length).toBeLessThan(MAX_FILE_CHARS + 100);
    expect(capped).toContain("file trimmed at");
  });
});

describe("chunkKnowledge", () => {
  it("splits documents at paragraph boundaries", () => {
    const paragraphs = ["A".repeat(800), "B".repeat(800), "C".repeat(800)];
    const chunks = chunkKnowledge([doc("big.md", paragraphs.join("\n\n"))]);
    expect(chunks.length).toBe(3);
    expect(chunks[0].text).toBe(paragraphs[0]);
    expect(chunks.every((chunk) => chunk.doc === "big.md")).toBe(true);
  });

  it("hard-splits giant paragraphs without line breaks", () => {
    const chunks = chunkKnowledge([doc("blob.json", "z".repeat(3000))]);
    expect(chunks.length).toBe(3);
    expect(chunks[0].text.length).toBe(1200);
    expect(chunks[2].text.length).toBe(600);
  });

  it("keeps small paragraphs together in one chunk", () => {
    const chunks = chunkKnowledge([doc("small.md", "one\n\ntwo\n\nthree")]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain("one");
    expect(chunks[0].text).toContain("three");
  });
});

describe("keywordScoreChunks", () => {
  it("weights rare terms above common ones", () => {
    const common = "the product works well and the team ships fast";
    const chunks = [
      { doc: "a.md", text: `${common}. Общие сведения о компании.` },
      { doc: "a.md", text: `${common}. Refund policy: 30 days, full amount.` },
      { doc: "a.md", text: `${common}. Office hours and locations.` },
    ];
    const scores = keywordScoreChunks(chunks, "what is the refund policy?");
    expect(scores[1]).toBeGreaterThan(scores[0]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });

  it("returns zeros when the query has no usable terms", () => {
    const scores = keywordScoreChunks([{ doc: "a.md", text: "anything" }], "a b");
    expect(scores).toEqual([0]);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical directions and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0);
  });

  it("handles zero vectors without dividing by zero", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("fuseScores", () => {
  it("preserves keyword order when no vectors are available", () => {
    const fused = fuseScores([5, 10, 1], [null, null, null]);
    expect(fused[1]).toBeGreaterThan(fused[0]);
    expect(fused[0]).toBeGreaterThan(fused[2]);
  });

  it("surfaces semantic-only matches when keywords found nothing", () => {
    // The synonym / cross-language case: zero keyword overlap, clear vector hit.
    const fused = fuseScores([0, 0, 0], [null, 0.62, null]);
    expect(fused[1]).toBeGreaterThan(0);
    expect(fused[0]).toBe(0);
    expect(fused[2]).toBe(0);
  });

  it("ranks a chunk strong in both signals above single-signal chunks", () => {
    const fused = fuseScores([10, 5, 0], [null, 0.9, 0.5]);
    expect(fused[1]).toBeGreaterThan(fused[0]);
    expect(fused[0]).toBeGreaterThan(fused[2]);
  });
});

describe("packExcerpts", () => {
  it("always includes the top chunk even when it alone exceeds the budget", () => {
    const packed = packExcerpts([{ doc: "a.md", text: "x".repeat(500) }], 100);
    expect(packed).toContain("[file: a.md]");
  });

  it("stops at the budget once something is packed", () => {
    const packed = packExcerpts(
      [
        { doc: "a.md", text: "x".repeat(90) },
        { doc: "b.md", text: "y".repeat(90) },
      ],
      100,
    );
    expect(packed).toContain("a.md");
    expect(packed).not.toContain("b.md");
  });
});

describe("retrieveKnowledge", () => {
  it("injects the whole base when it fits the budget", () => {
    const result = retrieveKnowledge([doc("a.md", "alpha"), doc("b.md", "beta")], "anything");
    expect(result).toContain("[file: a.md]\nalpha");
    expect(result).toContain("[file: b.md]\nbeta");
    expect(result).toContain(knowledgeHeader("keyword"));
  });

  it("picks the relevant excerpt from a large base", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Chapter ${i}: generic notes about process.`).join("\n\n");
    const result = retrieveKnowledge(
      [doc("big.md", `${filler}\n\nInvoicing: send invoices via Stripe on the 1st.\n\n${filler}`)],
      "how do we send invoices?",
      600,
    );
    expect(result).toContain("Stripe");
  });

  it("lists files honestly when nothing matches", () => {
    const result = retrieveKnowledge(
      [doc("notes.md", "x".repeat(10_000))],
      "quasar hyperdrive",
      600,
    );
    expect(result).toContain("Files on hand: notes.md");
    expect(result).toContain("No excerpt matched");
  });

  it("returns empty string for empty docs", () => {
    expect(retrieveKnowledge([], "query")).toBe("");
    expect(retrieveKnowledge([doc("empty.md", "   ")], "query")).toBe("");
  });
});

describe("noMatchMessage / knowledgeHeader", () => {
  it("keeps the header honest about the retrieval mode", () => {
    expect(knowledgeHeader("keyword")).toContain("keyword-based");
    expect(knowledgeHeader("hybrid")).toContain("hybrid");
  });

  it("names every file on hand", () => {
    const message = noMatchMessage([doc("a.md", "x"), doc("b.pdf", "y")], "HEADER");
    expect(message).toContain("a.md");
    expect(message).toContain("b.pdf");
    expect(message.startsWith("HEADER")).toBe(true);
  });
});
