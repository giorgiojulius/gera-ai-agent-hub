import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AgentProvider, useAgent } from "@/hooks/use-agent";
import { MessageList } from "@/components/gera/MessageList";
import { ACCESS_TOKEN_KEY } from "@/lib/auth-tokens";
import { saveConversations } from "@/lib/history";
import { TID } from "@/lib/testids";
import type { ActiveServerRun } from "@/lib/server-run";

const baseline = vi.hoisted(() => ({ hydrated: false }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "recovery-owner" }, isLoading: false }) }));
vi.mock("@/hooks/use-cloud-sync", () => ({ useCloudSync: () => ({
  isHydrated: baseline.hydrated, scheduleSync: () => {}, recordTombstone: () => {},
}) }));

const requests: string[] = [];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let run: ActiveServerRun;

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}
function Monitor() {
  const { state } = useAgent();
  const thread = state.conversations.find((item) => item.id === "recovery-chat");
  return <>
    {state.runningIds.includes("recovery-chat") && <button data-testid={TID.composerStop}>Stop</button>}
    <MessageList messages={thread?.messages ?? []} streaming={state.runningIds.includes("recovery-chat")} />
  </>;
}
function tree() {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AgentProvider><Monitor /></AgentProvider>
  </QueryClientProvider>;
}
function finish(deliver: boolean): void {
  run = { ...run, status: "done", result: {
    status: "done", message: { id: "recovery-answer", content: "Long job finished on the server." },
    usageEvents: [], steered: [], chatUpdatedAt: Date.now(),
  } };
  if (deliver) {
    for (const controller of streams) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ t: "done", seq: 2, ...run.result })}\n\n`));
      controller.close();
    }
    streams.clear();
  }
}

beforeEach(() => {
  requests.length = 0;
  streams.clear();
  baseline.hydrated = false;
  localStorage.clear();
  localStorage.setItem(ACCESS_TOKEN_KEY, "fixture-session");
  const startedAt = Date.now() - 20 * 60_000;
  run = {
    runId: "same-durable-job", conversationId: "recovery-chat", assistantMessageId: "recovery-answer",
    title: "Long job", kind: "chat", status: "running", startedAt,
    snapshot: { runId: "same-durable-job", conversationId: "recovery-chat", kind: "chat", status: "running", startedAt, content: "Server is still working." },
    result: null,
  };
  saveConversations([{ id: run.conversationId, title: run.title, modelId: "xai/grok-4.20", createdAt: startedAt, updatedAt: startedAt,
    messages: [{ id: "recovery-answer", role: "assistant", content: "Old local draft", createdAt: startedAt, pending: true }],
  }]);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === "/runs/active") return json({ runs: [run] });
    if (path === "/runs/stream") {
      let current: ReadableStreamDefaultController<Uint8Array>;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          current = controller;
          streams.add(controller);
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ t: "snapshot", seq: 1, snapshot: run.snapshot })}\n\n`));
        },
        cancel() { streams.delete(current); },
      }));
    }
    if (path === "/runs/ack") return json({ ok: true });
    if (path === "/runs/stop" || path === "/runs/start") throw new Error("Recovery must neither stop nor restart the job");
    return json({ data: [] });
  }));
});

afterEach(() => {
  finish(true);
  baseline.hydrated = true;
  vi.unstubAllGlobals();
});

test("reopened provider attaches a 20-minute job before history hydration; remount does not restart it", async () => {
  const first = await render(tree());
  await expect.element(page.getByTestId(TID.composerStop)).toBeVisible();
  await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Server is still working.");
  await first.unmount();
  const reopened = await render(tree());
  await expect.element(page.getByTestId(TID.composerStop)).toBeVisible();
  finish(true);
  await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Long job finished on the server.");
  await expect.element(page.getByTestId(TID.composerStop)).not.toBeInTheDocument();
  expect(requests.filter((path) => path === "/runs/stream").length).toBeGreaterThanOrEqual(2);
  expect(requests).not.toContain("/runs/start");
  expect(requests).not.toContain("/runs/stop");
  await reopened.unmount();
});

test("a missing terminal SSE updates the rendered result and running flag without refresh", async () => {
  const view = await render(tree());
  await expect.element(page.getByTestId(TID.composerStop)).toBeVisible();
  finish(false);
  await expect.poll(() => document.querySelector(`[data-testid="${TID.composerStop}"]`), { timeout: 25_000 }).toBeNull();
  await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Long job finished on the server.");
  await expect.element(page.getByTestId(TID.composerStop)).not.toBeInTheDocument();
  expect(requests).not.toContain("/runs/start");
  expect(requests).not.toContain("/runs/stop");
  await view.unmount();
}, 30_000);
