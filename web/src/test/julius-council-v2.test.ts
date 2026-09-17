/**
 * Council v2 through the real server Julius runner: candidates answer, the
 * Verifier alone fact-checks (no Proponent / Critic), Jev picks the backbone
 * and rules on every block, and the chairman writes as an editor bound by
 * the plan. Gateway traffic is scripted per model id; Jev per question.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runServerJulius, type ServerJuliusParams } from "../../../functions/julius-runner";
import type { JuliusState } from "../../../functions/run-protocol";

afterEach(() => {
  vi.unstubAllGlobals();
});

const paragraph = (label: string) =>
  `${label}: this paragraph is long enough to stand as its own block and states one concrete claim for the user.`;
const ALPHA = [paragraph("Alpha one"), paragraph("Alpha two")].join("\n\n");
const BETA = [paragraph("Beta one"), paragraph("Beta two"), paragraph("Beta three")].join("\n\n");

function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
function text(model: string, content: string): Response {
  return sse([
    { model, choices: [{ delta: { content } }] },
    { model, choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30 } },
  ]);
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Script = {
  jev?: (questions: Record<string, { type: string }>) => Response;
  onChairman?: (prompt: string) => void;
};

function stubGateway(script: Script = {}) {
  const models: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      questions?: Record<string, { type: string }>;
    };
    if (url.endsWith("/v2/vercel/v4/ai/evaluation-model")) {
      models.push("jev");
      if (script.jev) {
        return script.jev(body.questions ?? {});
      }
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions ?? {})) {
        if (id === "backbone") {
          answers[id] = { type: "choice", choice: "B", probabilities: { A: 0.25, B: 0.75 } };
        } else if (id.startsWith("quality_")) {
          answers[id] = { type: "score", score: 2.5, probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0.5 } };
        } else {
          const decision = id === "block_A2" ? "drop_wrong" : id === "block_B3" ? "fix" : "keep";
          answers[id] = {
            type: "choice",
            choice: decision,
            probabilities: { keep: 0.04, fix: 0.03, drop_wrong: 0.02, drop_redundant: 0.01, [decision]: 0.9 },
          };
        }
      }
      return json({ answers, usage: { inputTokens: 700, outputTokens: 0 } });
    }
    if (!url.endsWith("/v2/vercel/v1/chat/completions")) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    const model = body.model ?? "";
    models.push(model);
    const prompt = (body.messages ?? [])
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    switch (model) {
      case "test/alpha":
        return text(model, ALPHA);
      case "test/beta":
        return text(model, BETA);
      case "test/verifier":
        return text(model, "✗ Alpha two is wrong (the fee is 14 USD, not 12). ✓ Everything else holds as of today.");
      case "test/chairman":
        script.onChairman?.(prompt);
        return text(model, "Final answer written from the plan.");
      default:
        throw new Error(`Unexpected model: ${model}`);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, models };
}

function params(overrides: Partial<ServerJuliusParams> = {}): ServerJuliusParams {
  return {
    authKey: "toolkit-key",
    history: [{ role: "user", content: "Which fee applies?" }],
    prompt: "Which fee applies?",
    settings: {
      candidateModelIds: ["test/alpha", "test/beta"],
      decision: "council_v2",
      proponentModelId: "test/proponent",
      criticModelId: "test/critic",
      verifierModelId: "test/verifier",
      chairmanModelId: "test/chairman",
    },
    builtins: {
      web_search: false,
      fetch_url: false,
      selfsurf: false,
      generate_image: false,
      generate_video: false,
      generate_audio: false,
    },
    onUpdate: () => undefined,
    ...overrides,
  };
}

describe("Julius Council v2", () => {
  it("runs Verifier → Jev board → editor, with no Proponent or Critic and the plan in the editor's material", async () => {
    let chairmanPrompt = "";
    const { models } = stubGateway({ onChairman: (prompt) => (chairmanPrompt = prompt) });
    const updates: JuliusState[] = [];
    const usage: Array<{ modelId: string; service?: boolean }> = [];

    const result = await runServerJulius(
      params({
        onUpdate: (julius) => updates.push(julius),
        onUsage: (modelId, _usage, service) => usage.push({ modelId, service }),
      }),
    );

    expect(models).not.toContain("test/proponent");
    expect(models).not.toContain("test/critic");
    expect(models.filter((model) => model === "jev")).toHaveLength(3);
    expect(models.filter((model) => model === "test/chairman")).toHaveLength(1);

    expect(result.content).toBe("Final answer written from the plan.");
    expect(result.julius.status).toBe("done");
    expect(result.julius.decidedBy).toBe("jev");
    expect(result.julius.winner).toBe(1);
    expect(result.julius.reviews.map((review) => review.role)).toEqual(["verifier"]);
    expect(result.julius.verdict).toBeUndefined();
    const board = result.julius.board;
    expect(board?.status).toBe("done");
    expect(board?.modelId).toBe("typesafe-ai/jev");
    expect(board?.backbone).toEqual({ winner: 1, probabilities: [0.25, 0.75], confidence: 0.75 });
    expect(board?.blocks.map((block) => `${block.id}:${block.decision}`)).toEqual([
      "A1:keep",
      "A2:drop_wrong",
      "B1:keep",
      "B2:keep",
      "B3:fix",
    ]);
    expect(board?.inputTokens).toBe(2_100);

    // The editor is bound by the plan: marked blocks, the backbone flag, the Verifier's report, one line per ruling.
    expect(chairmanPrompt).toContain("You are the EDITOR");
    expect(chairmanPrompt).toContain("Jev chose candidate B as the BACKBONE");
    expect(chairmanPrompt).toContain("CANDIDATE B — model test/beta — BACKBONE");
    expect(chairmanPrompt).toContain("⟦A1⟧");
    expect(chairmanPrompt).toContain("⟦B3⟧");
    expect(chairmanPrompt).toContain("VERIFIER REPORT");
    expect(chairmanPrompt).toContain("the fee is 14 USD");
    expect(chairmanPrompt).toContain("BOARD PLAN");
    expect(chairmanPrompt).toContain("- A2 DROP (wrong) [0.90]");
    expect(chairmanPrompt).toContain("- B3 FIX — apply the Verifier's correction [0.90]");
    expect(chairmanPrompt).not.toContain("PROPONENT");

    // Live states: the board streamed while running, then the editor wrote.
    expect(updates.some((julius) => julius.status === "debate" && julius.board?.status === "running")).toBe(true);
    expect(updates.some((julius) => julius.board?.status === "running" && julius.board.quality.length > 0)).toBe(true);
    expect(updates.some((julius) => julius.status === "synthesis" && julius.board?.status === "done")).toBe(true);

    // Jev is billed to the run as a service call; the chairman as a regular model call.
    expect(usage.filter((event) => event.modelId === "typesafe-ai/jev" && event.service === true)).toHaveLength(3);
    expect(usage.some((event) => event.modelId === "test/chairman" && !event.service)).toBe(true);
  });

  it("with one candidate Jev grades and rules without a backbone question; the editor rewrites the single answer", async () => {
    let chairmanPrompt = "";
    const asked: string[] = [];
    stubGateway({
      onChairman: (prompt) => (chairmanPrompt = prompt),
      jev: (questions) => {
        asked.push(...Object.keys(questions));
        const answers: Record<string, unknown> = {};
        for (const id of Object.keys(questions)) {
          answers[id] = id.startsWith("quality_")
            ? { type: "score", score: 1, probabilities: { "0": 0, "1": 1, "2": 0, "3": 0 } }
            : { type: "choice", choice: id === "block_A2" ? "fix" : "keep", probabilities: { keep: 0.5, fix: 0.5, drop_wrong: 0, drop_redundant: 0 } };
        }
        return json({ answers, usage: { inputTokens: 100 } });
      },
    });
    const result = await runServerJulius(
      params({ settings: { ...params().settings, candidateModelIds: ["test/alpha"] } }),
    );
    expect(asked).not.toContain("backbone");
    expect(result.julius.winner).toBe(0);
    expect(result.julius.decidedBy).toBe("jev");
    expect(result.julius.board?.backbone).toBeUndefined();
    expect(result.julius.board?.quality).toEqual([{ candidate: 0, score: 1, level: "usable with caveats", confidence: 1 }]);
    expect(chairmanPrompt).toContain("One answer to the user's request was produced");
    expect(chairmanPrompt).not.toContain("BACKBONE");
    expect(result.content).toBe("Final answer written from the plan.");
  });

  it("refuses honestly when Jev is unavailable: no editor call, the user picks, the board records the error", async () => {
    const { models } = stubGateway({ jev: () => new Response("model not available", { status: 400 }) });
    const result = await runServerJulius(params());
    expect(models).not.toContain("test/chairman");
    expect(result.content).toBe("");
    expect(result.julius.status).toBe("choice");
    expect(result.julius.decidedBy).toBeUndefined();
    expect(result.julius.board?.status).toBe("error");
    expect(result.julius.board?.error).toContain("gateway 400");
    expect(result.julius.verdict).toContain("Jev could not rule");
    expect(result.julius.verdict).toContain("pick the winner yourself");
  });

  it("keeps the classic council untouched for decision: council", async () => {
    const script = stubGateway();
    // Classic mode needs the debate roles; script them on the same stub.
    script.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; messages?: Array<{ content?: unknown }> };
      const model = body.model ?? "";
      script.models.push(String(input).includes("evaluation-model") ? "jev" : model);
      if (model === "test/alpha") return text(model, ALPHA);
      if (model === "test/beta") return text(model, BETA);
      if (model === "test/proponent") return text(model, "Both are fine.\nChampion: B");
      if (model === "test/critic") return text(model, "Alpha two is shaky.\nWeakest: A");
      if (model === "test/verifier") return text(model, "✓ Beta holds.");
      if (model === "test/chairman") {
        const prompt = (body.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
        return prompt.includes("final deliverable") ? text(model, "Merged classic answer.") : text(model, "WINNER: B\nVERDICT: Beta is verified.");
      }
      throw new Error(`Unexpected model: ${model}`);
    });
    const result = await runServerJulius(params({ settings: { ...params().settings, decision: "council" } }));
    expect(script.models).not.toContain("jev");
    expect(result.julius.decidedBy).toBe("chairman");
    expect(result.julius.board).toBeUndefined();
    expect(result.julius.reviews.map((review) => review.role)).toEqual(["proponent", "critic", "verifier"]);
    expect(result.content).toBe("Merged classic answer.");
  });
});
