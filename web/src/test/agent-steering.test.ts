import { beforeEach, describe, expect, it, vi } from "vitest";

// The agent loop now runs ON THE SERVER — these tests drive the exact engine
// module that ships to the backend (functions/agent-engine.ts is
// platform-neutral by design), so the steering semantics stay covered:
// soft-cut keeps the draft, guidance is woven in, nothing restarts.
import {
  buildApiMessages,
  runEngineTurn,
  type EngineSteerItem,
} from "../../../functions/agent-engine";

const fetchMock = vi.fn<typeof fetch>();

/**
 * A hand-fed SSE response: the test pushes events while the real engine loop
 * reads them live, so mid-stream timing (steering cuts) is exercised for real.
 */
function sseFeed() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, { status: 200 }),
    send(event: Record<string, unknown>) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    /** Ends the round the way the gateway does: terminal marker, then the connection closes. */
    close() {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  };
}

const token = (text: string) => ({ choices: [{ delta: { content: text } }] });

type ApiBody = { messages: Array<{ role: string; content: unknown; tool_calls?: unknown }> };

function requestBody(index: number): ApiBody {
  const init = fetchMock.mock.calls[index][1];
  return JSON.parse(String(init?.body ?? "{}")) as ApiBody;
}

/** Queues SSE feeds for consecutive completion calls; extra calls fail loudly. */
function scriptFeeds(feeds: Array<ReturnType<typeof sseFeed>>) {
  const remaining = [...feeds];
  fetchMock.mockImplementation(async () => {
    const next = remaining.shift();
    if (!next) {
      throw new Error("unexpected extra completion call");
    }
    return next.response;
  });
}

