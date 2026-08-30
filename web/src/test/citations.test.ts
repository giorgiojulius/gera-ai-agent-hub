import { remapCitations, unifyResearchSources } from "@/lib/citations";
import { createSourceLedger } from "@/lib/tools";
import type { JuliusCandidateState, JuliusState, ResearchSource, ResearchState } from "@/lib/types";

/**
 * The citation pipeline is the product's trust core: a [n] pill must always
 * resolve to a page that was actually read. These tests pin its guarantees.
 */

function research(sources: ResearchSource[]): ResearchState {
  return { status: "done", steps: [], sources, startedAt: 0 };
}

function candidate(content: string, sources?: ResearchSource[]): JuliusCandidateState {
  return {
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    modelId: "test/model",
    content,
    status: "done",
    ...(sources ? { research: research(sources) } : {}),
  };
}

function juliusState(candidates: JuliusCandidateState[]): JuliusState {
  return { decision: "council", status: "debate", candidates, reviews: [], startedAt: 0 };
}

describe("createSourceLedger", () => {
  it("assigns sequential numbers and dedupes by URL", () => {
    const ledger = createSourceLedger();
    expect(ledger.assign("https://a.com/x", "A")).toBe(1);
    expect(ledger.assign("https://b.com/y", "B")).toBe(2);
    expect(ledger.assign("https://a.com/x")).toBe(1);
    expect(ledger.assign("https://c.com/z")).toBe(3);
    expect(ledger.list().map((source) => source.url)).toEqual([
      "https://a.com/x",
      "https://b.com/y",
      "https://c.com/z",
    ]);
  });

  it("treats a URL with surrounding whitespace as the same source", () => {
    const ledger = createSourceLedger();
    expect(ledger.assign(" https://a.com/x ")).toBe(1);
    expect(ledger.assign("https://a.com/x")).toBe(1);
    expect(ledger.list()).toHaveLength(1);
  });

  it("backfills the title when the first sighting had none", () => {
    const ledger = createSourceLedger();
    ledger.assign("https://a.com/x");
    expect(ledger.list()[0].title).toBe("https://a.com/x");
    ledger.assign("https://a.com/x", "Real title");
    expect(ledger.list()[0].title).toBe("Real title");
    ledger.assign("https://a.com/x", "Later title");
    expect(ledger.list()[0].title).toBe("Real title");
  });

  it("returns copies from list() so callers cannot corrupt the ledger", () => {
    const ledger = createSourceLedger();
    ledger.assign("https://a.com/x", "A");
    ledger.list()[0].title = "hacked";
    expect(ledger.list()[0].title).toBe("A");
  });
});

describe("remapCitations", () => {
  const remap = new Map<number, number>([
    [1, 4],
    [2, 1],
  ]);

  it("rewrites mapped markers and leaves unmapped numbers as written", () => {
    expect(remapCitations("A [1] B [2] C [9]", remap)).toBe("A [4] B [1] C [9]");
  });

  it("splits grouped markers before remapping", () => {
    expect(remapCitations("claim [1, 2]", remap)).toBe("claim [4][1]");
    expect(remapCitations("claim [1,2,9]", remap)).toBe("claim [4][1][9]");
  });

  it("remaps linked markers while keeping the URL", () => {
    expect(remapCitations("see [2](https://x.com/a)", remap)).toBe("see [1](https://x.com/a)");
    expect(remapCitations("see [9](https://x.com/a)", remap)).toBe("see [9](https://x.com/a)");
  });

  it("never touches fenced code blocks", () => {
    const text = '```chart\n{"data":[1]}\n```\ntail [1]';
    expect(remapCitations(text, remap)).toBe('```chart\n{"data":[1]}\n```\ntail [4]');
  });

  it("never touches an unterminated fence at the end of the text", () => {
    const text = "before [2]\n```json\n[1]";
    expect(remapCitations(text, remap)).toBe("before [1]\n```json\n[1]");
  });

  it("never touches inline code", () => {
    expect(remapCitations("`arr[1]` and [1]", remap)).toBe("`arr[1]` and [4]");
  });

  it("returns the text unchanged when the map is empty", () => {
    const text = "A [1] B";
    expect(remapCitations(text, new Map())).toBe(text);
  });
});

describe("unifyResearchSources", () => {
  const u1: ResearchSource = { url: "https://one.com/a", title: "One" };
  const u2: ResearchSource = { url: "https://two.com/b", title: "Two" };
  const u3: ResearchSource = { url: "https://three.com/c", title: "Three" };

  it("folds candidate-local numbering into one deduped shared list", () => {
    const a = candidate("alpha [1] beta [2]", [u1, u2]);
    const b = candidate("gamma [1][2] delta [1, 2]", [u2, u3]);
    const state = juliusState([a, b]);

    unifyResearchSources(state);

    expect(state.sources?.map((source) => source.url)).toEqual([u1.url, u2.url, u3.url]);
    // Candidate A already matches the shared order.
    expect(a.content).toBe("alpha [1] beta [2]");
    // Candidate B's private [1]=u2 → shared [2], [2]=u3 → shared [3].
    expect(b.content).toBe("gamma [2][3] delta [2][3]");
  });

  it("leaves candidates without research untouched", () => {
    const plain = candidate("no sources here [1]");
    const researched = candidate("cited [1]", [u1]);
    const state = juliusState([plain, researched]);

    unifyResearchSources(state);

    expect(plain.content).toBe("no sources here [1]");
    expect(state.sources?.map((source) => source.url)).toEqual([u1.url]);
  });

  it("does not set a shared list when nobody has sources", () => {
    const state = juliusState([candidate("a"), candidate("b")]);
    unifyResearchSources(state);
    expect(state.sources).toBeUndefined();
  });

  it("keeps markers beyond the local list as plain text (never a wrong link)", () => {
    const a = candidate("real [1] phantom [7]", [u1]);
    const state = juliusState([a]);
    unifyResearchSources(state);
    expect(a.content).toBe("real [1] phantom [7]");
  });
});
