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
import { TID } from "@/lib/testids";
import { FUNCTIONS_URL } from "@/lib/backend";
import { getToolkitUrl } from "@/lib/env";

import { buildRunReport, runScenario, type E2eDriver } from "../../e2e/runner";
import {
  E2E_SCENARIOS,
  STUB_CODE_PROMPT,
  STUB_CONFIRM_PROMPT,
  STUB_CONFIRM_TOOL,
  STUB_ELICIT_FIELD,
  STUB_ELICIT_PROMPT,
  STUB_HANG_PROMPT,
  STUB_MCP_PROMPT,
  STUB_MCP_PROMPT_ARG,
  STUB_MCP_PROMPT_NAME,
  STUB_MCP_PROMPT_TEXT,
  STUB_MCP_RESOURCE_URI,
  STUB_MCP_SERVER_ID,
  STUB_REPLY_SNIPPET,
  STUB_STEP_UP_SCOPE,
  STUB_STEP_UP_SERVER_ID,
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
  { id: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1", owned_by: "anthropic" },
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
    prompt?: string;
    githubRepo?: string;
    mcpServers?: Array<{ id?: string; catalogId?: string; token?: string }>;
    mcpToolLoading?: string;
    confirmWriteTools?: boolean;
    contextWindow?: number;
  };
};
let lastStubRun: StubRun | null = null;
let lastStubRunBody: StubRunBody | null = null;
/** Set by /runs/start when the prompt carries STUB_HANG_PROMPT — the stream then never terminates. */
let hangStubRun = false;
let codeStubRun = false;
/** Set by /runs/start for STUB_MCP_PROMPT — the stream shows a deferred MCP search + call before the reply. */
let mcpStubRun = false;
/** Set by /runs/start for STUB_ELICIT_PROMPT — the stream pauses on an elicitation card until /runs/answer lands. */
let elicitStubRun = false;
/** Set by /runs/start for STUB_CONFIRM_PROMPT — the stream pauses on a write-tool confirmation card until /runs/answer lands. */
let confirmStubRun = false;
/** The answer body /runs/answer received (never contains anything but the fixture values). */
let lastStubAnswer: unknown = null;
let resolveStubAnswer: (() => void) | null = null;

/** Tool records a deferred-mode run streams: the meta calls the server executed. */
const MCP_STUB_TOOL_CALLS = [
  {
    id: "mcp-search",
    name: "mcp_search_tools",
    arguments: JSON.stringify({ query: "ask a question about a repository" }),
    status: "done",
    result: '{"matches":[{"serverId":"deepwiki","toolName":"ask_question"}]}',
  },
  {
    id: "mcp-call",
    name: "mcp_call_tool",
    arguments: JSON.stringify({
      serverId: "deepwiki",
      toolName: "ask_question",
      arguments: { repoName: "acme/private-app", question: "What does it do?" },
    }),
    status: "done",
    result: "A fixture repository that renders a greeting.",
  },
] as const;

const PREVIEW_STUB_ID = `${"a".repeat(24)}.${"b".repeat(32)}.${"c".repeat(24)}`;

function previewStubJob(phase: "queued" | "ready") {
  const now = Date.now();
  return {
    id: PREVIEW_STUB_ID,
    repository: "acme/private-app",
    ref: "main",
    commitSha: "c".repeat(40),
    rootDirectory: ".",
    framework: "vite",
    packageManager: "bun",
    phase,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 24 * 60 * 60_000,
    actionsUrl: "https://github.com/acme/private-app/actions/runs/42",
    ...(phase === "ready"
      ? {
          previewUrl: `https://gera-ai-agent-hub-backend.rork.app/repo-preview/${PREVIEW_STUB_ID}/`,
          logs: "Installed dependencies\nBuilt in 1.2s\nPackaged 14 files",
        }
      : {}),
  };
}

