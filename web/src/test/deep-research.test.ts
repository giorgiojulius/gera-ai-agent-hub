import { beforeEach, describe, expect, it, vi } from "vitest";

import { streamCompletion } from "@/lib/chat";
import {
  buildDossier,
  buildReflectionList,
  matchContentPages,
  REFLECT_LIST_BUDGET,
  RESEARCH_PROFILES,
  runDeepResearch,
  type RegistrySource,
} from "@/lib/deep-research";
import { toolkitFetch } from "@/lib/toolkit";

vi.mock("@/lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat")>();
  return { ...actual, streamCompletion: vi.fn() };
});
vi.mock("@/lib/toolkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/toolkit")>();
  return { ...actual, toolkitFetch: vi.fn() };
});
vi.mock("@/lib/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/usage")>();
  return { ...actual, reportUsage: vi.fn() };
});

const streamCompletionMock = vi.mocked(streamCompletion);
const toolkitFetchMock = vi.mocked(toolkitFetch);

function makeSource(index: number, overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    index,
    url: `https://example.com/page-${index}`,
    title: `Source ${index}`,
    highlights: [`snippet for source ${index}`],
    ...overrides,
  };
}

function registryOf(sources: RegistrySource[]): Map<string, RegistrySource> {
  return new Map(sources.map((source) => [source.url, source]));
}

// Fixture texts use Z/Q/J — letters absent from generated titles, URLs, and
// dossier scaffolding — so character counts measure kept text exactly.
describe("buildDossier", () => {
  it("keeps every full text intact when the budget is large enough", () => {
    const registry = registryOf([
      makeSource(1, { text: "Z".repeat(2000) }),
      makeSource(2, { text: "Q".repeat(3000) }),
    ]);
    const dossier = buildDossier(registry, 60000);
    expect(dossier.match(/Z/g)?.length).toBe(2000);
    expect(dossier.match(/Q/g)?.length).toBe(3000);
  });

  it("splits an overflowing budget evenly instead of dropping late reads", () => {
    const registry = registryOf([
      makeSource(1, { text: "Z".repeat(10000) }),
      makeSource(2, { text: "Q".repeat(10000) }),
      makeSource(3, { text: "J".repeat(10000) }),
    ]);
    const dossier = buildDossier(registry, 15000);
    // The old greedy fill produced 10000 / 5000 / nothing — the last read
    // vanished from the writer's view entirely.
    expect(dossier.match(/Z/g)?.length).toBe(5000);
    expect(dossier.match(/Q/g)?.length).toBe(5000);
    expect(dossier.match(/J/g)?.length).toBe(5000);
  });

  it("lets short texts keep everything and gives the surplus to long ones", () => {
    const registry = registryOf([
      makeSource(1, { text: "Z".repeat(1000) }),
      makeSource(2, { text: "Q".repeat(10000) }),
      makeSource(3, { text: "J".repeat(1000) }),
    ]);
    const dossier = buildDossier(registry, 6000);
    expect(dossier.match(/Z/g)?.length).toBe(1000);
    expect(dossier.match(/J/g)?.length).toBe(1000);
    expect(dossier.match(/Q/g)?.length).toBe(4000);
  });

  it("always keeps title, URL, date, and notes even when no text fits", () => {
    const registry = registryOf([
      makeSource(1, { text: "Z".repeat(500), published: "2026-01-15T00:00:00Z" }),
    ]);
    const dossier = buildDossier(registry, 0);
    expect(dossier).toContain("[1] Source 1");
    expect(dossier).toContain("URL: https://example.com/page-1");
    expect(dossier).toContain("Published: 2026-01-15");
    expect(dossier).toContain("Notes: snippet for source 1");
    expect(dossier).not.toContain("Full text:");
  });
});

