import { beforeAll, beforeEach, expect, test, vi } from "vitest";

import { fallbackServedBy, runAgentTurn, streamCompletion } from "@/lib/chat";
import { runJuliusTurn, type JuliusRunParams } from "@/lib/julius";
import type { BuiltinToolId, ChatMessage, JuliusSettings, JuliusState } from "@/lib/types";

vi.mock("@/lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat")>();
  return {
    ...actual,
    runAgentTurn: vi.fn(),
    streamCompletion: vi.fn(),
  };
});

const runAgentTurnMock = vi.mocked(runAgentTurn);
const streamCompletionMock = vi.mocked(streamCompletion);

beforeAll(() => {
  // julius.ts throttles UI emits through window timers; unit tests run in node.
  (globalThis as { window?: unknown }).window ??= globalThis;
});

beforeEach(() => {
  vi.resetAllMocks();
});

/** ChatTurnResult stub for the runAgentTurn mock (candidates + verifier). */
function turn(content: string, servedBy?: string) {
  return {
    content,
    images: [] as string[],
    videos: [] as string[],
    toolCalls: [],
    sources: [],
    servedBy,
  };
}

/** streamCompletion result stub (reviews, chairman, synthesis). */
function completion(content: string, servedModelId?: string) {
  return {
    content,
    toolCalls: [],
    images: [] as string[],
    servedModelId,
  };
}

/** Candidates carry a systemPrompt (panel note); the verifier never does. */
function scriptAgentTurns(options: {
  candidates: Record<string, { content: string; servedBy?: string } | Error>;
  verifier?: string;
}) {
  runAgentTurnMock.mockImplementation(async (params) => {
    if (params.systemPrompt) {
      const scripted = options.candidates[params.modelId];
      if (!scripted) {
        throw new Error(`No script for candidate ${params.modelId}`);
      }
      if (scripted instanceof Error) {
        throw scripted;
      }
      return turn(scripted.content, scripted.servedBy);
    }
    return turn(options.verifier ?? "Verified.");
  });
}

function scriptCompletions(options: {
  proponent?: string;
  proponentServedModelId?: string;
  critic?: string;
  ruling?: string;
  rulingError?: Error;
  rulingServedModelId?: string;
  synthesis?: string;
  synthesisServedModelId?: string;
}) {
  streamCompletionMock.mockImplementation(async (params) => {
    const first = params.messages[0];
    const system = typeof first?.content === "string" ? first.content : "";
    if (system.includes("PROPONENT")) {
      return completion(options.proponent ?? "Strengths.", options.proponentServedModelId);
    }
    if (system.includes("CRITIC")) {
      return completion(options.critic ?? "Weaknesses.");
    }
    // The synthesis system also mentions the chairman — check it first.
    if (system.includes("final deliverable")) {
      return completion(options.synthesis ?? "Final merged.", options.synthesisServedModelId);
    }
    if (system.includes("CHAIRMAN")) {
      if (options.rulingError) {
        throw options.rulingError;
      }
      return completion(options.ruling ?? "WINNER: A\nVERDICT: Fine.", options.rulingServedModelId);
    }
    throw new Error(`Unexpected completion call: ${system.slice(0, 60)}`);
  });
}

const BUILTINS: Record<BuiltinToolId, boolean> = {
  web_search: false,
  fetch_url: false,
  selfsurf: false,
  generate_image: false,
  generate_video: false,
  generate_audio: false,
};

const HISTORY: ChatMessage[] = [
  { id: "u1", role: "user", content: "What is the best answer?", createdAt: 1 },
];

function makeSettings(overrides: Partial<JuliusSettings> = {}): JuliusSettings {
  return {
    candidateModelIds: ["prov-a/alpha", "prov-b/beta"],
    decision: "council",
    proponentModelId: "prov/proponent",
    criticModelId: "prov/critic",
    verifierModelId: "prov/verifier",
    chairmanModelId: "prov/chairman",
    ...overrides,
  };
}

