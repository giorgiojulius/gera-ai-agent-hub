/**
 * Council v2 — Jev's board (functions/jev-board.ts): block splitting, the
 * gateway evaluation wire (headers, retries, schema), the two-round board
 * over fake Jev answers, and the plan the editor reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayRequestError } from "../../../functions/agent-engine";
import {
  boardPlanText,
  evaluateWithJev,
  JEV_MODEL_ID,
  markBlocks,
  parseJevEvaluation,
  runJevBoard,
  splitBlocks,
  type JevQuestion,
} from "../../../functions/jev-board";

afterEach(() => {
  vi.unstubAllGlobals();
});

type QuestionMap = Record<string, JevQuestion>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A scripted Jev: answers every asked question by its id and type. */
function fakeJev(
  pick: (id: string, question: JevQuestion, state: Record<string, unknown>) => unknown,
  inputTokens = 1_000,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    expect(String(input)).toBe("https://toolkit.rork.com/v2/vercel/v4/ai/evaluation-model");
    const body = JSON.parse(String(init?.body ?? "{}")) as { state: Record<string, unknown>; questions: QuestionMap };
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      answers[id] = pick(id, question, body.state);
    }
    return jsonResponse({ answers, usage: { inputTokens, outputTokens: 0 } });
  });
}

describe("splitBlocks", () => {
  it("splits on blank lines, keeps fenced code atomic and attaches a heading to the block after it", () => {
    const text = [
      "## Setup",
      "",
      "Install the package with your package manager of choice and pin the version in the lockfile.",
      "",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "The second paragraph explains the configuration file and where the defaults come from in detail.",
    ].join("\n");
    const blocks = splitBlocks(text, "A");
    expect(blocks.map((block) => block.id)).toEqual(["A1", "A2", "A3"]);
    expect(blocks[0].text.startsWith("## Setup\n\nInstall the package")).toBe(true);
    expect(blocks[1].text).toBe("```ts\nconst a = 1;\n\nconst b = 2;\n```");
    expect(blocks[2].text.startsWith("The second paragraph")).toBe(true);
  });

  it("merges fragments under the minimum size into a neighbour and caps the count by merging the smallest pairs", () => {
    const short = "Yes.";
    const long = (n: number) => `Paragraph ${n} carries enough words to stand on its own as a block of the answer text.`;
    const text = [short, long(1), long(2), short].join("\n\n");
    const blocks = splitBlocks(text, "B");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe(`${short}\n\n${long(1)}`);
    expect(blocks[1].text).toBe(`${long(2)}\n\n${short}`);

    const many = Array.from({ length: 10 }, (_, index) => long(index)).join("\n\n");
    const capped = splitBlocks(many, "C", 4);
    expect(capped).toHaveLength(4);
    expect(capped.map((block) => block.id)).toEqual(["C1", "C2", "C3", "C4"]);
    expect(capped.map((block) => block.text).join("\n\n")).toBe(many);
  });

  it("marks every block with its ⟦id⟧ for the editor", () => {
    expect(markBlocks([{ id: "A1", text: "First." }, { id: "A2", text: "Second." }])).toBe(
      "⟦A1⟧\nFirst.\n\n⟦A2⟧\nSecond.",
    );
  });
});

describe("parseJevEvaluation", () => {
  const questions: QuestionMap = {
    pick: { type: "choice", instructions: "?", criteria: { A: "a", B: "b" } },
    grade: { type: "score", instructions: "?", criteria: ["low", "high"] },
    flag: { type: "boolean", instructions: "?" },
  };

  it("keeps typed answers, their distributions and the usage", () => {
    const parsed = parseJevEvaluation(
      {
        answers: {
          pick: { type: "choice", choice: "B", probabilities: { A: 0.2, B: 0.8 } },
          grade: { type: "score", score: 0.9, probabilities: { "0": 0.1, "1": 0.9 } },
          flag: { type: "boolean", probability: 0.42 },
        },
        usage: { inputTokens: 321, outputTokens: 0 },
      },
      questions,
      12,
    );
    expect(parsed.answers.pick).toEqual({ type: "choice", choice: "B", probabilities: { A: 0.2, B: 0.8 } });
    expect(parsed.answers.grade).toEqual({ type: "score", score: 0.9, probabilities: { "0": 0.1, "1": 0.9 } });
    expect(parsed.answers.flag).toEqual({ type: "boolean", probability: 0.42 });
    expect(parsed.inputTokens).toBe(321);
    expect(parsed.elapsedMs).toBe(12);
  });

  it("refuses a missing answer, a wrong type and an option that was never offered", () => {
    expect(() => parseJevEvaluation({ answers: {} }, { pick: questions.pick }, 0)).toThrow(/no choice answer for "pick"/);
    expect(() =>
      parseJevEvaluation({ answers: { grade: { type: "choice", choice: "A" } } }, { grade: questions.grade }, 0),
    ).toThrow(/no score answer for "grade"/);
    expect(() =>
      parseJevEvaluation({ answers: { pick: { type: "choice", choice: "Z" } } }, { pick: questions.pick }, 0),
    ).toThrow(/unknown option for "pick"/);
    expect(() => parseJevEvaluation("nope", questions, 0)).toThrow(/no answers/);
  });
});

