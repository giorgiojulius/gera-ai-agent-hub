import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ fetch: vi.fn(), session: "owner-a" }));
vi.mock("@/lib/backend", async (original) => ({
  ...await original<typeof import("@/lib/backend")>(),
  authedFetchForSession: transport.fetch,
}));
vi.mock("@/lib/auth-tokens", async (original) => ({
  ...await original<typeof import("@/lib/auth-tokens")>(),
  authSessionSnapshot: () => transport.session,
  isAuthSessionCurrent: (session: string) => session === transport.session,
}));
import { RunActiveError, RunCapReachedError, startServerRun, type StartServerRunRequest } from "@/lib/server-run";

function request(): StartServerRunRequest {
  return {
    runId: "same-run", conversationId: "same-chat", assistantMessageId: "same-answer",
    kind: "chat", title: "Test", modelId: "test/model",
    config: { history: [], prompt: "Import once", mcpServers: [], builtins: {
      web_search: false, fetch_url: false, selfsurf: false,
      generate_image: false, generate_video: false, generate_audio: false,
    } },
  };
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
const accepted = { ok: true, runId: "same-run", historyOnServer: true, replayed: true, status: "running" };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  transport.session = "owner-a";
  transport.fetch.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("start acknowledgment recovery", () => {
  it("retries HTTP 502 then 504 with the exact original payload and run ID", async () => {
    transport.fetch.mockResolvedValueOnce(json({ error: "upstream_unreachable" }, 502))
      .mockResolvedValueOnce(new Response("Bad gateway", { status: 504 }))
      .mockResolvedValueOnce(json(accepted));
    const body = request();
    const result = startServerRun(body).then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(1);
    body.config.prompt = "Changed while waiting";
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await result).toEqual({ value: accepted });
    expect(transport.fetch).toHaveBeenCalledTimes(3);
    const payloads = transport.fetch.mock.calls.map((call) => String((call[2] as RequestInit).body));
    expect(new Set(payloads).size).toBe(1);
    expect(JSON.parse(payloads[0]).config.prompt).toBe("Import once");
    expect(transport.fetch.mock.calls.every(([path, session]) => path === "/runs/start" && session === "owner-a")).toBe(true);
  });

  it.each([400, 403, 413, 429])("does not replay a definitive HTTP %i rejection", async (status) => {
    transport.fetch.mockResolvedValue(json({ error: "rejected" }, status));
    await expect(startServerRun(request())).rejects.toThrow("rejected");
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an idempotency conflict", async () => {
    transport.fetch.mockResolvedValue(json({ error: "idempotency_conflict" }, 409));
    await expect(startServerRun(request())).rejects.toThrow("different input");
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds gateway retries and reports unconfirmed acceptance instead of claiming no execution", async () => {
    transport.fetch.mockImplementation(async () => json({ error: "upstream_unreachable" }, 502));
    const result = startServerRun(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ message: expect.stringContaining("acceptance could not be confirmed") });
    expect(transport.fetch).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the waiting retry on Stop without issuing another start or a stop from this helper", async () => {
    transport.fetch.mockImplementation(async () => json({ error: "upstream_unreachable" }, 502));
    const controller = new AbortController();
    const result = startServerRun(request(), controller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a terminal interrupted receipt without restarting execution", async () => {
    const terminal = { ...accepted, status: "interrupted", result: {
      message: { id: "same-answer", content: "Saved partial", interrupted: true },
      usageEvents: [], steered: [], chatUpdatedAt: 42,
    } };
    transport.fetch.mockResolvedValueOnce(json({ error: "upstream_unreachable" }, 502))
      .mockResolvedValueOnce(json(terminal));
    const result = startServerRun(request());
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await result).toEqual(terminal);
    expect(transport.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps network-error recovery pinned to the same request", async () => {
    transport.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json(accepted));
    const result = startServerRun(request());
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await result).toEqual(accepted);
    expect(transport.fetch.mock.calls[0][2].body).toBe(transport.fetch.mock.calls[1][2].body);
  });

  it("waits out the account-wide live-run cap, then names the limit honestly", async () => {
    transport.fetch.mockImplementation(async () => json({ error: "too_many_runs", limit: 3, active: 3 }, 429));
    const result = startServerRun(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await result;
    expect(error).toBeInstanceOf(RunCapReachedError);
    expect((error as RunCapReachedError).limit).toBe(3);
    expect((error as Error).message).toContain("3 replies running at once");
    expect((error as Error).message).toContain("every tab and device");
    expect(transport.fetch).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts once a slot frees up during the cap wait", async () => {
    transport.fetch.mockResolvedValueOnce(json({ error: "too_many_runs", limit: 3 }, 429))
      .mockResolvedValueOnce(json(accepted));
    const result = startServerRun(request());
    await vi.advanceTimersByTimeAsync(2_600);
    expect(await result).toEqual(accepted);
    expect(transport.fetch).toHaveBeenCalledTimes(2);
  });

  it("still treats a plain HTTP 429 as a definitive rejection", async () => {
    transport.fetch.mockResolvedValue(json({ error: "rate_limited" }, 429));
    await expect(startServerRun(request())).rejects.toThrow("rate_limited");
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces a persistent run_active as a typed error the caller can hand off", async () => {
    transport.fetch.mockImplementation(async () => json({ error: "run_active", runId: "other" }, 409));
    const result = startServerRun(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await result;
    expect(error).toBeInstanceOf(RunActiveError);
    expect(transport.fetch).toHaveBeenCalledTimes(5);
  });

  it("never retries into a changed account", async () => {
    transport.fetch.mockImplementation(async () => json({ error: "upstream_unreachable" }, 502));
    const result = startServerRun(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    transport.session = "owner-b";
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toMatchObject({ name: "AuthSessionChangedError" });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });
});
