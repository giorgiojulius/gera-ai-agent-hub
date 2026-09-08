import { beforeEach, describe, expect, it, vi } from "vitest";

// The commentary a model writes before calling tools ("Checking the job
// logs…") is part of the reply. These tests drive the real server engine and
// pin the contract the bubble relies on: the text survives the tool phase,
// later rounds append below it, and each tool record remembers the content
// offset it was issued at so rows can sit between the prose segments.
import { buildApiMessages, runEngineTurn } from "../../../functions/agent-engine";

const fetchMock = vi.fn<typeof fetch>();

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
    close() {
      controller.close();
    },
  };
}

const token = (text: string) => ({ choices: [{ delta: { content: text } }] });
const toolCall = (id: string, name: string) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: "{}" } }] } }],
});

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

type ApiBody = { messages: Array<{ role: string; content: unknown; tool_calls?: unknown }> };

function requestBody(index: number): ApiBody {
  const init = fetchMock.mock.calls[index][1];
  return JSON.parse(String(init?.body ?? "{}")) as ApiBody;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("tool-round commentary in the server engine", () => {
  it("keeps every round's prose in the reply and stamps each call with its text offset", async () => {
    const rounds = [sseFeed(), sseFeed(), sseFeed()];
    scriptFeeds(rounds);
    const shown: string[] = [];

    const turn = runEngineTurn({
      authKey: "test-key",
      modelId: "test/model",
      apiMessages: buildApiMessages([{ role: "user", content: "Why did CI fail?" }]),
      tools: [],
      executeTool: async (name) => ({ text: `${name} result` }),
      handlers: { onText: (full) => shown.push(full) },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rounds[0].send(token("Step one."));
    rounds[0].send(toolCall("call_1", "get_job_logs"));
    rounds[0].close();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    rounds[1].send(token("Step two."));
    rounds[1].send(toolCall("call_2", "get_contents"));
    rounds[1].close();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    rounds[2].send(token("Done."));
    rounds[2].close();

    const result = await turn;
    expect(result.stopReason).toBe("completed");
    expect(result.content).toBe("Step one.\n\nStep two.\n\nDone.");
    expect(result.toolCalls.map((call) => [call.id, call.status, call.textOffset])).toEqual([
      ["call_1", "done", "Step one.".length],
      ["call_2", "done", "Step one.\n\nStep two.".length],
    ]);

    // The commentary never disappears from the screen once written: no
    // emission after the first sentence drops it (the old loop blanked the
    // text at the end of every tool round).
    const firstShown = shown.indexOf("Step one.");
    expect(firstShown).toBeGreaterThanOrEqual(0);
    expect(shown.slice(firstShown).every((text) => text.startsWith("Step one."))).toBe(true);
    expect(shown).toContain("Step one.\n\nStep two.\n\nDone.");

    // The model's own context still sees each round exactly as it happened.
    const body = requestBody(2);
    const assistantTurns = body.messages.filter((message) => message.role === "assistant");
    expect(assistantTurns.map((message) => message.content)).toEqual(["Step one.", "Step two."]);
    expect(body.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("a silent tool round adds no separator and the final text follows the calls", async () => {
    const rounds = [sseFeed(), sseFeed()];
    scriptFeeds(rounds);

    const turn = runEngineTurn({
      authKey: "test-key",
      modelId: "test/model",
      apiMessages: buildApiMessages([{ role: "user", content: "Question" }]),
      tools: [],
      executeTool: async () => ({ text: "42" }),
      handlers: { onText: () => {} },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rounds[0].send(toolCall("call_1", "lookup"));
    rounds[0].close();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    rounds[1].send(token("The answer is 42."));
    rounds[1].close();

    const result = await turn;
    expect(result.content).toBe("The answer is 42.");
    expect(result.toolCalls[0]?.textOffset).toBe(0);
  });

  it("a wrap-up after the step budget appends below the kept commentary", async () => {
    // Every round repeats the same call: the loop guard ends the turn and the
    // honest wrap-up must land under the prose written so far, not replace it.
    const feeds: Array<ReturnType<typeof sseFeed>> = [];
    fetchMock.mockImplementation(async () => {
      const feed = sseFeed();
      feeds.push(feed);
      return feed.response;
    });
    const turn = runEngineTurn({
      authKey: "test-key",
      modelId: "test/model",
      apiMessages: buildApiMessages([{ role: "user", content: "Question" }]),
      tools: [],
      executeTool: async () => ({ text: "same" }),
      handlers: { onText: () => {} },
    });

    await vi.waitFor(() => expect(feeds).toHaveLength(1));
    feeds[0].send(token("Looking it up."));
    feeds[0].send(toolCall("call_1", "lookup"));
    feeds[0].close();
    // Identical rounds until the stale-round guard trips and asks for a wrap-up.
    for (let round = 1; round < 12; round += 1) {
      await vi.waitFor(() => expect(feeds.length).toBeGreaterThanOrEqual(round + 1));
      const feed = feeds[round];
      const body = requestBody(round);
      const wrapUp = body.messages.some(
        (message) => message.role === "system" && String(message.content).startsWith("Loop guard"),
      );
      if (wrapUp) {
        feed.send(token("I could not get further."));
        feed.close();
        break;
      }
      feed.send(toolCall(`call_${round + 1}`, "lookup"));
      feed.close();
    }

    const result = await turn;
    expect(result.stopReason).toBe("loop");
    expect(result.content).toBe("Looking it up.\n\nI could not get further.");
    expect(result.toolCalls[0]?.textOffset).toBe("Looking it up.".length);
  });
});
