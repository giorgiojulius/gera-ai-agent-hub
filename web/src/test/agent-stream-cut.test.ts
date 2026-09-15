import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A model reply that stops arriving is not a finished reply. These tests
// drive the exact server engine (functions/agent-engine.ts) through the
// failure shapes seen in production with slow flagship models: the upstream
// connection closes before the terminal `[DONE]` marker, a read fails
// mid-stream, the gateway streams an error object under HTTP 200, or a
// request fails before any token (overload, rate limit, network reset). In
// every case the text already shown stays, the SAME reply continues over a
// fresh connection, and only a connection that keeps dropping ends the run —
// honestly, with the reason.
import {
  buildApiMessages,
  CUT_DROPPED_NOTE,
  engineDelays,
  GATEWAY_ATTEMPTS,
  GatewayRequestError,
  GatewayStreamCutError,
  isTransientGatewayError,
  MAX_DROPPED_ROUNDS,
  runEngineTurn,
  streamGatewayCompletion,
  streamGatewayText,
} from "../../../functions/agent-engine";

const fetchMock = vi.fn<typeof fetch>();

type SseEvent = Record<string, unknown>;

const token = (text: string): SseEvent => ({ choices: [{ delta: { content: text } }] });
const finish = (reason: string): SseEvent => ({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = (): SseEvent => ({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } });
const toolDelta = (name: string, args: string): SseEvent => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] } }],
});

function frames(events: SseEvent[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** A complete stream: events, then the provider's terminal marker. */
function finished(events: SseEvent[]): Response {
  return new Response(`${frames(events)}data: [DONE]\n\n`, { status: 200 });
}

/** A stream whose connection closed early — no `[DONE]`, no finish_reason. */
function truncated(events: SseEvent[]): Response {
  return new Response(frames(events), { status: 200 });
}

/** A stream whose body errors mid-read after the given events were delivered. */
function failing(events: SseEvent[], message: string): Response {
  const encoder = new TextEncoder();
  let delivered = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(encoder.encode(frames(events)));
        return;
      }
      // Erroring resets the queue, so the failure must follow the read that
      // consumed the events — exactly how a reset socket behaves.
      controller.error(new TypeError(message));
    },
  });
  return new Response(stream, { status: 200 });
}

type ApiBody = { messages: Array<{ role: string; content: unknown; tool_calls?: unknown }> };

function requestBody(index: number): ApiBody {
  const init = fetchMock.mock.calls[index][1];
  return JSON.parse(String(init?.body ?? "{}")) as ApiBody;
}

function baseTurn(overrides: Partial<Parameters<typeof runEngineTurn>[0]> = {}) {
  return runEngineTurn({
    authKey: "test-key",
    modelId: "anthropic/claude-fable-5.1:xhigh",
    apiMessages: buildApiMessages([{ role: "user", content: "Write the plan" }]),
    tools: [],
    executeTool: async () => ({ text: "unused" }),
    handlers: { onText: () => {} },
    ...overrides,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // Recovery pauses are real seconds in production; the suite must not wait them out.
  engineDelays.cutContinueMs = 0;
  engineDelays.retryBaseMs = 0;
});

afterEach(() => {
  engineDelays.cutContinueMs = 1_000;
  engineDelays.retryBaseMs = 1_500;
  vi.unstubAllGlobals();
});

describe("streamGatewayCompletion tells a finished reply from a dropped one", () => {
  const params = {
    authKey: "k",
    modelId: "test/model",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [],
    handlers: { onText: () => {} },
  };

  it("a stream ending with [DONE] is finished and carries no cut", async () => {
    fetchMock.mockResolvedValueOnce(finished([token("Done reply."), finish("stop")]));
    const result = await streamGatewayCompletion(params);
    expect(result.content).toBe("Done reply.");
    expect(result.finishReason).toBe("stop");
    expect(result.cut).toBeUndefined();
  });

  it("a connection that closes after text but before finish_reason is a cut, and the text is kept", async () => {
    fetchMock.mockResolvedValueOnce(truncated([token("Half of the")]));
    const result = await streamGatewayCompletion(params);
    expect(result.content).toBe("Half of the");
    expect(result.finishReason).toBeUndefined();
    expect(result.cut).toEqual({ kind: "dropped", detail: expect.stringContaining("closed before the reply finished") });
  });

  it("a provider that omits [DONE] but sent finish_reason or usage is still finished", async () => {
    fetchMock.mockResolvedValueOnce(truncated([token("All of it."), finish("stop")]));
    expect((await streamGatewayCompletion(params)).cut).toBeUndefined();
    fetchMock.mockResolvedValueOnce(truncated([token("All of it."), usage()]));
    expect((await streamGatewayCompletion(params)).cut).toBeUndefined();
  });

  it("a read failure mid-stream keeps what arrived and reports the cut", async () => {
    fetchMock.mockResolvedValueOnce(failing([token("Streamed so far")], "network reset"));
    const result = await streamGatewayCompletion(params);
    expect(result.content).toBe("Streamed so far");
    expect(result.cut).toEqual({ kind: "dropped", detail: expect.stringContaining("network reset") });
  });

  it("an error object streamed under HTTP 200 is a cut with the upstream reason, even after [DONE]", async () => {
    fetchMock.mockResolvedValueOnce(
      finished([
        token("Partial"),
        {
          error: {
            message: "Stream error occurred",
            value: { error_message: JSON.stringify({ error: { message: "Overloaded: upstream provider busy" } }) },
          },
        },
      ]),
    );
    const result = await streamGatewayCompletion(params);
    expect(result.content).toBe("Partial");
    expect(result.cut).toEqual({ kind: "error", detail: "Overloaded: upstream provider busy" });
  });

  it("a stream that drops before any text throws a transient error the caller retries", async () => {
    fetchMock.mockResolvedValueOnce(truncated([toolDelta("write_file", '{"path":"a')]));
    await expect(streamGatewayCompletion(params)).rejects.toBeInstanceOf(GatewayStreamCutError);
  });

  it("a non-2xx answer is a typed request error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("overloaded", { status: 529 }));
    await expect(streamGatewayCompletion(params)).rejects.toMatchObject({ status: 529 });
  });

  it("a stream silent past the idle guard is a cut, not a hang", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames([token("Thinking out loud")])));
        // …and then nothing, ever.
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const result = await streamGatewayCompletion({ ...params, streamIdleMs: 20 });
    expect(result.content).toBe("Thinking out loud");
    expect(result.cut).toEqual({ kind: "dropped", detail: expect.stringContaining("sent nothing") });
  });
});