describe("evaluateWithJev", () => {
  const questions: QuestionMap = { ok: { type: "boolean", instructions: "Is it fine?" } };

  it("speaks the gateway's v4 evaluation protocol through the toolkit proxy", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe("https://toolkit.rork.com/v2/vercel/v4/ai/evaluation-model");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer toolkit-key");
      expect(headers.get("ai-gateway-protocol-version")).toBe("0.0.1");
      expect(headers.get("ai-evaluation-model-specification-version")).toBe("4");
      expect(headers.get("ai-model-id")).toBe(JEV_MODEL_ID);
      expect(JSON.parse(String(init?.body))).toEqual({ state: { text: "fine" }, questions });
      return jsonResponse({ answers: { ok: { type: "boolean", probability: 0.97 } }, usage: { inputTokens: 40 } });
    });
    const result = await evaluateWithJev({ authKey: "toolkit-key", state: { text: "fine" }, questions, fetchImpl: fetchMock });
    expect(result.answers.ok).toEqual({ type: "boolean", probability: 0.97 });
    expect(result.inputTokens).toBe(40);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient gateway failure and never retries a rejected request", async () => {
    let calls = 0;
    const flaky = vi.fn(async (): Promise<Response> => {
      calls += 1;
      return calls === 1
        ? new Response("upstream busy", { status: 503 })
        : jsonResponse({ answers: { ok: { type: "boolean", probability: 0.5 } } });
    });
    const result = await evaluateWithJev({ authKey: "k", state: "s", questions, fetchImpl: flaky });
    expect(result.answers.ok).toEqual({ type: "boolean", probability: 0.5 });
    expect(flaky).toHaveBeenCalledTimes(2);

    const rejected = vi.fn(async (): Promise<Response> => new Response("bad request", { status: 400 }));
    await expect(evaluateWithJev({ authKey: "k", state: "s", questions, fetchImpl: rejected })).rejects.toBeInstanceOf(
      GatewayRequestError,
    );
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});