describe("buildReflectionList", () => {
  it("shows every source in index order when under budget", () => {
    const list = buildReflectionList(
      [makeSource(1), makeSource(2), makeSource(3, { text: "read text" })],
      10000,
    );
    expect(list).toContain("[1] Source 1");
    expect(list).toContain("snippet for source 1");
    expect(list).toContain("[3] Source 3 — https://example.com/page-3 (already read)");
    expect(list.indexOf("[1]")).toBeLessThan(list.indexOf("[2]"));
    expect(list).not.toContain("hidden");
  });

  it("hides the oldest unread sources first so the newest wave stays visible", () => {
    const sources = Array.from({ length: 60 }, (_, i) =>
      makeSource(i + 1, { highlights: [`long snippet ${"x".repeat(150)} for source ${i + 1}`] }),
    );
    const list = buildReflectionList(sources, 4000);
    expect(list).toContain("[60] Source 60");
    expect(list).not.toContain("[1] Source 1");
    expect(list).toMatch(/^\(\d+ older unread sources hidden/);
  });

  it("always keeps already-read sources even when they are the oldest", () => {
    const sources = Array.from({ length: 60 }, (_, i) => makeSource(i + 1));
    sources[0] = makeSource(1, { text: "already read text" });
    const list = buildReflectionList(sources, 3000);
    expect(list).toContain("[1] Source 1 — https://example.com/page-1 (already read)");
    expect(list).not.toContain("[2] Source 2");
  });

  it("keeps output in ascending index order after trimming", () => {
    const sources = Array.from({ length: 40 }, (_, i) => makeSource(i + 1));
    sources[4] = makeSource(5, { text: "read text" });
    const list = buildReflectionList(sources, 2000);
    const kept = [...list.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
    expect(kept).toContain(5);
    expect(kept[kept.length - 1]).toBe(40);
  });

  it("fits the biggest first wave of every depth profile into the reflect budget", () => {
    // Realistic upper-bound line: capped title (140) + URL + 200-char snippet.
    const lineEstimate = 340;
    for (const profile of Object.values(RESEARCH_PROFILES)) {
      const wave1Sources = profile.plannerMax * profile.resultsPerQuery;
      expect(wave1Sources * lineEstimate).toBeLessThanOrEqual(REFLECT_LIST_BUDGET);
    }
  });
});

describe("matchContentPages", () => {
  it("pairs by exact URL regardless of response order", () => {
    const matched = matchContentPages(
      [{ url: "https://a.test/one" }, { url: "https://b.test/two" }],
      [
        { url: "https://b.test/two", text: "B" },
        { url: "https://a.test/one", text: "A" },
      ],
    );
    expect(matched[0]?.text).toBe("A");
    expect(matched[1]?.text).toBe("B");
  });

  it("matches across www, scheme, and trailing-slash rewrites", () => {
    const matched = matchContentPages(
      [{ url: "https://a.test/page" }],
      [{ url: "http://www.a.test/page/", text: "A" }],
    );
    expect(matched[0]?.text).toBe("A");
  });

  it("never attaches an unrelated page when the response is shorter", () => {
    // The old positional guess handed source 1 the text of a DIFFERENT page
    // whenever an earlier URL failed — the report then cited the wrong URL.
    const matched = matchContentPages(
      [{ url: "https://a.test/one" }, { url: "https://b.test/two" }],
      [{ url: "https://c.test/other", text: "C" }],
    );
    expect(matched[0]).toBeUndefined();
    expect(matched[1]).toBeUndefined();
  });

  it("trusts positional order only for a same-length response with unclaimed slots", () => {
    const matched = matchContentPages(
      [{ url: "https://a.test/one" }, { url: "https://b.test/two" }],
      [
        { url: "https://a.test/one?utm=x", text: "A" },
        { url: "https://b.test/two?utm=y", text: "B" },
      ],
    );
    expect(matched[0]?.text).toBe("A");
    expect(matched[1]?.text).toBe("B");
  });

  it("never hands one page to two sources", () => {
    const matched = matchContentPages(
      [{ url: "https://a.test/one" }, { url: "https://b.test/two" }],
      [
        { url: "https://b.test/two", text: "B" },
        { url: "https://x.test/noise", text: "X" },
      ],
    );
    // Page 0 is claimed by source 2's exact match; slot 1 stays honest‐empty
    // instead of stealing it positionally.
    expect(matched[0]).toBeUndefined();
    expect(matched[1]?.text).toBe("B");
  });
});

/** Response stub for the toolkitFetch mock — requireJson only needs ok + json(). */
function jsonResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as unknown as Response;
}

/** Scripts planner → search → reflect → contents for one eco-depth run. */
function scriptToolkit(options?: { contents?: Array<{ url: string; title?: string; text?: string }> }) {
  toolkitFetchMock.mockImplementation(async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    if (path === "/v2/vercel/v1/chat/completions") {
      const system = String(body.messages?.[0]?.content ?? "");
      if (system.includes("split a research question")) {
        return jsonResponse({
          choices: [{ message: { content: '{"queries":["alpha query","beta query"]}' } }],
        });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: '{"notes":"primary data covered","queries":[],"read":["[1]"],"browse":[],"done":true}',
            },
          },
        ],
      });
    }
    if (path === "/v2/exa/search") {
      return jsonResponse({
        results: [
          { title: "Alpha", url: "https://a.test/page", publishedDate: "2026-01-02T00:00:00Z", highlights: ["ha"] },
          { title: "Beta", url: "https://b.test/page", highlights: ["hb"] },
        ],
      });
    }
    if (path === "/v2/exa/contents") {
      return jsonResponse({
        results: options?.contents ?? [{ url: "https://a.test/page", title: "Alpha Full", text: "Z".repeat(300) }],
      });
    }
    throw new Error(`unexpected toolkit path: ${path}`);
  });
}

