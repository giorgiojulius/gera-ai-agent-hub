// Cloud automation runner — the LLM agent loop for scheduled cloud runs:
// gateway chat completions + web_search / fetch_url via the toolkit +
// SelfSurf autonomous browsing. Invoked by each account's ChatStore shard
// from its Durable Object alarm — the exact-time trigger path — which claims
// the run first and appends the result to the automation's chat thread.
// Full MCP scope: pasted keys, custom headers, open servers, synced browser
// sign-ins (refreshed server-side when they expire), and the native
// GitHub/Slack/Intercom connectors via their server-side REST ports
// (native-*.ts). Still no deep research and no media generation here.
//
// Server-side toolkit calls MUST send `Authorization: Bearer <key>` — only
// browser builds get delegated auth injected by the Rork runtime.

import {
  formatSurfPage,
  mergeFormFields,
  performSurf,
  resolveFollowTarget,
  type SurfJar,
  type SurfPage,
} from "./selfsurf";
import {
  callCloudMcpTool,
  cloudMcpFunctionName,
  connectCloudMcp,
  ensureFreshCloudOAuth,
  forceRefreshCloudOAuth,
  type CloudMcpServer,
  type CloudMcpSession,
  type RefreshedOAuth,
} from "./mcp-cloud";
import { callGitHubNativeTool, GITHUB_NATIVE_TOOLS } from "./native-github";
import { callIntercomNativeTool, INTERCOM_NATIVE_TOOLS } from "./native-intercom";
import { callSlackNativeTool, SLACK_NATIVE_TOOLS } from "./native-slack";

/** Everything one cloud run needs, assembled by the shard from the profile. */
export type ClaimJob = {
  owner: string;
  automationId: string;
  conversationId: string;
  name: string;
  prompt: string;
  modelId: string;
  systemPrompt: string;
  agentId: string | null;
  memories: string[];
  knowledge: string;
  prior: Array<{ role: "user" | "assistant"; content: string }>;
  /** MCP servers eligible for this run — auth already resolved server-side. */
  mcpServers: CloudMcpServer[];
};

export type ToolRecord = { name: string; arguments: string; result: string };

export type SourceRef = { url: string; title: string };

export type AutomationRunResult = {
  content: string;
  toolCalls: ToolRecord[];
  sources: SourceRef[];
  /** OAuth grants rotated during this run — the account shard persists them. */
  refreshedOAuth: RefreshedOAuth[];
};

type GatewayMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: GatewayToolCall[];
  tool_call_id?: string;
};

type GatewayToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** Assigns stable citation numbers to sources as tools touch them. */
type SourceLedger = {
  assign(url: string, title?: string): number;
  list(): SourceRef[];
};

function createSourceLedger(): SourceLedger {
  const order: SourceRef[] = [];
  const byUrl = new Map<string, number>();
  return {
    assign(url: string, title?: string): number {
      const clean = url.trim();
      const existing = byUrl.get(clean);
      if (existing !== undefined) {
        const entry = order[existing - 1];
        if (title && (!entry.title || entry.title === clean)) {
          entry.title = title;
        }
        return existing;
      }
      const number = order.length + 1;
      byUrl.set(clean, number);
      order.push({ url: clean, title: title?.trim() ? title : clean });
      return number;
    },
    list(): SourceRef[] {
      return order.map((item) => ({ ...item }));
    },
  };
}

const TOOLKIT_URL = "https://toolkit.rork.com";
/** Mirrors the web client's gateway fallback chain. */
const CHAT_FALLBACKS = ["openai/gpt-5.6-terra", "google/gemini-3.7-flash"];
const MAX_STEPS = 10;
const LIVE_RESULT_CHARS = 12_000;
const LLM_TIMEOUT_MS = 100_000;