describe("runJevBoard", () => {
  const paragraph = (label: string) =>
    `${label} — this paragraph is long enough to be its own block and carries a concrete claim about the request.`;
  const candidates = [
    { index: 0, modelId: "test/alpha", content: [paragraph("A first"), paragraph("A second"), paragraph("A third")].join("\n\n"), status: "done" as const },
    { index: 1, modelId: "test/beta", content: [paragraph("B first"), paragraph("B second")].join("\n\n"), status: "done" as const },
  ];

  it("picks the backbone, grades every candidate, rules on every block and bills Jev as a service call", async () => {
    const states: Array<Record<string, unknown>> = [];
    const fetchMock = fakeJev((id, question, state) => {
      states.push(state);
      if (id === "backbone") {
        return { type: "choice", choice: "B", probabilities: { A: 0.3, B: 0.7 } };
      }
      if (id.startsWith("quality_")) {
        return id === "quality_A"
          ? { type: "score", score: 1.2, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3, "3": 0 } }
          : { type: "score", score: 2.6, probabilities: { "0": 0, "1": 0.1, "2": 0.2, "3": 0.7 } };
      }
      if (id.startsWith("block_")) {
        const decision = id.endsWith("1") ? "keep" : id.endsWith("2") ? "fix" : "drop_redundant";
        return {
          type: "choice",
          choice: decision,
          probabilities: { keep: 0.05, fix: 0.05, drop_wrong: 0.05, drop_redundant: 0.05, [decision]: 0.85 },
        };
      }
      throw new Error(`unexpected question ${id} (${question.type})`);
    }, 500);
    const usage: Array<{ modelId: string; usage: unknown; service?: boolean }> = [];
    const progress: number[] = [];

    const outcome = await runJevBoard({
      authKey: "k",
      prompt: "Which plan should we buy?",
      candidates,
      verifierReport: "✓ A's price is current. ✗ B's date is stale — it is 2026-09-01 now.",
      fetchImpl: fetchMock,
      onProgress: (board) => progress.push(board.blocks.length),
      onUsage: (modelId, raw, service) => usage.push({ modelId, usage: raw, service }),
    });

    expect(outcome.winner).toBe(1);
    expect(outcome.board.status).toBe("done");
    expect(outcome.board.backbone).toEqual({ winner: 1, probabilities: [0.3, 0.7], confidence: 0.7 });
    expect(outcome.board.quality).toEqual([
      { candidate: 0, score: 1.2, level: "usable with caveats", confidence: 0.6 },
      { candidate: 1, score: 2.6, level: "excellent", confidence: 0.7 },
    ]);
    expect(outcome.board.blocks.map((block) => `${block.id}:${block.decision}`)).toEqual([
      "A1:keep",
      "A2:fix",
      "A3:drop_redundant",
      "B1:keep",
      "B2:fix",
    ]);
    expect(outcome.board.blocks[0].probability).toBe(0.85);
    expect(outcome.board.blocks[0].excerpt.startsWith("A first — this paragraph")).toBe(true);
    expect(outcome.blocks.map((block) => block.id)).toEqual(["A1", "A2", "A3", "B1", "B2"]);
    // Round 1 + one round per candidate, each billed as a Jev service call with no output tokens.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcome.board.inputTokens).toBe(1_500);
    expect(usage).toHaveLength(3);
    expect(usage.every((event) => event.modelId === JEV_MODEL_ID && event.service === true)).toBe(true);
    expect(usage[0].usage).toEqual({ input_tokens: 500, output_tokens: 0 });
    // The partial board (backbone + quality, blocks pending) was emitted once.
    expect(progress).toEqual([0]);
    // Round 1 saw the Verifier's evidence and every candidate; the non-backbone
    // block round saw the backbone text, the backbone's own round did not.
    const roundOne = states[0];
    expect(roundOne.verifier_report).toContain("B's date is stale");
    expect((roundOne.candidates as unknown[]).length).toBe(2);
    const blockRounds = states.filter((state) => "candidate" in state);
    const alphaRound = blockRounds.find((state) => (state.candidate as { letter: string }).letter === "A");
    const betaRound = blockRounds.find((state) => (state.candidate as { letter: string }).letter === "B");
    expect((alphaRound?.backbone as { letter: string }).letter).toBe("B");
    expect((alphaRound?.candidate as { is_backbone: boolean }).is_backbone).toBe(false);
    expect(betaRound?.backbone).toBeUndefined();
    expect((betaRound?.candidate as { is_backbone: boolean }).is_backbone).toBe(true);
  });

  it("asks no backbone question for a single candidate and tells the board when the Verifier failed", async () => {
    const asked: string[] = [];
    const fetchMock = fakeJev((id, _question, state) => {
      asked.push(id);
      if (id === "quality_A") {
        expect(String(state.verifier_report)).toContain("unavailable");
        return { type: "score", score: 2, probabilities: { "0": 0, "1": 0.2, "2": 0.6, "3": 0.2 } };
      }
      return { type: "choice", choice: "keep", probabilities: { keep: 1, fix: 0, drop_wrong: 0, drop_redundant: 0 } };
    });
    const outcome = await runJevBoard({
      authKey: "k",
      prompt: "q",
      candidates: [candidates[0]],
      verifierReport: null,
      fetchImpl: fetchMock,
    });
    expect(asked.filter((id) => id === "backbone")).toHaveLength(0);
    expect(outcome.winner).toBe(0);
    expect(outcome.board.backbone).toBeUndefined();
    expect(outcome.board.quality).toEqual([{ candidate: 0, score: 2, level: "solid", confidence: 0.6 }]);
    expect(outcome.board.blocks.every((block) => block.decision === "keep")).toBe(true);
  });

  it("refuses when Jev answers off-schema instead of guessing a ruling", async () => {
    const fetchMock = fakeJev((id) =>
      id === "backbone"
        ? { type: "choice", choice: "A", probabilities: { A: 0.6, B: 0.4 } }
        : id.startsWith("quality_")
          ? { type: "score", score: 3 }
          : { type: "choice", choice: "keep" },
    );
    // Round 1 ok, then a block round returns the wrong answer type.
    let call = 0;
    const broken = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      call += 1;
      if (call === 1) {
        return fetchMock(input, init);
      }
      return jsonResponse({ answers: { nope: { type: "boolean", probability: 1 } } });
    });
    await expect(
      runJevBoard({ authKey: "k", prompt: "q", candidates, verifierReport: "ok", fetchImpl: broken }),
    ).rejects.toThrow(/Jev returned no choice answer/);
  });

  it("writes the plan the editor follows: backbone, quality, one ruling line per block", () => {
    const plan = boardPlanText(
      {
        modelId: JEV_MODEL_ID,
        status: "done",
        backbone: { winner: 1, probabilities: [0.3, 0.7], confidence: 0.7 },
        quality: [
          { candidate: 0, score: 1, level: "usable with caveats", confidence: 0.6 },
          { candidate: 1, score: 3, level: "excellent", confidence: 0.9 },
        ],
        blocks: [
          { id: "A1", candidate: 0, excerpt: "A price of 12 USD", chars: 100, decision: "fix", probability: 0.81 },
          { id: "A2", candidate: 0, excerpt: "Also B says", chars: 90, decision: "drop_redundant", probability: 0.77 },
          { id: "B1", candidate: 1, excerpt: "The plan costs 14 USD", chars: 120, decision: "keep", probability: 0.93 },
        ],
      },
      new Map([
        [0, "test/alpha"],
        [1, "test/beta"],
      ]),
    );
    expect(plan).toContain("Backbone: candidate B (70%)");
    expect(plan).toContain("Candidate A (test/alpha) — quality: usable with caveats:");
    expect(plan).toContain('- A1 FIX — apply the Verifier\'s correction [0.81] "A price of 12 USD"');
    expect(plan).toContain('- A2 DROP (redundant) [0.77] "Also B says"');
    expect(plan).toContain('- B1 KEEP [0.93] "The plan costs 14 USD"');
  });
});
