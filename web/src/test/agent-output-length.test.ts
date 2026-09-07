import { beforeEach, describe, expect, it, vi } from "vitest";

// Reply length must not be capped by Gera: the engine sends the picked
// model's own output ceiling (instead of the provider default) and continues
// a round the provider ends with `finish_reason: "length"` in place, splicing
// the seam, until the reply is genuinely complete. These tests drive the
// exact engine module that ships to the backend.
import {
  buildApiMessages,
  CUT_CONTINUE_NOTE,
  CUT_EMPTY_NOTE,
  CUT_TOOLCALL_NOTE,
  joinCutText,
  normalizeOutputTokens,
  runEngineTurn,
  streamGatewayText,
  SYSTEM_PROMPT,
  type EngineMessage,
} from "../../../functions/agent-engine";
import { modelMaxOutputTokens, parseModelCatalog, resetModelCatalogCache } from "../../../functions/model-catalog";

const fetchMock = vi.fn<typeof fetch>();

type SseEvent = Record<string, unknown>;

const token = (text: string): SseEvent => ({ choices: [{ delta: { content: text } }] });
const finish = (reason: string): SseEvent => ({ choices: [{ delta: {}, finish_reason: reason }] });
const toolDelta = (name: string, args: string): SseEvent => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] } }],
});

/** A complete SSE body — no live timing needed for these seams. */
function sseResponse(events: SseEvent[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200 });
}

type ApiBody = {
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
  max_tokens?: number;
  tools?: unknown[];
};

function requestBody(index: number): ApiBody {
  const init = fetchMock.mock.calls[index][1];
  return JSON.parse(String(init?.body ?? "{}")) as ApiBody;
}

function lastMessage(index: number): { role: string; content: unknown } {
  const { messages } = requestBody(index);
  return messages[messages.length - 1];
}

function baseTurn(overrides: Partial<Parameters<typeof runEngineTurn>[0]>) {
  return runEngineTurn({
    authKey: "test-key",
    modelId: "test/model",
    apiMessages: buildApiMessages([{ role: "user", content: "Write it all" }]),
    tools: [],
    executeTool: async () => ({ text: "unused" }),
    handlers: { onText: () => {} },
    ...overrides,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetModelCatalogCache();
});

describe("the system prompt does not ration reply length", () => {
  it("asks for structure and completeness, never brevity", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/be concise/i);
    expect(SYSTEM_PROMPT).toContain("Length follows the task, not a quota");
    expect(SYSTEM_PROMPT).toContain("deliver all of it in one reply");
  });
});

describe("output ceiling on the gateway request", () => {
  it("sends the model's own max_tokens when known and omits the field when unknown", async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([token("ok"), finish("stop")]));
    await baseTurn({ maxOutputTokens: 64_000 });
    expect(requestBody(0).max_tokens).toBe(64_000);

    fetchMock.mockResolvedValueOnce(sseResponse([token("ok"), finish("stop")]));
    await baseTurn({});
    expect(requestBody(1).max_tokens).toBeUndefined();
  });

  it("retries once without the cap when the gateway rejects max_tokens for this call", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "input length and max_tokens exceed context limit: 190000 + 64000 > 200000" } }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(sseResponse([token("Fits now."), finish("stop")]));
    const result = await baseTurn({ maxOutputTokens: 64_000 });
    expect(result.content).toBe("Fits now.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(0).max_tokens).toBe(64_000);
    expect(requestBody(1).max_tokens).toBeUndefined();
  });

  it("does not retry other 400s and never retries when no cap was sent", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad tools schema", { status: 400 }));
    await expect(baseTurn({ maxOutputTokens: 64_000 })).rejects.toThrow(/gateway 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response("max_tokens too large", { status: 400 }));
    await expect(baseTurn({})).rejects.toThrow(/gateway 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes catalog values to whole positive token counts", () => {
    expect(normalizeOutputTokens(64_000)).toBe(64_000);
    expect(normalizeOutputTokens(4096.7)).toBe(4096);
    expect(normalizeOutputTokens(0)).toBeUndefined();
    expect(normalizeOutputTokens(-1)).toBeUndefined();
    expect(normalizeOutputTokens(Number.NaN)).toBeUndefined();
    expect(normalizeOutputTokens("64000")).toBeUndefined();
    expect(normalizeOutputTokens(undefined)).toBeUndefined();
  });
});

