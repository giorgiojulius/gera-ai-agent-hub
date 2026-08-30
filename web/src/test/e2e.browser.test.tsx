/**
 * Real-click E2E suite: runs the shared scenario catalog (e2e/scenarios.ts)
 * against the real <App /> in headless Chromium.
 *
 * Cross-platform contract:
 * - targets come from the shared testid registry (src/lib/testids.ts) — the
 *   mobile app will attach the same constants as React Native `testID`s;
 * - scenarios, runner and report schema live in e2e/ and are platform-neutral;
 * - every run is persisted through the `saveE2eReport` browser command into
 *   e2e-results/, where `bun run e2e:stats` merges web + future ios/android
 *   runs into one stats table.
 *
 * The network is fully stubbed (auth gate, model catalog, tool router, the
 * server-run backend — /runs/start + the live SSE stream — title generation,
 * sync backend) — deterministic, hermetic, and no real credits are ever spent.
 */
import { commands as browserCommands, page } from "vitest/browser";
import { afterAll, beforeEach, expect, test } from "vitest";
import { render } from "vitest-browser-react";

import App from "@/App";
import { ACCESS_TOKEN_KEY } from "@/lib/auth-tokens";
import { FUNCTIONS_URL } from "@/lib/backend";
import { getToolkitUrl } from "@/lib/env";

import { buildRunReport, runScenario, type E2eDriver } from "../../e2e/runner";
import {
  E2E_SCENARIOS,
  STUB_HANG_PROMPT,
  STUB_REPLY_SNIPPET,
  SWITCH_TARGET_MODEL_ID,
  SWITCH_TARGET_MODEL_NAME,
} from "../../e2e/scenarios";
import type { E2eRunReport, E2eScenarioResult } from "../../e2e/types";

/**
 * Custom commands are registered dynamically in vitest.browser.config.ts —
 * type the bridge explicitly instead of relying on module augmentation.
 */
const commands = browserCommands as unknown as {
  /** Persists a run report to e2e-results/ on the Node side. */
  saveE2eReport: (report: E2eRunReport) => Promise<{ savedTo: string }>;
};

// ---------------------------------------------------------------- fixtures

const REPLY_TEXT = `${STUB_REPLY_SNIPPET} — deterministic stub for click tests.`;
const THREAD_TITLE = "Gera E2E Thread";
const ROUTER_PLAN = '{"builtins":[],"mcp":[],"queries":[]}';

type GatewayModelStub = {
  id: string;
  name: string;
  owned_by: string;
  type: "language";
  context_window: number;
};

