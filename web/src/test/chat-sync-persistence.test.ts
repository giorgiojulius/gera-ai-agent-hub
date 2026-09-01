import { beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetchMock } = vi.hoisted(() => ({ authedFetchMock: vi.fn() }));

vi.mock("@/lib/backend", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/backend")>();
  return { ...actual, authedFetch: authedFetchMock };
});

import { runChatSync } from "@/lib/chat-sync";
import type { AgentSettings, Conversation, LifeState } from "@/lib/types";

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const staleChat: Conversation = {
  id: "local-chat",
  title: "Local stale",
  modelId: "model",
  messages: [{ id: "u1", role: "user", content: "old", createdAt: 1 }],
  createdAt: 1,
  updatedAt: 999,
};

const emptySettings = {} as AgentSettings;
const emptyLife = { memories: [], trackers: [], tasks: [], shareWithAgent: true } as LifeState;

describe("deploy-safe first sync", () => {
  beforeEach(() => {
    authedFetchMock.mockReset();
  });

  it("pulls the durable baseline before offering stale chats, tombstones, or profile payload", async () => {
    authedFetchMock.mockResolvedValue(response({
      want: ["local-chat"],
      profile: { updatedAt: 42, payload: JSON.stringify({ settings: emptySettings, life: emptyLife }) },
      pull: [{
        id: "deleted-chat",
        title: "Should stay deleted",
        updatedAt: 50,
        payload: JSON.stringify({
          id: "deleted-chat",
          title: "Should stay deleted",
          modelId: "model",
          messages: [{ id: "u2", role: "user", content: "server copy", createdAt: 1 }],
          createdAt: 1,
          updatedAt: 50,
        }),
      }],
      tombstones: [],
      deleteAck: [],
    }));

    const result = await runChatSync({
      conversations: [staleChat],
      runningIds: [],
      tombstones: { "deleted-chat": 100 },
      profile: { updatedAt: 1_000, payload: "stale-profile", dirty: true },
      bootstrapOnly: true,
    });

    const init = authedFetchMock.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as {
      push: unknown[];
      delete: unknown[];
      profile: { updatedAt: number; payload?: string };
    };
    expect(sent.push).toEqual([]);
    expect(sent.delete).toEqual([]);
    expect(sent.profile).toEqual({ updatedAt: 0 });
    expect(authedFetchMock).toHaveBeenCalledTimes(1);
    expect(result.profileApplied?.updatedAt).toBe(42);
    expect(result.pulled).toEqual([]);
  });

  it("drops only explicit delete acknowledgements and retries a capped remainder", async () => {
    const tombstones = Object.fromEntries(
      Array.from({ length: 250 }, (_, index) => [`chat-${index}`, index + 1]),
    );
    const accepted = Array.from({ length: 200 }, (_, index) => `chat-${index}`);
    authedFetchMock.mockResolvedValue(response({
      pull: [],
      want: [],
      tombstones: [],
      deleteAck: accepted,
    }));

    const result = await runChatSync({
      conversations: [],
      runningIds: [],
      tombstones,
    });

    expect(result.ackedDeleteIds).toHaveLength(200);
    expect(result.ackedDeleteIds).not.toContain("chat-249");
    expect(result.incomplete).toBe(true);
  });
});