function baseTurn(overrides: Partial<Parameters<typeof runEngineTurn>[0]>) {
  return runEngineTurn({
    authKey: "test-key",
    modelId: "test/model",
    apiMessages: buildApiMessages([{ role: "user", content: "Question" }]),
    tools: [],
    executeTool: async () => ({ text: "unused" }),
    handlers: { onText: () => {} },
    ...overrides,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("live steering in the server engine", () => {
  it("cuts the stream mid-reply, keeps the draft, and continues the same reply", async () => {
    const first = sseFeed();
    const second = sseFeed();
    scriptFeeds([first, second]);

    let ping: () => void = () => {};
    const inbox: EngineSteerItem[] = [];
    const texts: string[] = [];

    const turn = baseTurn({
      takeSteering: () => inbox.splice(0),
      steeringWrapNote: "WRAP NOTE",
      watchSteering: (listener) => {
        ping = listener;
        return () => {};
      },
      handlers: { onText: (full) => texts.push(full) },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.send(token("The draft so fa"));
    await vi.waitFor(() => expect(texts[texts.length - 1]).toBe("The draft so fa"));

    // Guidance lands while the model is mid-sentence.
    inbox.push({ id: "s1", text: "make it shorter", attachments: [] });
    ping();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    second.send(token("r — cut short."));
    second.close();

    const result = await turn;
    // One continuous reply: kept draft + seamless continuation, no restart.
    expect(result.content).toBe("The draft so far — cut short.");
    expect(result.stopReason).toBe("completed");
    expect(texts[texts.length - 1]).toBe("The draft so far — cut short.");
    // The bubble NEVER goes backwards — every emission extends the shown text.
    for (let i = 1; i < texts.length; i += 1) {
      expect(texts[i].startsWith(texts[i - 1])).toBe(true);
    }

    // The continuation request carries draft + guidance + the steering note.
    const body = requestBody(1);
    expect(
      body.messages.some((m) => m.role === "assistant" && m.content === "The draft so fa"),
    ).toBe(true);
    expect(body.messages.some((m) => m.role === "user" && m.content === "make it shorter")).toBe(
      true,
    );
    expect(
      body.messages.some(
        (m) => m.role === "system" && String(m.content).includes("[steering]"),
      ),
    ).toBe(true);
  });

  it("appends a continuation when steering lands after the answer finished — never rewrites", async () => {
    const first = sseFeed();
    const second = sseFeed();
    scriptFeeds([first, second]);

    // The guidance misses the top-of-loop drain AND the live stream — it lands
    // in the post-answer window (drain #2).
    let drains = 0;
    const takeSteering = (): EngineSteerItem[] => {
      drains += 1;
      return drains === 2 ? [{ id: "s2", text: "add a price estimate", attachments: [] }] : [];
    };

    const texts: string[] = [];
    const turn = baseTurn({
      takeSteering,
      steeringWrapNote: "WRAP NOTE",
      watchSteering: () => () => {},
      handlers: { onText: (full) => texts.push(full) },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.send(token("Full answer."));
    first.close();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    second.send(token("Price: about $20."));
    second.close();

    const result = await turn;
    expect(result.content).toBe("Full answer.\n\nPrice: about $20.");
    // The finished text never left the screen; the continuation appended below.
    expect(texts[texts.length - 1]).toBe("Full answer.\n\nPrice: about $20.");
    expect(texts).not.toContain("Price: about $20.");
    for (let i = 1; i < texts.length; i += 1) {
      expect(texts[i].startsWith(texts[i - 1])).toBe(true);
    }

    const body = requestBody(1);
    expect(body.messages.some((m) => m.role === "system" && m.content === "WRAP NOTE")).toBe(true);
    expect(body.messages.some((m) => m.role === "assistant" && m.content === "Full answer.")).toBe(
      true,
    );
  });

  it("discards the cut round's half-assembled tool calls and clears their ghost chips", async () => {
    const first = sseFeed();
    const second = sseFeed();
    scriptFeeds([first, second]);

    let ping: () => void = () => {};
    const inbox: EngineSteerItem[] = [];
    const toolEmissions: unknown[][] = [];

    const turn = baseTurn({
      takeSteering: () => inbox.splice(0),
      steeringWrapNote: "WRAP NOTE",
      watchSteering: (listener) => {
        ping = listener;
        return () => {};
      },
      handlers: {
        onText: () => {},
        onToolCalls: (calls) => toolEmissions.push(calls),
      },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The model starts assembling a tool call…
    first.send({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "web_search", arguments: '{"qu' } },
            ],
          },
        },
      ],
    });
    await vi.waitFor(() => expect(toolEmissions.length).toBeGreaterThan(0));

    // …and the user steers before it completes.
    inbox.push({ id: "s3", text: "no web search, answer from memory", attachments: [] });
    ping();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    second.send(token("From memory: 42."));
    second.close();

    const result = await turn;
    expect(result.content).toBe("From memory: 42.");
    // The half-assembled call was never executed and never recorded.
    expect(result.toolCalls).toEqual([]);
    // The ghost chip cleared the moment the cut landed.
    expect(toolEmissions[toolEmissions.length - 1]).toEqual([]);

    // Nothing tool-shaped leaked into the continuation request.
    const body = requestBody(1);
    expect(body.messages.some((m) => m.role === "tool")).toBe(false);
    expect(body.messages.some((m) => m.tool_calls !== undefined)).toBe(false);
    expect(
      body.messages.some((m) => m.role === "user" && m.content === "no web search, answer from memory"),
    ).toBe(true);
  });

  it("boundary steering supplements the original task instead of replacing it", async () => {
    const first = sseFeed();
    const second = sseFeed();
    scriptFeeds([first, second]);

    const inbox: EngineSteerItem[] = [];
    let releaseTool: () => void = () => {};
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });

    const turn = baseTurn({
      executeTool: async () => {
        await toolGate;
        return { text: "search results" };
      },
      takeSteering: () => inbox.splice(0),
      steeringWrapNote: "WRAP NOTE",
      watchSteering: () => () => {},
      handlers: { onText: () => {} },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Round 1: the model calls a tool; the guidance arrives while it executes —
    // there is no live stream to cut, so it lands at the next step boundary.
    first.send({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "web_search", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    first.close();
    inbox.push({ id: "s4", text: "focus on 2026 data", attachments: [] });
    releaseTool();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    second.send(token("Answer focused on 2026."));
    second.close();

    const result = await turn;
    expect(result.content).toBe("Answer focused on 2026.");
    expect(result.stopReason).toBe("completed");

    const body = requestBody(1);
    // The guidance rides as a user message with the anchoring note right after…
    const guidanceIndex = body.messages.findIndex(
      (m) => m.role === "user" && m.content === "focus on 2026 data",
    );
    expect(guidanceIndex).toBeGreaterThan(0);
    const note = body.messages[guidanceIndex + 1];
    expect(note.role).toBe("system");
    expect(String(note.content)).toContain("supplements the original request");
    expect(String(note.content)).toContain("does not replace it");
    // …while the original question and the finished tool round stay in context,
    // so the model keeps working the SAME task with the guidance folded in.
    expect(body.messages.some((m) => m.role === "user" && m.content === "Question")).toBe(true);
    expect(body.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("a stop cuts a grinding tool call instead of waiting it out", async () => {
    const first = sseFeed();
    scriptFeeds([first]);

    let ping: () => void = () => {};
    let stopped = false;
    let toolStarted = false;
    const toolEmissions: Array<Array<{ status: string }>> = [];

    const turn = baseTurn({
      executeTool: () => {
        toolStarted = true;
        // The call grinds forever — a stop must not wait for it.
        return new Promise<never>(() => {});
      },
      takeSteering: () => [],
      watchSteering: (listener) => {
        ping = listener;
        return () => {};
      },
      isStopped: () => stopped,
      handlers: {
        onText: () => {},
        onToolCalls: (calls) => toolEmissions.push(calls.map((call) => ({ status: call.status }))),
      },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.send({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "web_search", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    first.close();
    await vi.waitFor(() => expect(toolStarted).toBe(true));

    stopped = true;
    ping(); // the stop pings the tool-phase watcher — the race cuts the call

    const result = await turn;
    expect(result.stopReason).toBe("stopped");
    // The cut call is marked honestly — no ghost spinner survives the stop.
    expect(result.toolCalls[0]?.status).toBe("error");
    expect(result.toolCalls[0]?.result).toContain("stopped");
    const last = toolEmissions[toolEmissions.length - 1];
    expect(last?.every((call) => call.status !== "running")).toBe(true);
    // No extra completion call after the stop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a stop between tool calls skips the rest of the round", async () => {
    const first = sseFeed();
    scriptFeeds([first]);

    let stopped = false;
    const ran: string[] = [];

    const turn = baseTurn({
      executeTool: async (name) => {
        ran.push(name);
        stopped = true; // the user stops while the first call is still running
        return { text: "first result" };
      },
      takeSteering: () => [],
      watchSteering: () => () => {},
      isStopped: () => stopped,
      handlers: { onText: () => {} },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.send({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_a", function: { name: "tool_a", arguments: "{}" } },
              { index: 1, id: "call_b", function: { name: "tool_b", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    first.close();

    const result = await turn;
    expect(result.stopReason).toBe("stopped");
    // Only the in-flight call ran; the second never started.
    expect(ran).toEqual(["tool_a"]);
    expect(result.toolCalls.map((call) => call.status)).toEqual(["done", "error"]);
    expect(result.toolCalls[1]?.result).toContain("stopped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a stop request finishes NOW and keeps the draft exactly as shown", async () => {
    const first = sseFeed();
    scriptFeeds([first]);

    let ping: () => void = () => {};
    let stopped = false;
    const texts: string[] = [];

    const turn = baseTurn({
      takeSteering: () => [],
      watchSteering: (listener) => {
        ping = listener;
        return () => {};
      },
      isStopped: () => stopped,
      handlers: { onText: (full) => texts.push(full) },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.send(token("Partial answer that must surv"));
    await vi.waitFor(() => expect(texts[texts.length - 1]).toBe("Partial answer that must surv"));

    stopped = true;
    ping(); // the stop pings the same watcher — the stream soft-cuts

    const result = await turn;
    expect(result.stopReason).toBe("stopped");
    expect(result.content).toBe("Partial answer that must surv");
    // No extra completion call was made after the stop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