/** Mirrors the curated chat catalog so every picker entry resolves. */
const GATEWAY_MODEL_STUBS: GatewayModelStub[] = [
  { id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", owned_by: "google" },
  { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", owned_by: "openai" },
  { id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra", owned_by: "openai" },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", owned_by: "openai" },
  { id: SWITCH_TARGET_MODEL_ID, name: SWITCH_TARGET_MODEL_NAME, owned_by: "anthropic" },
  { id: "spacexai/grok-4.6", name: "Grok 4.6", owned_by: "spacexai" },
  { id: "spacexai/grok-4.20-reasoning", name: "Grok 4.20 Reasoning", owned_by: "spacexai" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", owned_by: "deepseek" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", owned_by: "deepseek" },
  { id: "moonshotai/kimi-k3", name: "Kimi K3", owned_by: "moonshotai" },
  { id: "alibaba/qwen3.8-max", name: "Qwen3.8 Max", owned_by: "alibaba" },
  { id: "alibaba/qwen3.7-flash", name: "Qwen3.7 Flash", owned_by: "alibaba" },
  { id: "bytedance/seed-1.8", name: "Seed 1.8", owned_by: "bytedance" },
].map((entry) => ({ ...entry, type: "language" as const, context_window: 200_000 }));

function base64UrlEncode(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Client-side auth only decodes the payload — a fake signature is enough. */
function fakeAccessToken(): string {
  const header = base64UrlEncode({ alg: "none", typ: "JWT" });
  const payload = base64UrlEncode({
    sub: "e2e-user",
    email: "e2e@gera.app",
    name: "Gera E2E",
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  });
  return `${header}.${payload}.e2e`;
}

// ------------------------------------------------------------ network stub

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function completionJson(content: string): Response {
  return jsonResponse({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  });
}

/** OpenAI-compatible SSE stream: role, two content chunks, usage, [DONE]. */
function sseResponse(modelId: string): Response {
  const events: unknown[] = [
    { model: modelId, choices: [{ delta: { role: "assistant" } }] },
    { model: modelId, choices: [{ delta: { content: REPLY_TEXT.slice(0, 14) } }] },
    { model: modelId, choices: [{ delta: { content: REPLY_TEXT.slice(14) } }] },
    {
      model: modelId,
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 },
    },
  ];
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// Agent runs now execute on the backend — the stub emulates the run node:
// /runs/start registers the run, /runs/stream streams snapshot → text → done.
type StubRun = { runId: string; conversationId: string; assistantMessageId: string };
type StubRunBody = {
  runId?: string;
  conversationId?: string;
  assistantMessageId?: string;
  config?: {
    githubRepo?: string;
    mcpServers?: Array<{ id?: string; catalogId?: string; token?: string }>;
  };
};
let lastStubRun: StubRun | null = null;
let lastStubRunBody: StubRunBody | null = null;
/** Set by /runs/start when the prompt carries STUB_HANG_PROMPT — the stream then never terminates. */
let hangStubRun = false;

function runStreamResponse(): Response {
  const run = lastStubRun;
  const events: unknown[] = [
    {
      t: "snapshot",
      seq: 1,
      snapshot: {
        runId: run?.runId ?? "e2e-run",
        conversationId: run?.conversationId ?? "e2e-thread",
        kind: "chat",
        status: "running",
        startedAt: Date.now(),
        content: "",
      },
    },
    { t: "text", seq: 2, content: REPLY_TEXT.slice(0, 14) },
    { t: "text", seq: 3, content: REPLY_TEXT },
    {
      t: "done",
      seq: 4,
      status: "done",
      message: { id: run?.assistantMessageId ?? "e2e-assistant", content: REPLY_TEXT },
      usageEvents: [
        { modelId: "stub/model", usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 } },
      ],
      steered: [],
      chatUpdatedAt: Date.now(),
    },
  ];
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/**
 * A run stream that emits a snapshot plus one text delta and then never
 * terminates — the production shape behind "stop only works after a page
 * reload": the tab must settle from the /runs/stop response alone.
 */
function hangingRunStreamResponse(signal?: AbortSignal | null): Response {
  const run = lastStubRun;
  const encoder = new TextEncoder();
  const events: unknown[] = [
    {
      t: "snapshot",
      seq: 1,
      snapshot: {
        runId: run?.runId ?? "e2e-run",
        conversationId: run?.conversationId ?? "e2e-thread",
        kind: "chat",
        status: "running",
        startedAt: Date.now(),
        content: "",
      },
    },
    { t: "text", seq: 2, content: REPLY_TEXT.slice(0, 14) },
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      // Never closed on purpose; honor the abort so the detached turn unwinds
      // immediately, like a real fetch would.
      signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("Stopped.", "AbortError"));
        } catch {
          // already errored
        }
      });
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Returns a stubbed response for app backends, or null to hit the real network. */
function handleStubbed(url: string, init?: RequestInit): Response | null {
  const toolkit = getToolkitUrl();

  if (url.startsWith("https://api.github.com")) {
    const path = new URL(url).pathname;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghp_e2e_fixture");
    if (path === "/user") {
      return jsonResponse({ login: "e2e-octocat", name: "E2E GitHub" });
    }
    if (path === "/user/orgs") {
      return jsonResponse([{ login: "acme" }]);
    }
    if (path === "/user/repos") {
      return jsonResponse([
        {
          full_name: "acme/private-app",
          private: true,
          description: "Private fixture repository",
          pushed_at: "2026-08-30T10:00:00Z",
        },
      ]);
    }
    throw new Error(`Unstubbed GitHub request: ${url}`);
  }

  if (url.startsWith(FUNCTIONS_URL)) {
    if (url.includes("/access/status")) {
      return jsonResponse({ email: "e2e@gera.app", status: "invited", role: "member", requestedAt: null });
    }
    if (url.includes("/mcp-proxy")) {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toMatch(/^Bearer /);
      expect(headers.get("X-Gera-Upstream-Url")).toBe("https://mcp.deepwiki.com/mcp");
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(raw) as { id?: number; method?: string };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "DeepWiki", version: "e2e" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "e2e-mcp" } },
        );
      }
      if (body.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "ask_question",
                description: "Ask about a public repository",
                inputSchema: { type: "object", properties: { question: { type: "string" } } },
              },
            ],
          },
        });
      }
      throw new Error(`Unstubbed MCP method: ${body.method ?? "missing"}`);
    }
    if (url.includes("/runs/start")) {
      const raw = typeof init?.body === "string" ? init.body : "";
      let body: StubRunBody = {};
      try {
        body = JSON.parse(raw) as StubRunBody;
      } catch {
        body = {};
      }
      lastStubRunBody = body;
      lastStubRun = {
        runId: body.runId ?? "e2e-run",
        conversationId: body.conversationId ?? "e2e-thread",
        assistantMessageId: body.assistantMessageId ?? "e2e-assistant",
      };
      hangStubRun = raw.includes(STUB_HANG_PROMPT);
      return jsonResponse({ ok: true, runId: lastStubRun.runId, historyOnServer: true });
    }
    if (url.includes("/runs/stream")) {
      return hangStubRun ? hangingRunStreamResponse(init?.signal) : runStreamResponse();
    }
    if (url.includes("/runs/active")) {
      return jsonResponse({ runs: [] });
    }
    if (url.includes("/runs/stop")) {
      // Production regression shape: the run node lost the run — the client
      // must settle its UI from this response alone (no terminal event comes).
      return jsonResponse({ ok: false, reason: "not_running" });
    }
    if (url.includes("/runs/")) {
      return jsonResponse({ ok: true, accepted: true, removed: false });
    }
    if (url.endsWith("/projects")) {
      return jsonResponse({ projects: [] });
    }
    // chats/sync, arena/usage, diag — every worker route answers fail-soft shapes.
    return jsonResponse({ ok: true, pull: [], skipped: [] });
  }

  if (url.startsWith(toolkit)) {
    if (url.includes("/v1/models")) {
      return jsonResponse({ data: GATEWAY_MODEL_STUBS });
    }
    if (url.includes("/v1/chat/completions")) {
      const raw = typeof init?.body === "string" ? init.body : "";
      let payload: { model?: string; stream?: boolean } = {};
      try {
        payload = JSON.parse(raw) as { model?: string; stream?: boolean };
      } catch {
        payload = {};
      }
      if (payload.stream === true) {
        return sseResponse(payload.model ?? "stub/model");
      }
      // The tool router asks for a JSON plan; the title generator for a name.
      return raw.includes('"builtins"') ? completionJson(ROUTER_PLAN) : completionJson(THREAD_TITLE);
    }
    if (url.includes("/v2/exa/")) {
      return jsonResponse({ results: [] });
    }
    return jsonResponse({});
  }

  if (url.startsWith("https://ai-gateway.vercel.sh")) {
    return jsonResponse({ data: GATEWAY_MODEL_STUBS });
  }

  return null;
}