const RECENCY_WINDOW_MS: Record<string, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/** OpenAI-shaped function definition sent to the gateway. */
export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const TOOLS: ToolDef[] = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description:
        "Search the live web (Exa neural index). Use for current events, facts, docs, and anything that needs citations. Each result carries a citation number like [3] — cite claims with those markers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          numResults: { type: "number", description: "Number of results, 3-8" },
          recency: {
            type: "string",
            enum: ["day", "week", "month", "year"],
            description: "Only results published within this window — use for news and anything time-sensitive",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fetch_url",
      description:
        "Read the full text of web pages. Each page also lists the links found on it — call fetch_url again on those links to browse deeper, hop by hop (read-only: no logins, no forms).",
      parameters: {
        type: "object",
        properties: {
          urls: { type: "array", items: { type: "string" }, description: "HTTP URLs to fetch" },
        },
        required: ["urls"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "surf_open",
      description:
        "SelfSurf: open a page in the autonomous text browser. Keeps cookies for this run, follows redirects, returns page text plus numbered links (L1…) and forms (F1…). No JavaScript execution.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Page URL to open" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "surf_follow",
      description: 'SelfSurf: follow a link from the current page — pass the L-number like "L3", or an absolute URL.',
      parameters: {
        type: "object",
        properties: {
          link: { type: "string", description: 'Link reference: "L3" or a URL' },
        },
        required: ["link"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "surf_submit",
      description:
        'SelfSurf: fill and submit a form from the current page. Pass the F-number and only the fields to set, e.g. {"form":"F1","fields":{"q":"laptops"}}. Hidden fields carry over automatically. No file uploads, no CAPTCHAs.',
      parameters: {
        type: "object",
        properties: {
          form: { type: "string", description: 'Form reference like "F1"' },
          fields: { type: "object", description: "Field name → value to fill in" },
        },
        required: ["form", "fields"],
      },
    },
  },
];

/** Per-run SelfSurf session: cookie jar + visited pages (current = last). */
type SurfState = { jar: SurfJar; pages: SurfPage[] };

/** Dispatch route for one namespaced MCP or native-connector tool. */
export type McpRoute =
  | { type: "mcp"; session: CloudMcpSession; toolName: string; serverName: string }
  | {
      type: "native";
      kind: "github" | "slack" | "intercom";
      /** Ready credential: full Authorization header for GitHub, raw token otherwise. */
      auth: string;
      toolName: string;
      serverName: string;
    };

export type McpRuntime = {
  toolDefs: ToolDef[];
  routes: Map<string, McpRoute>;
  failures: ToolRecord[];
  summary: string[];
  refreshed: RefreshedOAuth[];
};

const MAX_MCP_TOOLS = 90;

export function emptyMcpRuntime(): McpRuntime {
  return { toolDefs: [], routes: new Map(), failures: [], summary: [], refreshed: [] };
}

const NATIVE_TOOL_TABLES = {
  github: GITHUB_NATIVE_TOOLS,
  slack: SLACK_NATIVE_TOOLS,
  intercom: INTERCOM_NATIVE_TOOLS,
} as const;

/** Arms one native connector from its static tool table — no handshake needed. */
function armNativeServer(runtime: McpRuntime, server: CloudMcpServer): void {
  if (server.kind === "mcp") {
    return;
  }
  const credential = server.token ?? server.oauth?.accessToken ?? "";
  if (!credential) {
    return;
  }
  const auth =
    server.kind === "github"
      ? credential.toLowerCase().startsWith("bearer ")
        ? credential
        : `Bearer ${credential}`
      : credential;
  let added = 0;
  for (const tool of NATIVE_TOOL_TABLES[server.kind]) {
    if (runtime.routes.size >= MAX_MCP_TOOLS) {
      break;
    }
    if (server.disabledTools.includes(tool.name)) {
      continue;
    }
    const fnName = cloudMcpFunctionName(server.id, tool.name);
    if (runtime.routes.has(fnName)) {
      continue;
    }
    runtime.routes.set(fnName, {
      type: "native",
      kind: server.kind,
      auth,
      toolName: tool.name,
      serverName: server.name,
    });
    runtime.toolDefs.push({
      type: "function",
      function: {
        name: fnName,
        description: `[${server.name}] ${tool.description ?? tool.name}`.slice(0, 1_000),
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      },
    });
    added += 1;
  }
  runtime.summary.push(`${server.name} (${added} tools)`);
}

/**
 * Arms every eligible server: expiring synced sign-ins refresh first, native
 * connectors expose their static tool tables, and MCP servers connect in
 * parallel. Failures never kill the run — they surface as honest tool
 * records in the thread.
 */
export async function armCloudMcp(servers: CloudMcpServer[]): Promise<McpRuntime> {
  const runtime = emptyMcpRuntime();
  for (const server of servers) {
    if (server.oauth) {
      try {
        await ensureFreshCloudOAuth(server, runtime.refreshed);
      } catch {
        // keep the synced token — a real auth failure surfaces honestly below
      }
    }
  }
  for (const server of servers) {
    armNativeServer(runtime, server);
  }
  const attempts = await Promise.all(
    servers
      .filter((server) => server.kind === "mcp")
      .map(async (server) => {
        try {
          return { server, connection: await connectCloudMcp(server) };
        } catch (error) {
          const message = error instanceof Error ? error.message : "connect failed";
          // Auth rejected with a refresh token in hand: the recorded expiry
          // may be missing or wrong (no expires_in, revoked early). Redeem
          // the refresh token once and retry — mirrors the browser's 401
          // replay, so a sleeping sign-in repairs instead of failing.
          if (message.includes("auth rejected") && server.oauth?.refreshToken) {
            const repaired = await forceRefreshCloudOAuth(server, runtime.refreshed).catch(() => false);
            if (repaired) {
              try {
                return { server, connection: await connectCloudMcp(server) };
              } catch (retryError) {
                return {
                  server,
                  failure: retryError instanceof Error ? retryError.message : "connect failed",
                };
              }
            }
          }
          return { server, failure: message };
        }
      }),
  );
  for (const attempt of attempts) {
    if ("failure" in attempt) {
      runtime.failures.push({
        name: "mcp_connect",
        arguments: attempt.server.name,
        result: `Could not connect MCP server "${attempt.server.name}": ${attempt.failure}`,
      });
      continue;
    }
    let added = 0;
    for (const tool of attempt.connection.tools) {
      if (runtime.routes.size >= MAX_MCP_TOOLS) {
        break;
      }
      const fnName = cloudMcpFunctionName(attempt.server.id, tool.name);
      if (runtime.routes.has(fnName)) {
        continue;
      }
      runtime.routes.set(fnName, {
        type: "mcp",
        session: attempt.connection.session,
        toolName: tool.name,
        serverName: attempt.server.name,
      });
      runtime.toolDefs.push({
        type: "function",
        function: {
          name: fnName,
          description: `[MCP:${attempt.server.name}] ${tool.description}`.slice(0, 1_000),
          parameters: tool.inputSchema,
        },
      });
      added += 1;
    }
    runtime.summary.push(`${attempt.server.name} (${added} tools)`);
  }
  return runtime;
}

/** Dispatches one native-connector tool call to its server-side REST port. */
export async function callNativeConnectorTool(
  route: Extract<McpRoute, { type: "native" }>,
  args: Record<string, unknown>,
): Promise<string> {
  if (route.kind === "github") {
    return callGitHubNativeTool(route.auth, route.toolName, args);
  }
  if (route.kind === "slack") {
    return callSlackNativeTool(route.auth, route.toolName, args);
  }
  return callIntercomNativeTool(route.auth, route.toolName, args);
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
}

function buildSystemPrompt(job: ClaimJob, mcpSummary: string[]): string {
  const parts: string[] = [
    `You are Gera, executing the scheduled cloud automation "${job.name}". The user is away and will read this reply later in the thread.`,
    [
      "Rules for cloud runs:",
      "- Tools available: web_search (live web), fetch_url (read pages), and SelfSurf — an autonomous text browser (surf_open / surf_follow / surf_submit) that keeps cookies, follows links, and submits real forms. Use SelfSurf when a site must be navigated or its search/filter forms used; it does not execute JavaScript and cannot pass CAPTCHAs.",
      mcpSummary.length > 0
        ? `- MCP tools ARE armed this run (names start with "mcp_"): ${mcpSummary.join(", ")}. They act on the user's real accounts — read freely, but only perform writes the automation prompt clearly asks for.`
        : "- No MCP servers are armed for this run.",
      '- Citations: every web_search / fetch_url result carries a system-assigned citation number like [2]. When a claim comes from a source, put the marker right after the claim: "revenue grew 40% [2]". Several sources: [1][3]. The UI turns markers into clickable chips and shows a sources bar automatically — do not dump plain URL lists, and never use a number that was not shown to you.',
      "- Image/video/audio generation and hub writes are NOT available here. Never emit ```action fences.",
      "- Write the deliverable directly — compact, structured, skimmable. ```chart and ```mermaid fences render fine when they help.",
      "- If the thread's earlier runs are shown, focus on what is NEW since the previous run.",
      `- Current UTC time: ${new Date().toISOString()}.`,
    ].join("\n"),
  ];
  if (job.systemPrompt.trim().length > 0) {
    parts.push(`User instructions / persona:\n${job.systemPrompt.trim()}`);
  }
  if (job.memories.length > 0) {
    parts.push(`Known about the user (read-only):\n- ${job.memories.join("\n- ")}`);
  }
  if (job.knowledge.trim().length > 0) {
    parts.push(job.knowledge.trim());
  }
  return parts.join("\n\n");
}

/**
 * Runs one cloud automation: agent loop with web tools until the model
 * answers, the step budget runs out, or `deadlineAt` (wall clock) passes —
 * then a forced tool-free wrap-up so the thread always gets a real reply.
 */
export async function runAutomationJob(
  job: ClaimJob,
  authKey: string,
  deadlineAt?: number,
): Promise<AutomationRunResult> {
  // MCP first, so the system prompt lists what actually connected and the
  // thread shows honest records for servers that did not.
  const mcp = job.mcpServers.length > 0 ? await armCloudMcp(job.mcpServers) : emptyMcpRuntime();
  const tools: ToolDef[] = [...TOOLS, ...mcp.toolDefs];
  const messages: GatewayMessage[] = [{ role: "system", content: buildSystemPrompt(job, mcp.summary) }];
  for (const item of job.prior) {
    messages.push({ role: item.role, content: item.content });
  }
  messages.push({ role: "user", content: job.prompt });

  const records: ToolRecord[] = [...mcp.failures];
  const ledger = createSourceLedger();
  const surf: SurfState = { jar: {}, pages: [] };
  let lastContent = "";

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      break; // Out of wall-clock budget — wrap up with what we have.
    }
    const completion = await chatCompletion(job.modelId, messages, tools, authKey);
    if (completion.content.trim().length > 0) {
      lastContent = completion.content;
    }
    if (completion.toolCalls.length === 0) {
      return {
        content: completion.content || lastContent,
        toolCalls: records,
        sources: ledger.list(),
        refreshedOAuth: mcp.refreshed,
      };
    }
    messages.push({
      role: "assistant",
      content: completion.content || null,
      tool_calls: completion.toolCalls,
    });
    for (const call of completion.toolCalls) {
      const result = await executeTool(call.function.name, call.function.arguments, authKey, ledger, surf, mcp.routes);
      records.push({
        name: call.function.name,
        arguments: cap(call.function.arguments, 500),
        result: cap(result, 1_500),
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: cap(result, LIVE_RESULT_CHARS),
      });
    }
  }

  // Step or time budget exhausted — force a final answer without tools.
  messages.push({
    role: "system",
    content:
      "Stop using tools now. Write your complete final answer using everything gathered above; note plainly anything that could not be determined.",
  });
  const wrapUp = await chatCompletion(job.modelId, messages, null, authKey);
  return {
    content: wrapUp.content || lastContent || "(no output)",
    toolCalls: records,
    sources: ledger.list(),
    refreshedOAuth: mcp.refreshed,
  };
}