describe("continuing a reply the provider cut at its token limit", () => {
  it("keeps the chunk, asks the model to continue in place, and splices the repeated words", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([token("The quick bro"), finish("length")]))
      .mockResolvedValueOnce(
        sseResponse([token("quick"), token(" bro"), token("wn fox"), token(" jumps."), finish("stop")]),
      );
    const texts: string[] = [];
    const result = await baseTurn({ handlers: { onText: (full) => texts.push(full) } });

    expect(result.content).toBe("The quick brown fox jumps.");
    expect(result.stopReason).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The shown text only ever grows — no restart, no backwards jump at the seam.
    for (let i = 1; i < texts.length; i += 1) {
      expect(texts[i].startsWith(texts[i - 1])).toBe(true);
    }
    expect(texts[texts.length - 1]).toBe("The quick brown fox jumps.");

    const body = requestBody(1);
    expect(body.messages.some((m) => m.role === "assistant" && m.content === "The quick bro")).toBe(true);
    expect(lastMessage(1)).toEqual({ role: "system", content: CUT_CONTINUE_NOTE });
  });

  it("chains as many continuations as the reply needs", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([token("Part one. "), finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("Part two. "), finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("Part three."), finish("stop")]));
    const result = await baseTurn({});
    expect(result.content).toBe("Part one. Part two. Part three.");
    expect(result.stopReason).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Every continuation request replays the earlier chunks as assistant turns.
    const third = requestBody(2).messages.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(third).toEqual(["Part one. ", "Part two. "]);
  });

  it("a normally finished round is never continued", async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([token("Short and done."), finish("stop")]));
    const result = await baseTurn({});
    expect(result.content).toBe("Short and done.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops a tool call the cut left incomplete and tells the model to split the work", async () => {
    const executeTool = vi.fn(async () => ({ text: "should not run" }));
    fetchMock
      .mockResolvedValueOnce(sseResponse([toolDelta("write_file", '{"path":"big.md","content":"aaaa'), finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("Split into parts."), finish("stop")]));
    const toolSnapshots: number[] = [];
    const result = await baseTurn({
      tools: [{ type: "function", function: { name: "write_file", description: "w", parameters: {} } }],
      executeTool,
      handlers: { onText: () => {}, onToolCalls: (calls) => toolSnapshots.push(calls.length) },
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe("Split into parts.");
    expect(lastMessage(1)).toEqual({ role: "system", content: CUT_TOOLCALL_NOTE });
    // The ghost chip of the never-run call is cleared.
    expect(toolSnapshots[toolSnapshots.length - 1]).toBe(0);
  });

  it("gives a round that spent its budget before any visible text one direct retry", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("Here is the answer."), finish("stop")]));
    const result = await baseTurn({});
    expect(result.content).toBe("Here is the answer.");
    expect(lastMessage(1)).toEqual({ role: "system", content: CUT_EMPTY_NOTE });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(sseResponse([finish("length")])).mockResolvedValueOnce(sseResponse([finish("length")]));
    const empty = await baseTurn({});
    expect(empty.content).toBe("");
    expect(empty.stopReason).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops when the model repeats the previous chunk verbatim instead of writing on", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([token("Loop text"), finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("Loop text"), finish("length")]));
    const result = await baseTurn({});
    expect(result.content).toBe("Loop text");
    expect(result.stopReason).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wraps up honestly when one more chunk could not fit under the surface's storage ceiling", async () => {
    const chunk = "A".repeat(20);
    fetchMock
      .mockResolvedValueOnce(sseResponse([token(chunk), finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("Stopped after the first block; say continue for the rest."), finish("stop")]));
    const result = await baseTurn({ maxContentChars: 30 });
    expect(result.stopReason).toBe("size");
    expect(result.content).toBe(`${chunk}\n\nStopped after the first block; say continue for the rest.`);
    // The wrap-up call carries the size instruction and no tools.
    const wrap = requestBody(1);
    expect(String(lastMessage(1).content)).toContain("maximum length one message can hold");
    expect(wrap.tools).toBeUndefined();
  });

  it("steering after a token cut still appends raw from the exact character", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([token("Alpha bet"), finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("bet"), token("a gamma."), finish("stop")]));
    const result = await baseTurn({});
    expect(result.content).toBe("Alpha beta gamma.");
  });
});