const realFetch = window.fetch.bind(window);
let stubInstalled = false;

function installNetworkStub(): void {
  if (stubInstalled) {
    return;
  }
  stubInstalled = true;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handleStubbed(url, init) ?? realFetch(input, init);
  }) as typeof window.fetch;
}

// ------------------------------------------------------------- web driver

/**
 * The web implementation of the five driver verbs — vitest browser locators
 * (CDP-driven real clicks) over the shared `data-testid` registry.
 */
function webDriver(): E2eDriver {
  let mounted = false;
  return {
    async goto(routePath: string) {
      if (!mounted) {
        // BrowserRouter reads the location at mount — set it first.
        window.history.replaceState({}, "", routePath);
        render(<App />);
        mounted = true;
        return;
      }
      // In-session deep link: BrowserRouter subscribes to popstate.
      window.history.pushState({}, "", routePath);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    },
    async tap(target: string) {
      await page.getByTestId(target).first().click();
    },
    async fill(target: string, text: string) {
      await page.getByTestId(target).first().fill(text);
    },
    async see(target: string, timeoutMs: number) {
      await expect.element(page.getByTestId(target).first(), { timeout: timeoutMs }).toBeVisible();
    },
    async seeText(target: string, text: string, timeoutMs: number) {
      // `.last()` — repeated rows (messages) assert against the newest one.
      await expect.element(page.getByTestId(target).last(), { timeout: timeoutMs }).toHaveTextContent(text);
    },
    async urlContains(text: string, timeoutMs: number) {
      await expect
        .poll(() => `${window.location.pathname}${window.location.search}`, { timeout: timeoutMs })
        .toContain(text);
    },
  };
}

// ------------------------------------------------------------------ suite

const startedAt = Date.now();
const results: E2eScenarioResult[] = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  lastStubRun = null;
  lastStubRunBody = null;
  localStorage.setItem(ACCESS_TOKEN_KEY, fakeAccessToken());
  installNetworkStub();
});

afterAll(async () => {
  const report = buildRunReport({ platform: "web", app: "gera-web", startedAt, results });
  await commands.saveE2eReport(report);
});

for (const scenario of E2E_SCENARIOS) {
  test(`e2e · ${scenario.title}`, { timeout: 90_000 }, async () => {
    if (scenario.id === "github-pin-and-send") {
      localStorage.setItem(
        "gera.settings.v1",
        JSON.stringify({
          mcpServers: [
            {
              id: "github",
              catalogId: "github",
              name: "GitHub",
              url: "",
              headersJson: "",
              token: "ghp_e2e_fixture",
              enabled: true,
              status: "connected",
              tools: [],
              disabledTools: [
                "create_issue",
                "add_issue_comment",
                "create_branch",
                "put_file",
                "delete_file",
                "create_pull",
                "update_pull",
              ],
              identity: "@e2e-octocat · repo access OK",
              verifiedAt: Date.now(),
            },
          ],
        }),
      );
    }
    const result = await runScenario(webDriver(), scenario);
    results.push(result);
    if (!result.ok) {
      expect.fail(`[${result.scenarioId}] ${result.error ?? "scenario did not finish"}`);
    }
    if (scenario.id === "github-pin-and-send") {
      expect(lastStubRunBody?.config?.githubRepo).toBe("acme/private-app");
      const github = lastStubRunBody?.config?.mcpServers?.find(
        (server) => (server.catalogId ?? server.id) === "github",
      );
      expect(github?.token).toBe("ghp_e2e_fixture");
    }
  });
}
