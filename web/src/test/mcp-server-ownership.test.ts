import { beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetchMock } = vi.hoisted(() => ({ authedFetchMock: vi.fn() }));

vi.mock("@/lib/backend", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/backend")>();
  return {
    ...actual,
    authedFetch: authedFetchMock,
    authedFetchForSession: (path: string, _session: string, init?: RequestInit) =>
      authedFetchMock(path, init),
  };
});

import { serializeProfile } from "@/lib/chat-sync";
import { normalizeStoredSettings } from "@/lib/history";
import { normalizeLife } from "@/lib/life";
import { startServerRun, type StartServerRunRequest } from "@/lib/server-run";

describe("server-owned MCP state", () => {
  beforeEach(() => {
    authedFetchMock.mockReset();
    authedFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, runId: "run-1", historyOnServer: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("redacts keys, custom headers, and OAuth grants from the synced browser profile", () => {
    const settings = normalizeStoredSettings({
      mcpServers: [{
        id: "private-mcp",
        name: "Private MCP",
        url: "https://mcp.example.com",
        enabled: true,
        status: "connected",
        tools: [],
        disabledTools: [],
        token: "secret-token",
        headersJson: '{"X-Secret":"secret-header"}',
      }],
    });
    const payload = serializeProfile(settings, normalizeLife({}));
    expect(payload).not.toBeNull();
    expect(payload).not.toContain("secret-token");
    expect(payload).not.toContain("secret-header");
    expect(payload).not.toContain("mcpOAuth");
  });

  it("sends only connector ids to a run and never forwards GitHub auth", async () => {
    const body = {
      runId: "run-1",
      conversationId: "chat-1",
      assistantMessageId: "assistant-1",
      kind: "chat",
      title: "Chat",
      modelId: "model",
      config: {
        history: [],
        prompt: "inspect",
        builtins: {
          web_search: false,
          fetch_url: false,
          selfsurf: false,
          generate_image: false,
          generate_video: false,
          generate_audio: false,
        },
        mcpServers: [{
          id: "github",
          catalogId: "github",
          name: "GitHub",
          url: "https://api.github.com",
          enabled: true,
          status: "connected",
          tools: [],
          disabledTools: [],
          token: "browser-secret",
          headersJson: "",
        }],
        research: { depth: "balanced", githubAuth: "Bearer browser-secret" },
      },
    } satisfies StartServerRunRequest;

    await startServerRun(body);
    const init = authedFetchMock.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as StartServerRunRequest;
    expect(sent.config.mcpServers).toEqual([{ id: "github", catalogId: "github" }]);
    expect(sent.config.research?.githubAuth).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("browser-secret");
  });
});