describe("streamGatewayText — tool-less prose (research report, Julius council) is never left cut", () => {
  const messages: EngineMessage[] = [
    { role: "system", content: "Write the report." },
    { role: "user", content: "Question" },
  ];

  it("continues a cut report in place, replaying the chunk and the continuation note", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([token("## Findings\n\nThe market gre"), finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("market grew 40% [2]."), finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("\n\n## Sources"), finish("stop")]));
    const texts: string[] = [];
    const result = await streamGatewayText({
      authKey: "test-key",
      modelId: "anthropic/claude-fable-5.1",
      messages,
      maxOutputTokens: 64_000,
      handlers: { onText: (full) => texts.push(full) },
    });
    expect(result.content).toBe("## Findings\n\nThe market grew 40% [2].\n\n## Sources");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 1; i < texts.length; i += 1) {
      expect(texts[i].startsWith(texts[i - 1])).toBe(true);
    }
    for (let i = 0; i < 3; i += 1) {
      expect(requestBody(i).max_tokens).toBe(64_000);
      expect(requestBody(i).tools).toBeUndefined();
    }
    const third = requestBody(2).messages;
    expect(third.slice(0, 2)).toEqual(messages);
    expect(third.slice(2)).toEqual([
      { role: "assistant", content: "## Findings\n\nThe market gre" },
      { role: "system", content: CUT_CONTINUE_NOTE },
      { role: "assistant", content: "market grew 40% [2]." },
      { role: "system", content: CUT_CONTINUE_NOTE },
    ]);
    // The caller's own messages are never mutated by the chain.
    expect(messages).toHaveLength(2);
  });

  it("returns a normally finished text after one call and keeps the served model", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([{ ...token("Short report."), model: "openai/gpt-5.6-terra" }, finish("stop")]),
    );
    const result = await streamGatewayText({
      authKey: "test-key",
      modelId: "test/model",
      messages,
      handlers: { onText: () => {} },
    });
    expect(result.content).toBe("Short report.");
    expect(result.servedModelId).toBe("openai/gpt-5.6-terra");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(0).max_tokens).toBeUndefined();
  });

  it("stops chaining when the run was cancelled, keeping what streamed", async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([token("Partial"), finish("length")]));
    const result = await streamGatewayText({
      authKey: "test-key",
      modelId: "test/model",
      messages,
      isCancelled: () => true,
      handlers: { onText: () => {} },
    });
    expect(result.content).toBe("Partial");
    expect(result.finishReason).toBe("length");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ends a stuck chain honestly: blank rounds get one retry, a verbatim repeat stops", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("Body"), finish("length")]))
      .mockResolvedValueOnce(sseResponse([token("Body"), finish("length")]));
    const result = await streamGatewayText({
      authKey: "test-key",
      modelId: "test/model",
      messages,
      handlers: { onText: () => {} },
    });
    expect(result.content).toBe("Body");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(lastMessage(1)).toEqual({ role: "system", content: CUT_EMPTY_NOTE });
  });
});

describe("joinCutText splices a token-limit seam", () => {
  it("dedupes the repeated words and joins byte-for-byte without them", () => {
    expect(joinCutText("The quick bro", "quick brown fox")).toBe("The quick brown fox");
    expect(joinCutText("The quick bro", "wn fox")).toBe("The quick brown fox");
    expect(joinCutText("const x = fo", "const x = foo;")).toBe("const x = foo;");
    expect(joinCutText("", "tail")).toBe("tail");
    expect(joinCutText("head", "")).toBe("head");
  });

  it("holds the head while the repeat is still arriving, so the text never jumps back", () => {
    expect(joinCutText("The quick bro", "quick")).toBe("The quick bro");
    expect(joinCutText("The quick bro", "quick bro")).toBe("The quick bro");
    expect(joinCutText("The quick bro", "quick brow")).toBe("The quick brow");
  });

  it("tolerates blank lines before the repeat and keeps code fences intact", () => {
    expect(joinCutText("line one\n", "\n\nline one\nline two")).toBe("line one\nline two");
    expect(joinCutText("```ts\nconst a = 1;\nconst b =", " 2;\n```")).toBe("```ts\nconst a = 1;\nconst b = 2;\n```");
  });

  it("never invents whitespace at a hard token boundary", () => {
    expect(joinCutText("mid-wo", "rd")).toBe("mid-word");
    expect(joinCutText("end.", "Next")).toBe("end.Next");
  });
});

describe("the server model catalog knows each model's output ceiling", () => {
  it("parses max_tokens and serves it per model, unknown → undefined", async () => {
    const catalog = {
      data: [
        { id: "anthropic/claude", max_tokens: 64_000, modalities: { input: ["text", "image"] } },
        { id: "no-cap/model", modalities: { input: ["text"] } },
        { id: "bad-cap/model", max_tokens: "lots" },
      ],
    };
    expect(parseModelCatalog(catalog).get("anthropic/claude")?.maxOutputTokens).toBe(64_000);
    expect(parseModelCatalog(catalog).get("no-cap/model")?.maxOutputTokens).toBeUndefined();
    expect(parseModelCatalog(catalog).get("bad-cap/model")?.maxOutputTokens).toBeUndefined();

    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return new Response(JSON.stringify(catalog), { status: 200 });
    }) as unknown as typeof fetch;
    const url = "https://catalog.test/v1/models";
    expect(await modelMaxOutputTokens("anthropic/claude:high", { url, fetch: fetchImpl })).toBe(64_000);
    expect(await modelMaxOutputTokens("no-cap/model", { url, fetch: fetchImpl })).toBeUndefined();
    expect(await modelMaxOutputTokens("unknown/model", { url, fetch: fetchImpl })).toBeUndefined();
    expect(fetches).toBe(1);
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await modelMaxOutputTokens("anthropic/claude", { url: "https://catalog.test/broken", fetch: failing })).toBeUndefined();
  });
});