describe("runDeepResearch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("searches, reads the picked page, and writes a cited report with the chosen model", async () => {
    scriptToolkit();
    streamCompletionMock.mockImplementation(async (params) => {
      params.handlers.onText?.("Report body [1][2]");
      return { content: "Report body [1][2]", toolCalls: [], images: [], servedModelId: "test/model-a" };
    });

    const result = await runDeepResearch({
      prompt: "How healthy is the alpha ecosystem?",
      history: [],
      modelId: "test/model-a",
      depth: "eco",
      onUpdate: vi.fn(),
      onText: vi.fn(),
    });

    expect(result.content).toBe("Report body [1][2]");
    expect(result.research.status).toBe("done");
    // Same model that was asked — no ghost-writer chip.
    expect(result.servedBy).toBeUndefined();
    expect(result.research.sources.map((source) => source.url)).toEqual([
      "https://a.test/page",
      "https://b.test/page",
    ]);
    // The decorated "[1]" read pick still resolved and its full text reached the writer.
    const readSteps = result.research.steps.filter((step) => step.kind === "read");
    expect(readSteps.some((step) => step.status === "done")).toBe(true);
    const call = streamCompletionMock.mock.calls[0][0];
    expect(call.modelId).toBe("test/model-a");
    expect(call.fallbacks).toBeUndefined();
    const dossier = String(call.messages[call.messages.length - 1]?.content ?? "");
    expect(dossier).toContain("<research_dossier>");
    expect(dossier).toContain("Z".repeat(300));
    // The read gave the source its real page title.
    expect(result.research.sources[0].title).toBe("Alpha Full");
  });

  it("threads fallbacks:false to the report write and discloses a ghost-writer", async () => {
    scriptToolkit();
    streamCompletionMock.mockResolvedValue({
      content: "Report",
      toolCalls: [],
      images: [],
      servedModelId: "backup/model-b",
    });

    const result = await runDeepResearch({
      prompt: "Question",
      history: [],
      modelId: "test/model-a",
      depth: "eco",
      fallbacks: false,
      onUpdate: vi.fn(),
      onText: vi.fn(),
    });

    expect(streamCompletionMock.mock.calls[0][0].fallbacks).toBe(false);
    expect(result.servedBy).toBe("backup/model-b");
  });
});
