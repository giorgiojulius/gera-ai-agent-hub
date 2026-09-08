import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AgentProvider, useAgent } from "@/hooks/use-agent";
import { MessageList } from "@/components/gera/MessageList";
import { ACCESS_TOKEN_KEY } from "@/lib/auth-tokens";
import { flushConversations, saveConversations } from "@/lib/history";
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
let activeGate: Promise<void> | undefined;
let activeFailures = 0;
let hideRun = false;
const activeTimes: number[] = [];

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
  activeGate = undefined;
  activeFailures = 0;
  hideRun = false;
  activeTimes.length = 0;
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
  flushConversations();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === "/runs/active") {
      activeTimes.push(Date.now());
      await activeGate;
      if (activeFailures > 0) {
        activeFailures -= 1;
        return new Response("Temporarily unavailable", { status: 503 });
      }
      return json({ runs: hideRun ? [] : [run] });
    }
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

test("an old pending draft does not claim a reload killed a still-running server job", async () => {
  let release: () => void = () => {};
  activeGate = new Promise<void>((resolve) => { release = resolve; });
  const view = await render(tree());
  try {
    await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Checking saved run status");
    await expect.element(page.getByTestId(TID.messageRecoveryAction)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Cut off by a page reload");
    release();
    await expect.element(page.getByTestId(TID.composerStop)).toBeVisible();
    await expect.element(page.getByTestId(TID.messageRecoveryNotice)).not.toBeInTheDocument();
    finish(true);
    await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Long job finished on the server.");
    expect(requests).not.toContain("/runs/start");
    expect(requests).not.toContain("/runs/stop");
  } finally {
    release();
    await view.unmount();
  }
});

test("a finished job waiting for history hydration is not labelled incomplete or offered Retry", async () => {
  finish(false);
  const view = await render(tree());
  try {
    await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Checking saved run status");
    await expect.element(page.getByTestId(TID.messageRecoveryAction)).not.toBeInTheDocument();
    baseline.hydrated = true;
    await view.rerender(tree());
    await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Long job finished on the server.");
    await expect.element(page.getByTestId(TID.messageRecoveryNotice)).not.toBeInTheDocument();
    expect(requests).not.toContain("/runs/start");
    expect(requests).not.toContain("/runs/stop");
  } finally {
    await view.unmount();
  }
});

test("status retries back off after repeated failures and recover the same finished job", async () => {
  baseline.hydrated = true;
  activeFailures = 2;
  finish(false);
  const view = await render(tree());
  try {
    await expect.element(page.getByTestId(TID.messageRecoveryNotice)).toHaveTextContent("Retrying status in 2s");
    await expect.element(page.getByTestId(TID.messageRecoveryAction)).not.toBeInTheDocument();
    await expect.element(page.getByTestId(TID.messageRecoveryNotice)).toHaveTextContent("Retrying status in 4s");
    await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Long job finished on the server.");
    expect(activeTimes).toHaveLength(3);
    expect(activeTimes[1] - activeTimes[0]).toBeGreaterThanOrEqual(1_900);
    expect(activeTimes[2] - activeTimes[1]).toBeGreaterThanOrEqual(3_900);
    expect(requests).not.toContain("/runs/start");
    expect(requests).not.toContain("/runs/stop");
  } finally {
    await view.unmount();
  }
}, 15_000);

test("Check now bypasses backoff without leaving a second timer or replaying the prompt", async () => {
  baseline.hydrated = true;
  activeFailures = 1;
  finish(false);
  const view = await render(tree());
  try {
    await expect.element(page.getByTestId(TID.messageRecoveryCheck)).toBeVisible();
    await page.getByTestId(TID.messageRecoveryCheck).click();
    await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Long job finished on the server.");
    await new Promise<void>((resolve) => setTimeout(resolve, 2_200));
    expect(activeTimes).toHaveLength(2);
    expect(requests).not.toContain("/runs/start");
    expect(requests).not.toContain("/runs/stop");
  } finally {
    await view.unmount();
  }
});

test("an unresolved saved reply can recheck a later available result without regenerating it", async () => {
  baseline.hydrated = true;
  hideRun = true;
  const view = await render(tree());
  try {
    await expect.element(page.getByTestId(TID.messageRecoveryNotice)).toHaveTextContent("Completion wasn't confirmed");
    finish(false);
    hideRun = false;
    await page.getByTestId(TID.messageRecoveryCheck).click();
    await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Long job finished on the server.");
    await expect.element(page.getByTestId(TID.messageRecoveryNotice)).not.toBeInTheDocument();
    expect(requests).not.toContain("/runs/start");
    expect(requests).not.toContain("/runs/stop");
  } finally {
    await view.unmount();
  }
});

test("unmount cancels a scheduled status retry", async () => {
  activeFailures = 2;
  const view = await render(tree());
  await expect.element(page.getByTestId(TID.messageRecoveryNotice)).toHaveTextContent("Retrying status in 2s");
  await view.unmount();
  await new Promise<void>((resolve) => setTimeout(resolve, 2_200));
  expect(activeTimes).toHaveLength(1);
});

test("a server interruption stays visible without inventing a page-reload cause", async () => {
  baseline.hydrated = true;
  finish(false);
  run = { ...run, status: "interrupted", result: {
    ...run.result!, status: "interrupted",
    message: { id: "recovery-answer", content: "Saved server draft.", interrupted: true },
  } };
  const view = await render(tree());
  try {
    await expect.element(page.getByTestId(TID.messageAssistant)).toHaveTextContent("Completion wasn't confirmed. This saved reply may be incomplete.");
    await expect.element(page.getByTestId(TID.messageRecoveryAction)).toHaveTextContent("Continue");
    expect(document.body.textContent).not.toContain("page reload");
    expect(requests).not.toContain("/runs/start");
    expect(requests).not.toContain("/runs/stop");
  } finally {
    await view.unmount();
  }
});
