import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend")>();
  return { ...actual, authedFetch: vi.fn() };
});

import { authedFetch } from "@/lib/backend";
import {
  attachServerRun,
  CLOUD_MEDIA_PREFIX,
  parseCloudMediaRef,
  resolveCloudMediaRefs,
  toWireMessages,
  type ServerRunEvent,
} from "@/lib/server-run";
import type { ChatMessage } from "@/lib/types";

const authedFetchMock = vi.mocked(authedFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("attachServerRun", () => {
  it("replays live events in order and resolves with the terminal payload", async () => {
    authedFetchMock.mockResolvedValueOnce(
      sseResponse([
        {
          t: "snapshot",
          seq: 1,
          snapshot: {
            runId: "r1",
            conversationId: "c1",
            kind: "chat",
            status: "running",
            startedAt: 1,
            content: "Dra",
          },
        },
        { t: "text", seq: 2, content: "Draft grows" },
        { t: "ping", seq: 3 },
        {
          t: "done",
          seq: 4,
          status: "done",
          message: { id: "a1", content: "Final." },
          usageEvents: [{ modelId: "test/model", usage: { total_tokens: 5 } }],
          steered: [],
          chatUpdatedAt: 42,
        },
      ]),
    );
    const events: ServerRunEvent[] = [];
    const done = await attachServerRun({ conversationId: "c1", onEvent: (event) => events.push(event) });
    expect(done.status).toBe("done");
    expect(done.message.content).toBe("Final.");
    expect(done.chatUpdatedAt).toBe(42);
    expect(done.usageEvents).toHaveLength(1);
    // Pings are filtered; the done event resolves instead of being replayed.
    expect(events.map((event) => event.t)).toEqual(["snapshot", "text"]);
  });

  it("falls back to the stored result when the stream is gone (tab reopened after the run ended)", async () => {
    authedFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/runs/stream")) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      if (path === "/runs/active") {
        return jsonResponse({
          runs: [
            {
              runId: "r1",
              conversationId: "c1",
              kind: "chat",
              status: "stopped",
              startedAt: 1,
              title: "T",
              assistantMessageId: "a1",
              snapshot: null,
              result: {
                status: "stopped",
                message: { id: "a1", content: "Draft kept exactly as shown." },
                usageEvents: [],
                steered: [],
                chatUpdatedAt: 7,
              },
            },
          ],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const done = await attachServerRun({ conversationId: "c1", onEvent: () => {} });
    expect(done.status).toBe("stopped");
    expect(done.message.content).toBe("Draft kept exactly as shown.");
    expect(done.chatUpdatedAt).toBe(7);
  });

  it("fails honestly when the server has no trace of the run", async () => {
    authedFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/runs/stream")) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      if (path === "/runs/active") {
        return jsonResponse({ runs: [] });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    await expect(
      attachServerRun({ conversationId: "missing", onEvent: () => {} }),
    ).rejects.toThrow("The run is no longer on the server.");
  });
});

describe("cloud media refs", () => {
  it("parses refs and refuses malformed ones", () => {
    expect(parseCloudMediaRef(`${CLOUD_MEDIA_PREFIX}run42:3`)).toEqual({ runId: "run42", index: 3 });
    expect(parseCloudMediaRef("https://example.com/x.png")).toBeNull();
    expect(parseCloudMediaRef(`${CLOUD_MEDIA_PREFIX}run42:`)).toBeNull();
    expect(parseCloudMediaRef(`${CLOUD_MEDIA_PREFIX}run42:-1`)).toBeNull();
  });

  it("resolves refs via the backend, passes other URLs through, and drops expired ones honestly", async () => {
    authedFetchMock.mockImplementation(async (path: string) => {
      if (path.includes("idx=0")) {
        return jsonResponse({ kind: "image", dataUrl: "data:image/png;base64,AAA" });
      }
      return jsonResponse({ error: "media_expired" }, 404);
    });
    const { resolved, failed } = await resolveCloudMediaRefs([
      `${CLOUD_MEDIA_PREFIX}r1:0`,
      `${CLOUD_MEDIA_PREFIX}r1:1`,
      "https://cdn.example.com/clip.mp4",
    ]);
    expect(resolved).toEqual(["data:image/png;base64,AAA", "https://cdn.example.com/clip.mp4"]);
    expect(failed).toBe(1);
  });
});

describe("toWireMessages", () => {
  it("sanitizes history: attachments, tool calls, and Julius digests", () => {
    const history: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "look at this",
        attachments: [
          { id: "f1", name: "pic.png", mime: "image/png", dataUrl: "data:image/png;base64,BB" },
          { id: "f2", name: "notes.md", mime: "text/markdown", dataUrl: "", text: "hello" },
        ],
        createdAt: 1,
      },
      {
        id: "a1",
        role: "assistant",
        content: "checked",
        toolCalls: [{ id: "t1", name: "web_search", arguments: "{}", status: "done", result: "res" }],
        createdAt: 2,
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        julius: {
          decision: "manual",
          status: "choice",
          candidates: [
            { id: "c1", modelId: "m1", content: "answer A", status: "done" },
            { id: "c2", modelId: "m2", content: "answer B", status: "done" },
          ],
          reviews: [],
          startedAt: 1,
        },
        createdAt: 3,
      },
    ];
    const wire = toWireMessages(history);
    expect(wire[0].attachments).toEqual([
      { name: "pic.png", mime: "image/png", dataUrl: "data:image/png;base64,BB" },
      { name: "notes.md", mime: "text/markdown", dataUrl: "", text: "hello" },
    ]);
    expect(wire[1].toolCalls).toEqual([
      { id: "t1", name: "web_search", arguments: "{}", result: "res" },
    ]);
    // A no-winner panel replays as a digest source; ids and statuses stay behind.
    expect(wire[2].julius).toEqual({
      candidates: [
        { modelId: "m1", content: "answer A" },
        { modelId: "m2", content: "answer B" },
      ],
    });
  });
});