async function run(overrides: Partial<JuliusRunParams> = {}) {
  const updates: JuliusState[] = [];
  const result = await runJuliusTurn({
    history: HISTORY,
    prompt: "What is the best answer?",
    settings: makeSettings(),
    builtins: BUILTINS,
    onUpdate: (julius) => updates.push(julius),
    ...overrides,
  });
  return { result, updates };
}

/** Advances fake time through withRetries backoff sleeps (700ms + 1400ms per phase). */
async function flushRetrySleeps() {
  for (let index = 0; index < 8; index += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
}

test("council mode: chairman rules, synthesis merges, candidates run WITHOUT gateway fallbacks", async () => {
  scriptAgentTurns({
    candidates: {
      "prov-a/alpha": { content: "Answer from alpha" },
      "prov-b/beta": { content: "Answer from beta" },
    },
    verifier: "Verified: both hold.",
  });
  scriptCompletions({ ruling: "WINNER: B\nVERDICT: Beta is stronger.", synthesis: "Final merged answer." });

  const { result, updates } = await run();

  expect(result.content).toBe("Final merged answer.");
  expect(result.servedBy).toBeUndefined();
  expect(result.julius.status).toBe("done");
  expect(result.julius.winner).toBe(1);
  expect(result.julius.decidedBy).toBe("chairman");
  expect(result.julius.verdict).toBe("Beta is stronger.");
  expect(result.julius.reviews.map((review) => review.status)).toEqual(["done", "done", "done"]);

  // The competition is between SPECIFIC models — no silent imposters.
  const candidateCalls = runAgentTurnMock.mock.calls.filter(([params]) => params.systemPrompt);
  expect(candidateCalls).toHaveLength(2);
  for (const [params] of candidateCalls) {
    expect(params.fallbacks).toBe(false);
  }
  // The verifier keeps fallbacks for council resilience.
  const verifierCalls = runAgentTurnMock.mock.calls.filter(([params]) => !params.systemPrompt);
  expect(verifierCalls).toHaveLength(1);
  expect(verifierCalls[0][0].fallbacks).toBeUndefined();

  expect(updates.some((julius) => julius.status === "debate")).toBe(true);
  expect(updates.some((julius) => julius.status === "synthesis")).toBe(true);
});

test("an invalid chairman letter falls back to the first finished candidate", async () => {
  scriptAgentTurns({
    candidates: {
      "prov-a/alpha": { content: "Answer from alpha" },
      "prov-b/beta": { content: "Answer from beta" },
    },
  });
  scriptCompletions({ ruling: "WINNER: Z\nVERDICT: Confused.", synthesis: "Merged." });

  const { result } = await run();

  expect(result.julius.winner).toBe(0);
  expect(result.julius.verdict).toBe("Confused.");
  expect(result.julius.status).toBe("done");
});

test("chairman failure hands the pick to the user with an honest note", async () => {
  scriptAgentTurns({
    candidates: {
      "prov-a/alpha": { content: "Answer from alpha" },
      "prov-b/beta": { content: "Answer from beta" },
    },
  });
  scriptCompletions({ rulingError: new Error("gateway down") });

  vi.useFakeTimers();
  try {
    const promise = run();
    await flushRetrySleeps();
    const { result } = await promise;

    expect(result.julius.status).toBe("choice");
    expect(result.content).toBe("");
    expect(result.julius.verdict).toContain("could not rule");
    expect(result.julius.verdict).toContain("gateway down");
  } finally {
    vi.useRealTimers();
  }
});

test("single candidate runs as a quality check: council audits, chairman finalizes", async () => {
  scriptAgentTurns({
    candidates: { "prov-a/alpha": { content: "Solo answer" } },
    verifier: "Checked.",
  });
  scriptCompletions({ ruling: "VERDICT: Solid, trust it.", synthesis: "Polished final." });

  const { result } = await run({ settings: makeSettings({ candidateModelIds: ["prov-a/alpha"] }) });

  expect(result.julius.status).toBe("done");
  expect(result.julius.winner).toBe(0);
  expect(result.content).toBe("Polished final.");
  expect(result.julius.verdict).toBe("Solid, trust it.");
});

test("all candidates failing ends the panel honestly without a debate", async () => {
  scriptAgentTurns({
    candidates: {
      "prov-a/alpha": new Error("model offline"),
      "prov-b/beta": new Error("model offline"),
    },
  });

  const { result } = await run();

  expect(result.julius.status).toBe("error");
  expect(result.content).toBe("All 2 candidates failed: model offline");
  expect(streamCompletionMock).not.toHaveBeenCalled();
});

test("a single failed candidate reads as one failure, not 'all 1 candidates'", async () => {
  scriptAgentTurns({ candidates: { "prov-a/alpha": new Error("model offline") } });

  const { result } = await run({ settings: makeSettings({ candidateModelIds: ["prov-a/alpha"] }) });

  expect(result.julius.status).toBe("error");
  expect(result.content).toBe("The candidate failed: model offline");
});

test("manual decision stops at the choice stage without any council calls", async () => {
  scriptAgentTurns({
    candidates: {
      "prov-a/alpha": { content: "Answer from alpha" },
      "prov-b/beta": { content: "Answer from beta" },
    },
  });

  const { result } = await run({ settings: makeSettings({ decision: "manual" }) });

  expect(result.julius.status).toBe("choice");
  expect(result.content).toBe("");
  expect(result.julius.reviews).toEqual([]);
  expect(result.julius.winner).toBeUndefined();
  expect(streamCompletionMock).not.toHaveBeenCalled();
});

test("fallback disclosures ride on candidates, reviews, chairman, and the final text", async () => {
  scriptAgentTurns({
    candidates: {
      "prov-a/alpha": { content: "Answer A" },
      "prov-b/beta": { content: "Answer B", servedBy: "openai/gpt-5.6-terra" },
    },
  });
  scriptCompletions({
    ruling: "WINNER: A\nVERDICT: A wins.",
    rulingServedModelId: "openai/gpt-5.6-terra",
    proponentServedModelId: "google/gemini-3.7-flash",
    synthesis: "Merged final.",
    synthesisServedModelId: "google/gemini-3.7-flash",
  });

  const { result } = await run();

  expect(result.julius.candidates[1].servedBy).toBe("openai/gpt-5.6-terra");
  const proponent = result.julius.reviews.find((review) => review.role === "proponent");
  expect(proponent?.servedBy).toBe("google/gemini-3.7-flash");
  const critic = result.julius.reviews.find((review) => review.role === "critic");
  expect(critic?.servedBy).toBeUndefined();
  expect(result.julius.chairmanServedBy).toBe("openai/gpt-5.6-terra");
  expect(result.servedBy).toBe("google/gemini-3.7-flash");
});

test("an empty synthesis falls back to the winning answer with an honest note", async () => {
  scriptAgentTurns({
    candidates: {
      "prov-a/alpha": { content: "Answer from alpha" },
      "prov-b/beta": { content: "Answer from beta" },
    },
  });
  scriptCompletions({ ruling: "WINNER: A\nVERDICT: Ok.", synthesis: "" });

  vi.useFakeTimers();
  try {
    const promise = run();
    await flushRetrySleeps();
    const { result } = await promise;

    expect(result.content).toBe("Answer from alpha");
    expect(result.julius.status).toBe("done");
    expect(result.julius.verdict).toContain("Final synthesis unavailable");
  } finally {
    vi.useRealTimers();
  }
});

test("fallbackServedBy flags only genuinely different models", () => {
  expect(fallbackServedBy("anthropic/claude-opus-5", undefined)).toBeUndefined();
  expect(fallbackServedBy("anthropic/claude-opus-5", "bedrock/claude-opus-5")).toBeUndefined();
  expect(fallbackServedBy("spacexai/grok-4.6:xhigh", "xai/grok-4.6")).toBeUndefined();
  expect(fallbackServedBy("anthropic/claude-opus-5", "openai/gpt-5.6-terra")).toBe("openai/gpt-5.6-terra");
});