/** Splits a "model:effort" selection like the web client does. */
function parseSelection(selectionId: string): { catalogId: string; effort?: string } {
  const split = selectionId.lastIndexOf(":");
  if (split <= 0) {
    return { catalogId: selectionId };
  }
  const effort = selectionId.slice(split + 1);
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") {
    return { catalogId: selectionId.slice(0, split), effort };
  }
  return { catalogId: selectionId };
}

async function chatCompletion(
  modelId: string,
  messages: GatewayMessage[],
  tools: ToolDef[] | null,
  authKey: string,
): Promise<{ content: string; toolCalls: GatewayToolCall[] }> {
  const selection = parseSelection(modelId || "spacexai/grok-4.6:xhigh");
  const response = await fetch(`${TOOLKIT_URL}/v2/vercel/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authKey}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      model: selection.catalogId,
      messages,
      stream: false,
      ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      ...(selection.effort ? { reasoning: { enabled: true, effort: selection.effort } } : {}),
      providerOptions: { gateway: { models: CHAT_FALLBACKS } },
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`gateway ${response.status}: ${text.slice(0, 300)}`);
  }

  // The gateway may answer plain JSON or an SSE stream — handle both.
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("text/event-stream") || text.trimStart().startsWith("data:")) {
    return parseSse(text);
  }
  const parsed = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: GatewayToolCall[] } }>;
  };
  const message = parsed.choices?.[0]?.message;
  return {
    content: typeof message?.content === "string" ? message.content : "",
    toolCalls: sanitizeToolCalls(message?.tool_calls),
  };
}

function sanitizeToolCalls(calls: unknown): GatewayToolCall[] {
  if (!Array.isArray(calls)) {
    return [];
  }
  return calls
    .filter(
      (call): call is GatewayToolCall =>
        Boolean(call) &&
        typeof (call as GatewayToolCall).function?.name === "string" &&
        (call as GatewayToolCall).function.name.length > 0,
    )
    .map((call, index) => ({
      id: call.id || `tool_${index}`,
      type: "function" as const,
      function: {
        name: call.function.name,
        arguments: call.function.arguments || "{}",
      },
    }));
}

/** Accumulates content + tool-call deltas from a buffered SSE body. */
function parseSse(body: string): { content: string; toolCalls: GatewayToolCall[] } {
  let content = "";
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      const event = JSON.parse(payload) as {
        choices?: Array<{
          delta?: { content?: string; tool_calls?: Array<Record<string, unknown>> };
          message?: { content?: string; tool_calls?: Array<Record<string, unknown>> };
        }>;
      };
      const delta = event.choices?.[0]?.delta ?? {};
      const message = event.choices?.[0]?.message ?? {};
      const piece =
        (typeof delta.content === "string" ? delta.content : null) ??
        (typeof message.content === "string" ? message.content : null);
      if (piece) {
        content += piece;
      }
      const toolDeltas = delta.tool_calls ?? message.tool_calls;
      if (Array.isArray(toolDeltas)) {
        for (const item of toolDeltas) {
          const index = typeof item.index === "number" ? item.index : 0;
          const current = toolAcc.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof item.id === "string") {
            current.id = item.id;
          }
          const fn = item.function as Record<string, unknown> | undefined;
          if (typeof fn?.name === "string") {
            current.name += fn.name;
          }
          if (typeof fn?.arguments === "string") {
            current.arguments += fn.arguments;
          }
          toolAcc.set(index, current);
        }
      }
    } catch {
      // skip malformed events
    }
  }
  const toolCalls: GatewayToolCall[] = [...toolAcc.values()]
    .filter((call) => call.name.length > 0)
    .map((call, index) => ({
      id: call.id || `tool_${index}`,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
  return { content, toolCalls };
}

async function executeTool(
  name: string,
  argsJson: string,
  authKey: string,
  ledger: SourceLedger,
  surf: SurfState,
  mcpRoutes: Map<string, McpRoute>,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    const route = mcpRoutes.get(name);
    if (route) {
      try {
        const output =
          route.type === "native"
            ? await callNativeConnectorTool(route, args)
            : await callCloudMcpTool(route.session, route.toolName, args);
        return output.trim().length > 0 ? output : "(empty result)";
      } catch (error) {
        return `MCP tool failed (${route.serverName}): ${error instanceof Error ? error.message : "unknown error"}`;
      }
    }
    if (name === "web_search") {
      return await execWebSearch(
        String(args.query ?? ""),
        Number(args.numResults ?? 5),
        typeof args.recency === "string" ? args.recency : undefined,
        authKey,
        ledger,
      );
    }
    if (name === "fetch_url") {
      const urls = Array.isArray(args.urls) ? args.urls.map(String) : [];
      return await execFetchUrls(urls, authKey, ledger);
    }
    if (name === "surf_open" || name === "surf_follow" || name === "surf_submit") {
      return await execSurf(name, args, ledger, surf);
    }
    return `Tool "${name}" is not available in cloud runs.`;
  } catch (error) {
    return `Tool failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

/** Runs one SelfSurf step directly in the Worker (no HTTP hop needed). */
async function execSurf(
  name: string,
  args: Record<string, unknown>,
  ledger: SourceLedger,
  surf: SurfState,
): Promise<string> {
  const current = surf.pages[surf.pages.length - 1];

  if (name === "surf_open") {
    let url = String(args.url ?? "").trim();
    if (!url) {
      return "Missing url.";
    }
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    const page = await performSurf({ action: "open", url, referer: current?.url }, surf.jar);
    return recordSurfPage(page, ledger, surf);
  }

  if (name === "surf_follow") {
    if (!current) {
      return "No page is open yet — call surf_open first.";
    }
    const target = resolveFollowTarget(current, args.link);
    if (!target) {
      return `Could not resolve link "${String(args.link ?? "")}" — use an L-number from the last page or an absolute URL.`;
    }
    const page = await performSurf({ action: "open", url: target, referer: current.url }, surf.jar);
    return recordSurfPage(page, ledger, surf);
  }

  // surf_submit
  if (!current) {
    return "No page is open yet — call surf_open first.";
  }
  const formRef = String(args.form ?? "").trim();
  const formIndex = /^f?(\d+)$/i.exec(formRef);
  const form = formIndex ? current.forms[Number(formIndex[1]) - 1] : undefined;
  if (!form) {
    return `Form "${formRef}" not found on the current page — it lists ${current.forms.length} form(s).`;
  }
  if (form.enctype?.includes("multipart")) {
    return "That form uploads files (multipart) — SelfSurf cannot submit it. Honest limit.";
  }
  const provided =
    args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
      ? (args.fields as Record<string, unknown>)
      : {};
  const merged = mergeFormFields(form, provided);
  const page = await performSurf(
    { action: "submit", url: form.action, method: form.method, fields: merged, referer: current.url },
    surf.jar,
  );
  return recordSurfPage(page, ledger, surf);
}

function recordSurfPage(page: SurfPage, ledger: SourceLedger, surf: SurfState): string {
  let cite: number | null = null;
  if (page.status > 0 && page.url.startsWith("http")) {
    cite = ledger.assign(page.url, page.title || page.url);
  }
  if (page.status > 0) {
    surf.pages.push(page);
    if (surf.pages.length > 20) {
      surf.pages.shift();
    }
  }
  return formatSurfPage(page, cite, { text: 3_500, links: 20 });
}

function toolkitPost(path: string, body: unknown, authKey: string): Promise<Response> {
  return fetch(`${TOOLKIT_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authKey}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
}

async function execWebSearch(
  query: string,
  numResults: number,
  recency: string | undefined,
  authKey: string,
  ledger: SourceLedger,
): Promise<string> {
  if (!query.trim()) {
    return "Missing search query.";
  }
  const windowMs = recency ? RECENCY_WINDOW_MS[recency] : undefined;
  const response = await toolkitPost(
    "/v2/exa/search",
    {
      query,
      type: "auto",
      numResults: Math.min(Math.max(numResults || 5, 3), 8),
      ...(windowMs ? { startPublishedDate: new Date(Date.now() - windowMs).toISOString() } : {}),
      contents: { highlights: true },
    },
    authKey,
  );
  if (!response.ok) {
    return `Search failed (${response.status}).`;
  }
  const data = (await response.json()) as {
    results?: Array<{ title?: string; url: string; publishedDate?: string | null; highlights?: string[] }>;
  };
  const results = data.results ?? [];
  if (results.length === 0) {
    return windowMs
      ? `No results published in the last ${recency}. Retry without "recency" to include older material.`
      : "No search results.";
  }
  return results
    .map((hit) => {
      const marker = `[${ledger.assign(hit.url, hit.title)}]`;
      const date = hit.publishedDate ? ` (${hit.publishedDate.slice(0, 10)})` : "";
      const highlights = (hit.highlights ?? []).slice(0, 2).join(" ");
      return `${marker} ${hit.title ?? "(untitled)"}${date}\n${hit.url}\n${highlights}`.trim();
    })
    .join("\n\n");
}

async function execFetchUrls(urls: string[], authKey: string, ledger: SourceLedger): Promise<string> {
  const clean = urls.map((url) => url.trim()).filter((url) => url.startsWith("http")).slice(0, 4);
  if (clean.length === 0) {
    return "No valid URLs.";
  }
  // extras.links powers multi-hop browsing; retry the plain shape if the
  // proxy or upstream rejects the field so page reading never breaks.
  let response = await toolkitPost("/v2/exa/contents", { urls: clean, text: true, extras: { links: 10 } }, authKey);
  if (!response.ok) {
    response = await toolkitPost("/v2/exa/contents", { urls: clean, text: true }, authKey);
  }
  if (!response.ok) {
    return `Fetch failed (${response.status}).`;
  }
  const data = (await response.json()) as {
    results?: Array<{ url?: string; title?: string; text?: string; extras?: { links?: string[] } }>;
  };
  const results = data.results ?? [];
  if (results.length === 0) {
    return "Could not fetch those pages.";
  }
  return results
    .map((item) => {
      const marker = item.url ? `[${ledger.assign(item.url, item.title)}] ` : "";
      const body = (item.text ?? "").slice(0, 4_000);
      const links = (item.extras?.links ?? [])
        .filter((link) => typeof link === "string" && link.startsWith("http"))
        .slice(0, 10);
      const linksBlock =
        links.length > 0
          ? `\n\nLinks on this page (fetch_url them to browse deeper):\n${links.join("\n")}`
          : "";
      return `${marker}# ${item.title ?? item.url ?? "Page"}\n${item.url ?? ""}\n${body}${linksBlock}`;
    })
    .join("\n\n---\n\n");
}