describe("what counts as transient", () => {
  it("retries overload, rate limits, resets and empty drops; never client mistakes", () => {
    expect(isTransientGatewayError(new GatewayRequestError(429, "slow down"))).toBe(true);
    expect(isTransientGatewayError(new GatewayRequestError(503, "busy"))).toBe(true);
    expect(isTransientGatewayError(new GatewayRequestError(529, "overloaded"))).toBe(true);
    expect(isTransientGatewayError(new GatewayStreamCutError("dropped"))).toBe(true);
    expect(isTransientGatewayError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientGatewayError(new GatewayRequestError(400, "bad request"))).toBe(false);
    expect(isTransientGatewayError(new GatewayRequestError(401, "no auth"))).toBe(false);
    expect(isTransientGatewayError(new Error("logic bug"))).toBe(false);
  });
});

describe("runEngineTurn continues a reply whose connection dropped", () => {
  it("keeps the streamed text, reconnects, and splices the continuation into one reply", async () => {
    fetchMock
      .mockResolvedValueOnce(truncated([token("## Plan\n\nStep one is to gath")]))
      .mockResolvedValueOnce(finished([token("to gather"), token(" the facts."), finish("stop")]));
    const texts: string[] = [];
    const result = await baseTurn({ handlers: { onText: (full) => texts.push(full) } });

    expect(result.content).toBe("## Plan\n\nStep one is to gather the facts.");
    expect(result.stopReason).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The bubble never goes backwards — every emission extends the shown text.
    for (let i = 1; i < texts.length; i += 1) {
      expect(texts[i].startsWith(texts[i - 1])).toBe(true);
    }
    // The continuation request replays the kept draft and explains the drop.
    const body = requestBody(1);
    const messages = body.messages;
    expect(messages[messages.length - 2]).toEqual({ role: "assistant", content: "## Plan\n\nStep one is to gath" });
    expect(messages[messages.length - 1]).toEqual({ role: "system", content: CUT_DROPPED_NOTE });
  });

  it("a half-assembled tool call from the dropped round never runs and its chip clears", async () => {
    const executeTool = vi.fn(async () => ({ text: "must not run" }));
    fetchMock
      .mockResolvedValueOnce(failing([token("Checking the repo. "), toolDelta("get_contents", '{"path":"src')], "reset"))
      .mockResolvedValueOnce(finished([token("Checking the repo. Done without it."), finish("stop")]));
    const chips: number[] = [];
    const result = await baseTurn({
      tools: [{ type: "function", function: { name: "get_contents", description: "r", parameters: {} } }],
      executeTool,
      handlers: { onText: () => {}, onToolCalls: (calls) => chips.push(calls.length) },
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([]);
    expect(chips[chips.length - 1]).toBe(0);
    expect(result.content).toBe("Checking the repo. Done without it.");
    expect(requestBody(1).messages.some((m) => m.tool_calls !== undefined)).toBe(false);
  });

  it("a request that fails before any token is retried with backoff, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(finished([token("Third time lucky."), finish("stop")]));
    const result = await baseTurn();
    expect(result.content).toBe("Third time lucky.");
    expect(fetchMock).toHaveBeenCalledTimes(GATEWAY_ATTEMPTS);
    // Retries repeat the SAME request — no continuation note for an empty round.
    expect(requestBody(2).messages).toEqual(requestBody(0).messages);
  });

  it("gives up honestly when the request keeps failing before any token", async () => {
    fetchMock.mockResolvedValue(new Response("busy", { status: 503 }));
    await expect(baseTurn()).rejects.toThrow(/gateway 503/);
    expect(fetchMock).toHaveBeenCalledTimes(GATEWAY_ATTEMPTS);
  });

  it("a client mistake (400) is not retried", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad schema", { status: 400 }));
    await expect(baseTurn()).rejects.toThrow(/gateway 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a connection that drops round after round ends the run with the reason, keeping the text", async () => {
    let round = 0;
    fetchMock.mockImplementation(async () => {
      round += 1;
      return truncated([token(`chunk${round} `)]);
    });
    const texts: string[] = [];
    await expect(baseTurn({ handlers: { onText: (full) => texts.push(full) } })).rejects.toThrow(
      /dropped mid-reply \d+ times in a row/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(MAX_DROPPED_ROUNDS + 1);
    // Every kept chunk stayed on screen, in order.
    expect(texts[texts.length - 1]).toBe(
      Array.from({ length: MAX_DROPPED_ROUNDS + 1 }, (_, i) => `chunk${i + 1} `).join(""),
    );
  });

  it("a round that finishes resets the drop counter, so a long reply survives occasional drops", async () => {
    const rounds: Response[] = [];
    for (let i = 0; i < MAX_DROPPED_ROUNDS + 3; i += 1) {
      rounds.push(truncated([token(`part${i} `)]));
      if (i % 3 === 2) {
        rounds.push(finished([toolDelta("lookup", "{}")]));
      }
    }
    rounds.push(finished([token("final."), finish("stop")]));
    for (const round of rounds) {
      fetchMock.mockResolvedValueOnce(round);
    }
    const result = await baseTurn({
      tools: [{ type: "function", function: { name: "lookup", description: "l", parameters: {} } }],
      executeTool: async () => ({ text: "42" }),
    });
    expect(result.stopReason).toBe("completed");
    expect(result.content.endsWith("final.")).toBe(true);
  });

  it("a stop pressed while waiting to retry is honoured", async () => {
    let stopped = false;
    fetchMock.mockImplementation(async () => {
      stopped = true;
      return new Response("busy", { status: 503 });
    });
    await expect(baseTurn({ isStopped: () => stopped })).rejects.toThrow(/gateway 503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("streamGatewayText (research report, Julius) survives a dropped connection", () => {
  it("continues the report over a fresh connection and splices the seam", async () => {
    fetchMock
      .mockResolvedValueOnce(truncated([token("## Findings\n\nRevenue gre")]))
      .mockResolvedValueOnce(finished([token("Revenue grew 40%."), finish("stop")]));
    const result = await streamGatewayText({
      authKey: "k",
      modelId: "test/model",
      messages: [{ role: "user", content: "Write it" }],
      handlers: { onText: () => {} },
    });
    expect(result.content).toBe("## Findings\n\nRevenue grew 40%.");
    expect(result.finishReason).toBe("stop");
    const body = requestBody(1).messages;
    expect(body[body.length - 1]).toEqual({ role: "system", content: CUT_DROPPED_NOTE });
  });

  it("retries an empty-failing request and stops chaining when cancelled", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(finished([token("Report."), finish("stop")]));
    const result = await streamGatewayText({
      authKey: "k",
      modelId: "test/model",
      messages: [{ role: "user", content: "Write it" }],
      handlers: { onText: () => {} },
    });
    expect(result.content).toBe("Report.");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(truncated([token("Cut and cancelled")]));
    const cancelled = await streamGatewayText({
      authKey: "k",
      modelId: "test/model",
      messages: [{ role: "user", content: "Write it" }],
      isCancelled: () => true,
      handlers: { onText: () => {} },
    });
    expect(cancelled.content).toBe("Cut and cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
