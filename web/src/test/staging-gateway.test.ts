import { afterEach, describe, expect, it, vi } from "vitest";

import { streamGatewayCompletion } from "../../../functions/agent-engine";

function sse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

describe("server-controlled staging gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the explicit HTTPS endpoint without exposing the auth key in the URL", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => sse([
      {
        model: "staging/deterministic",
        choices: [{ delta: { content: "black-box complete" } }],
      },
      {
        model: "staging/deterministic",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamGatewayCompletion({
      authKey: "server-only-gateway-key",
      gatewayUrl: "https://gera-provider.example.workers.dev/v1/chat/completions",
      modelId: "staging/deterministic",
      messages: [{ role: "user", content: "run" }],
      tools: [],
      handlers: { onText: vi.fn() },
    });

    expect(result.content).toBe("black-box complete");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gera-provider.example.workers.dev/v1/chat/completions");
    expect(url).not.toContain("server-only-gateway-key");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer server-only-gateway-key");
  });

  it("rejects a non-HTTPS override before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamGatewayCompletion({
      authKey: "key",
      gatewayUrl: "https://127.0.0.1/v1/chat/completions",
      modelId: "staging/deterministic",
      messages: [{ role: "user", content: "run" }],
      tools: [],
      handlers: { onText: vi.fn() },
    })).rejects.toThrow("public HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