function runStreamResponse(): Response {
  const run = lastStubRun;
  const html = "<!doctype html><html><body><h1>Hello from preview</h1></body></html>";
  const codeChanges = {
    status: "done",
    startedAt: Date.now(),
    repository: "acme/private-app",
    branch: "gera/live-preview",
    files: [
      {
        id: "code-write",
        path: "index.html",
        action: "create",
        status: "done",
        language: "html",
        additions: 1,
        deletions: 0,
        patch: `+${html}`,
      },
    ],
    preview: { kind: "html", label: "index.html", html },
    validation: { status: "passed", label: "Checks passed" },
  } as const;
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
    ...(codeStubRun
      ? [
          {
            t: "code",
            seq: 2,
            codeChanges: {
              ...codeChanges,
              status: "running",
              files: codeChanges.files.map((file) => ({ ...file, status: "running" })),
              preview: undefined,
            },
          },
          { t: "code", seq: 3, codeChanges },
        ]
      : []),
    ...(mcpStubRun
      ? [
          { t: "tools", seq: 2, toolCalls: [{ ...MCP_STUB_TOOL_CALLS[0], status: "running", result: undefined }] },
          { t: "tools", seq: 3, toolCalls: [...MCP_STUB_TOOL_CALLS] },
        ]
      : []),
    { t: "text", seq: codeStubRun || mcpStubRun ? 4 : 2, content: REPLY_TEXT.slice(0, 14) },
    { t: "text", seq: codeStubRun || mcpStubRun ? 5 : 3, content: REPLY_TEXT },
    {
      t: "done",
      seq: codeStubRun || mcpStubRun ? 6 : 4,
      status: "done",
      message: {
        id: run?.assistantMessageId ?? "e2e-assistant",
        content: REPLY_TEXT,
        ...(codeStubRun ? { codeChanges } : {}),
        ...(mcpStubRun ? { toolCalls: [...MCP_STUB_TOOL_CALLS] } : {}),
      },
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
 * A run stream that pauses on an MCP elicitation: snapshot → running
 * mcp_call_tool row → `pause` event with one open question, then nothing
 * until /runs/answer arrives — exactly what the run node emits while the tool
 * call waits for the user. After the answer the card clears, the tool settles,
 * and the reply streams.
 */
function elicitationRunStreamResponse(): Response {
  const run = lastStubRun;
  const encoder = new TextEncoder();
  const now = Date.now();
  const pending = [
    {
      id: "pause-1",
      kind: "elicitation",
      serverId: "deploybot",
      serverName: "DeployBot",
      message: "Which region should this deploy to?",
      fields: [{ name: STUB_ELICIT_FIELD, type: "string", title: "Region", required: true }],
      createdAt: now,
      expiresAt: now + 5 * 60_000,
    },
  ];
  const call = {
    id: "mcp-deploy",
    name: "mcp_call_tool",
    arguments: JSON.stringify({ serverId: "deploybot", toolName: "deploy", arguments: {} }),
  };
  const snapshot = {
    runId: run?.runId ?? "e2e-run",
    conversationId: run?.conversationId ?? "e2e-thread",
    kind: "chat",
    status: "running",
    startedAt: now,
    content: "",
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      push({ t: "snapshot", seq: 1, snapshot });
      push({ t: "tools", seq: 2, toolCalls: [{ ...call, status: "running" }] });
      push({ t: "pause", seq: 3, pending });
      await new Promise<void>((resolve) => {
        resolveStubAnswer = resolve;
      });
      const done = [{ ...call, status: "done", result: '{"action":"accept","content":{"region":"eu"}}' }];
      push({ t: "pause", seq: 4, pending: [] });
      push({ t: "tools", seq: 5, toolCalls: done });
      push({ t: "text", seq: 6, content: REPLY_TEXT });
      push({
        t: "done",
        seq: 7,
        status: "done",
        message: { id: run?.assistantMessageId ?? "e2e-assistant", content: REPLY_TEXT, toolCalls: done },
        usageEvents: [{ modelId: "stub/model", usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 } }],
        steered: [],
        chatUpdatedAt: Date.now(),
      });
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/**
 * A run stream that pauses on a write-tool confirmation: snapshot → running
 * inline tool row → `pause` event with one confirmation request (tool, risk,
 * redacted argument preview) until /runs/answer arrives — what the run node
 * emits while the policy gate waits for the user. After the answer the card
 * clears, the tool settles, and the reply streams.
 */
function confirmationRunStreamResponse(): Response {
  const run = lastStubRun;
  const encoder = new TextEncoder();
  const now = Date.now();
  const pending = [
    {
      id: "pause-1",
      kind: "confirmation",
      serverId: "tracker",
      serverName: "Tracker",
      message: "Creates an issue in the tracker project.",
      fields: [],
      createdAt: now,
      expiresAt: now + 10 * 60_000,
      confirm: {
        toolName: STUB_CONFIRM_TOOL,
        risk: "write",
        argumentsPreview: '{\n "title": "Release 1.2",\n "apiKey": "•••"\n}',
      },
    },
  ];
  const call = {
    id: "mcp-create-issue",
    name: `mcp_tracker_${STUB_CONFIRM_TOOL}`,
    arguments: JSON.stringify({ title: "Release 1.2" }),
  };
  const snapshot = {
    runId: run?.runId ?? "e2e-run",
    conversationId: run?.conversationId ?? "e2e-thread",
    kind: "chat",
    status: "running",
    startedAt: now,
    content: "",
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      push({ t: "snapshot", seq: 1, snapshot });
      push({ t: "tools", seq: 2, toolCalls: [{ ...call, status: "running" }] });
      push({ t: "pause", seq: 3, pending });
      await new Promise<void>((resolve) => {
        resolveStubAnswer = resolve;
      });
      const done = [{ ...call, status: "done", result: "Issue #42 created." }];
      push({ t: "pause", seq: 4, pending: [] });
      push({ t: "tools", seq: 5, toolCalls: done });
      push({ t: "text", seq: 6, content: REPLY_TEXT });
      push({
        t: "done",
        seq: 7,
        status: "done",
        message: { id: run?.assistantMessageId ?? "e2e-assistant", content: REPLY_TEXT, toolCalls: done },
        usageEvents: [{ modelId: "stub/model", usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 } }],
        steered: [],
        chatUpdatedAt: Date.now(),
      });
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
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
    if (url.includes("/mcp/check")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { server?: { id?: string; token?: string } };
      if (body.server?.id === "github") {
        return jsonResponse({
          tools: [{ name: "get_contents", inputSchema: { type: "object", properties: {} } }],
          identity: "GitHub · server verified",
        });
      }
      if (body.server?.id === STUB_STEP_UP_SERVER_ID) {
        // The grant still handshakes, but a run's tools/call was refused with
        // insufficient_scope — the shard reports the pending step-up.
        return jsonResponse({
          tools: [{ name: "write_thing", description: "Writes a thing", inputSchema: { type: "object", properties: {} } }],
          identity: "Scoped Things · server verified",
          credentialStored: true,
          stepUp: { scopes: [STUB_STEP_UP_SCOPE], code: "insufficient_scope" },
        });
      }
      return jsonResponse({
        tools: [{
          name: "ask_question",
          description: "Ask about a public repository",
          inputSchema: { type: "object", properties: { question: { type: "string" } } },
          annotations: { readOnlyHint: true },
        }],
        identity: "DeepWiki · server verified",
        promptCount: 1,
        resourceCount: 1,
      });
    }
    // Composer menus: prompts / resources of one connected server, then a
    // prompt rendered with its arguments and a resource body — all shard-side.
    if (url.includes("/mcp/inventory")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { serverId?: string };
      expect(body.serverId).toBe(STUB_MCP_SERVER_ID);
      return jsonResponse({
        prompts: [
          {
            name: STUB_MCP_PROMPT_NAME,
            title: "Explain repository",
            description: "Plain-words explanation of a repository",
            arguments: [{ name: STUB_MCP_PROMPT_ARG, description: "owner/repo", required: true }],
          },
        ],
        resources: [{ uri: STUB_MCP_RESOURCE_URI, name: "README", mimeType: "text/markdown" }],
        resourceTemplates: [],
        toolCount: 1,
        cached: true,
      });
    }
    if (url.includes("/mcp/prompt-get")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { serverId?: string; name?: string; arguments?: Record<string, string> };
      expect(body.name).toBe(STUB_MCP_PROMPT_NAME);
      expect(body.arguments?.[STUB_MCP_PROMPT_ARG]).toBe("acme/private-app");
      return jsonResponse({
        description: "Explain repository",
        messages: [{ role: "user", text: `${STUB_MCP_PROMPT_TEXT}.` }],
      });
    }
    if (url.includes("/mcp/resource-read")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { serverId?: string; uri?: string };
      expect(body.uri).toBe(STUB_MCP_RESOURCE_URI);
      return jsonResponse({
        contents: [{ uri: STUB_MCP_RESOURCE_URI, mimeType: "text/markdown", text: "# acme/private-app\n\nFixture README body." }],
      });
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
    if (url.includes("/repo-previews/inspect")) {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Gera-Upstream-Authorization")).toBe("Bearer ghp_e2e_fixture");
      return jsonResponse({
        inspection: {
          repository: "acme/private-app",
          defaultBranch: "main",
          ref: "main",
          commitSha: "c".repeat(40),
          rootDirectory: ".",
          rootSuggestions: ["."],
          runner: "ready",
          runnerVersion: 1,
          framework: "vite",
          packageManager: "bun",
          projectFound: true,
        },
      });
    }
    if (url.includes("/repo-previews/start")) {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Gera-Upstream-Authorization")).toBe("Bearer ghp_e2e_fixture");
      return jsonResponse({ job: previewStubJob("queued") });
    }
    if (url.includes("/repo-previews/status")) {
      return jsonResponse({ job: previewStubJob("ready") });
    }
    if (url.includes("/repo-previews/cancel")) {
      return jsonResponse({ job: { ...previewStubJob("queued"), phase: "cancelled" } });
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
      codeStubRun = body.config?.prompt === STUB_CODE_PROMPT;
      mcpStubRun = body.config?.prompt === STUB_MCP_PROMPT;
      elicitStubRun = body.config?.prompt === STUB_ELICIT_PROMPT;
      confirmStubRun = body.config?.prompt === STUB_CONFIRM_PROMPT;
      return jsonResponse({ ok: true, runId: lastStubRun.runId, historyOnServer: true });
    }
    if (url.includes("/runs/stream")) {
      if (elicitStubRun) {
        return elicitationRunStreamResponse();
      }
      if (confirmStubRun) {
        return confirmationRunStreamResponse();
      }
      return hangStubRun ? hangingRunStreamResponse(init?.signal) : runStreamResponse();
    }
    if (url.includes("/runs/answer")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { requestId?: string; answer?: unknown };
      expect(body.requestId).toBe("pause-1");
      lastStubAnswer = body.answer ?? null;
      resolveStubAnswer?.();
      resolveStubAnswer = null;
      return jsonResponse({ ok: true });
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
 * The web implementation of the driver verbs — vitest browser locators
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
    async notSee(target: string, timeoutMs: number) {
      // Gone means unmounted or visually hidden — aria-hidden fade-out shells
      // count, so scenarios can assert on animated dismissals.
      await expect
        .poll(
          () =>
            [...document.querySelectorAll(`[data-testid="${target}"]`)].every((node) => {
              const element = node as HTMLElement;
              if (element.getAttribute("aria-hidden") === "true" || element.hidden) {
                return true;
              }
              const style = window.getComputedStyle(element);
              return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
            }),
          { timeout: timeoutMs },
        )
        .toBe(true);
    },
    async seeText(target: string, text: string, timeoutMs: number) {
      // `.last()` — repeated rows (messages) assert against the newest one.
      await expect.element(page.getByTestId(target).last(), { timeout: timeoutMs }).toHaveTextContent(text);
    },
    async seeValue(target: string, text: string, timeoutMs: number) {
      await expect
        .poll(
          () => (document.querySelector(`[data-testid="${target}"]`) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "",
          { timeout: timeoutMs },
        )
        .toContain(text);
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
  hangStubRun = false;
  codeStubRun = false;
  mcpStubRun = false;
  elicitStubRun = false;
  confirmStubRun = false;
  lastStubAnswer = null;
  resolveStubAnswer = null;
  localStorage.setItem(ACCESS_TOKEN_KEY, fakeAccessToken());
  installNetworkStub();
});

afterAll(async () => {
  const report = buildRunReport({ platform: "web", app: "gera-web", startedAt, results });
  await commands.saveE2eReport(report);
});

// Web-only gesture: real DataTransfer drag-and-drop cannot be expressed in the
// platform-neutral scenario DSL, so it lives here as a bespoke Chromium test.
test("e2e · Dropping a file onto the composer attaches it", { timeout: 90_000 }, async () => {
  const driver = webDriver();
  await driver.goto("/");
  await driver.see(TID.composerInput, 20_000);

  const input = document.querySelector(`[data-testid="${TID.composerInput}"]`);
  if (!input) {
    throw new Error("composer input not mounted");
  }
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(["drag and attach"], "notes.txt", { type: "text/plain" }));

  input.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
  await expect.element(page.getByTestId(TID.composerDropZone).first(), { timeout: 5_000 }).toBeVisible();

  input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  await expect
    .element(page.getByTestId(TID.composerAttachment).first(), { timeout: 10_000 })
    .toHaveTextContent("notes.txt");
  expect(document.querySelector(`[data-testid="${TID.composerDropZone}"]`)).toBeNull();
});

for (const scenario of E2E_SCENARIOS) {
  test(`e2e · ${scenario.title}`, { timeout: 90_000 }, async () => {
    if (scenario.id === "github-pin-and-send" || scenario.id === "github-launch-web-preview") {
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
    if (scenario.id === "prompt-slash" || scenario.id === "resource-mention") {
      // A verified generic MCP server whose prompts/resources the menus can offer.
      localStorage.setItem(
        "gera.settings.v1",
        JSON.stringify({
          mcpServers: [
            {
              id: STUB_MCP_SERVER_ID,
              catalogId: STUB_MCP_SERVER_ID,
              name: "DeepWiki",
              url: "https://mcp.deepwiki.com/mcp",
              headersJson: "",
              enabled: true,
              status: "connected",
              tools: [{ name: "ask_question", description: "Ask about a public repository" }],
              disabledTools: [],
              identity: "DeepWiki · server verified",
              verifiedAt: Date.now(),
              promptCount: 1,
              resourceCount: 1,
            },
          ],
        }),
      );
    }
    if (scenario.id === "oauth-step-up") {
      // A custom OAuth server signed in earlier; the shard now reports a step-up.
      localStorage.setItem(
        "gera.settings.v1",
        JSON.stringify({
          mcpServers: [
            {
              id: STUB_STEP_UP_SERVER_ID,
              name: "Scoped Things",
              url: "https://mcp.scoped-provider.dev/mcp",
              headersJson: "",
              authMode: "oauth",
              enabled: true,
              status: "connected",
              credentialStored: true,
              tools: [{ name: "write_thing", description: "Writes a thing" }],
              disabledTools: [],
              identity: "Scoped Things · server verified",
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
    if (scenario.id === "elicitation-accept") {
      // The card's Accept sent exactly the validated form values through /runs/answer.
      expect(lastStubAnswer).toEqual({ action: "accept", content: { [STUB_ELICIT_FIELD]: "eu" } });
    }
    if (scenario.id === "mcp-confirm-card") {
      // "Run once" answers accept without content; the Settings switch rode into the run config.
      expect(lastStubAnswer).toEqual({ action: "accept" });
      expect(lastStubRunBody?.config?.confirmWriteTools).toBe(true);
    }
    if (scenario.id === "connect-open-mcp-deferred") {
      // The Settings switch rides into the run config as a snapshot, and the
      // model's context window from the stubbed gateway catalog comes along.
      expect(lastStubRunBody?.config?.mcpToolLoading).toBe("deferred");
      expect(lastStubRunBody?.config?.contextWindow).toBe(200_000);
    }
    if (scenario.id === "github-pin-and-send") {
      expect(lastStubRunBody?.config?.githubRepo).toBe("acme/private-app");
      const github = lastStubRunBody?.config?.mcpServers?.find(
        (server) => (server.catalogId ?? server.id) === "github",
      );
      expect(github?.token).toBeUndefined();
    }
    if (scenario.id === "github-launch-web-preview") {
      const readPersisted = (): Record<string, unknown> | undefined => {
        const conversations = JSON.parse(localStorage.getItem("gera.conversations.v1") ?? "[]") as Array<{
          messages?: Array<{ repoPreview?: Record<string, unknown> }>;
        }>;
        return conversations.flatMap((conversation) => conversation.messages ?? [])
          .find((message) => message.repoPreview)?.repoPreview;
      };
      await expect.poll(() => readPersisted()?.phase, { timeout: 5_000 }).toBe("ready");
      const persisted = readPersisted();
      expect(persisted?.previewUrl).toBeUndefined();
      expect(persisted?.actionsUrl).toBeUndefined();
      expect(persisted?.logs).toBeUndefined();
    }
  });
}
