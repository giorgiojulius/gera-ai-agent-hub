import { FAST_MODEL } from "@/lib/models";
import { reportUsage } from "@/lib/usage";
import { toolkitFetch } from "@/lib/toolkit";
import { chatGatewayOptions } from "@/lib/tools";
import type { AgentSettings, BuiltinToolId, ChatMessage, McpServerConfig } from "@/lib/types";

/** Result of the prompt router: which tools to arm for one agent turn. */
export type ToolPlan = {
  builtins: BuiltinToolId[];
  mcpServerIds: string[];
  labels: string[];
  /**
   * Invisible grounding: 0-3 web queries to pre-search before the turn when
   * live, checkable information would materially improve the answer.
   */
  queries: string[];
};

export const BUILTIN_TOOL_LABEL: Record<BuiltinToolId, string> = {
  web_search: "Web search",
  fetch_url: "Fetch URL",
  selfsurf: "SelfSurf",
  generate_image: "Image",
  generate_video: "Video",
  generate_audio: "Audio",
};

const BUILTIN_HINT: Record<BuiltinToolId, string> = {
  web_search: "live web search — current events, news, prices, docs, facts, anything time-sensitive or niche",
  fetch_url: "read the full text of specific URLs or links the user pasted",
  selfsurf: "autonomous browser — navigate a site page by page, use its search box, submit forms, keep session cookies",
  generate_image: "create an image, picture, logo, illustration, or art from a description",
  generate_video: "create a short video clip or animation from a description",
  generate_audio: "speak text aloud with text-to-speech — narration, voiceover, reading a passage",
};

const ROUTER_PROMPT = `You are a tool router for an AI agent. Read the user's request and decide which of the available tools the agent will actually need for this exact request, and whether a quick web pre-search would make the answer materially better.

Reply with ONLY compact JSON, no markdown, no prose:
{"builtins":["web_search"],"mcp":["<server id>"],"queries":["focused web search query"]}

Rules:
- Include a tool only when the request benefits from it. If unsure, include it.
- Current events, live data, prices, news, "latest" anything -> web_search.
- The user pasted URLs to read or summarize -> fetch_url.
- The user asks to open, visit, go to, or interact with a specific site (on-site search, forms, pagination, checking what a live page currently shows) -> selfsurf, usually together with web_search.
- Draw/create/make a picture, logo, art -> generate_image. A video or animation -> generate_video. Speak/narrate/read text aloud -> generate_audio.
- Pick an MCP server when the request involves that product or its data (repos, issues, PRs -> GitHub; tickets -> Linear; pages -> Notion; payments -> Stripe; docs lookups -> the matching docs server).
- "queries": 1-3 short web searches. DEFAULT TO SEARCHING: any request touching facts about the real world gets queries — news, prices, products, versions, releases, docs/APIs, companies, people, places, laws, schedules, recommendations, comparisons, troubleshooting, statistics, how-tos, health, travel, anything that could have changed since training. When unsure, include 1-2 queries. Cover different angles, not rephrasings of one query. Write each in the language of the best likely sources (English for global tech topics, the user's language for local ones).
- Leave "queries" empty ONLY for requests with no factual surface at all: pure reasoning/math, creative writing, editing text the user provided, coding purely on provided code, translation, or chit-chat -> {"builtins":[],"mcp":[],"queries":[]}.
- The request is often a FOLLOW-UP in an ongoing conversation. Use the conversation context to resolve pronouns and short references ("it", "that one", "there", "а сколько стоит?") to their actual subjects. Every query must be fully self-contained and name the real subject — a bare "price" or "подробнее" is useless as a search.`;

function routerCandidates(settings: AgentSettings): { builtins: BuiltinToolId[]; servers: McpServerConfig[] } {
  const builtins = (Object.keys(BUILTIN_HINT) as BuiltinToolId[]).filter((id) => settings.builtinTools[id]);
  const servers = settings.mcpServers.filter(
    (item) => item.enabled && item.status === "connected" && item.tools.length > 0,
  );
  return { builtins, servers };
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException("Router timed out.", "TimeoutError")), ms);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cancel: () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** How much recent conversation the router sees to understand follow-ups. */
const CONTEXT_MESSAGES = 6;
const CONTEXT_MESSAGE_CHARS = 280;
const CONTEXT_TOTAL_CHARS = 1_600;

/**
 * Compact role-labeled digest of the recent conversation. Without it the
 * router judges every follow-up ("а подробнее?", "what about pricing?") in a
 * vacuum and produces useless or empty search queries — the top cause of
 * weaker answers on non-first messages.
 */
export function routerContextDigest(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages.slice(-CONTEXT_MESSAGES)) {
    const text = message.content.replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }
    const label = message.role === "user" ? "User" : "Assistant";
    lines.push(
      `${label}: ${text.length > CONTEXT_MESSAGE_CHARS ? `${text.slice(0, CONTEXT_MESSAGE_CHARS)}…` : text}`,
    );
  }
  const digest = lines.join("\n");
  // Keep the tail — the most recent exchange matters most for references.
  return digest.length > CONTEXT_TOTAL_CHARS ? digest.slice(digest.length - CONTEXT_TOTAL_CHARS) : digest;
}

/**
 * Ask a fast model which tools this prompt needs. Returns null on any failure
 * so the caller can fall back to arming every enabled tool.
 */
export async function planTools(params: {
  prompt: string;
  /** Recent conversation digest — lets the router understand follow-ups. */
  context?: string;
  attachmentCount: number;
  settings: AgentSettings;
  signal?: AbortSignal;
}): Promise<ToolPlan | null> {
  const { builtins, servers } = routerCandidates(params.settings);
  if (builtins.length + servers.length === 0) {
    return { builtins: [], mcpServerIds: [], labels: [], queries: [] };
  }

  const lines: string[] = [];
  if (params.context && params.context.length > 0) {
    lines.push(
      "Conversation so far (the request below may be a follow-up referring to it):",
      `"""${params.context}"""`,
      "",
    );
  }
  lines.push("User request:", `"""${params.prompt.slice(0, 2000)}"""`);
  if (params.attachmentCount > 0) {
    lines.push(`(The user attached ${params.attachmentCount} file(s); the main model already sees images without tools.)`);
  }
  lines.push("", "Builtin tools:");
  for (const id of builtins) {
    lines.push(`- ${id}: ${BUILTIN_HINT[id]}`);
  }
  if (servers.length > 0) {
    lines.push("", "MCP servers (pick by id):");
    for (const server of servers) {
      const names = server.tools.slice(0, 10).map((tool) => tool.name).join(", ");
      lines.push(`- ${server.id}: "${server.name}" — tools: ${names}`);
    }
  }

  const guard = withTimeout(params.signal, 8000);
  try {
    const response = await toolkitFetch("/v2/vercel/v1/chat/completions", {
      method: "POST",
      retry: false,
      signal: guard.signal,
      body: JSON.stringify({
        model: FAST_MODEL,
        stream: false,
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: "system", content: ROUTER_PROMPT },
          { role: "user", content: lines.join("\n") },
        ],
        providerOptions: chatGatewayOptions(),
      }),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: Record<string, unknown>;
    };
    reportUsage(FAST_MODEL, data.usage, "service");
    const parsed = extractJson(data.choices?.[0]?.message?.content ?? "");
    if (!parsed) {
      return null;
    }
    const rawBuiltins = Array.isArray(parsed.builtins) ? parsed.builtins.map(String) : [];
    const rawMcp = Array.isArray(parsed.mcp) ? parsed.mcp.map(String) : [];
    const rawQueries = Array.isArray(parsed.queries) ? parsed.queries.map(String) : [];
    const queries = [...new Set(rawQueries.map((query) => query.trim()).filter((query) => query.length > 1))]
      .slice(0, 3)
      .map((query) => query.slice(0, 160));
    const pickedBuiltins = builtins.filter((id) => rawBuiltins.includes(id));
    const pickedServers = servers.filter(
      (server) =>
        rawMcp.includes(server.id) ||
        rawMcp.some((value) => value.toLowerCase() === server.name.toLowerCase()),
    );
    return {
      builtins: pickedBuiltins,
      mcpServerIds: pickedServers.map((server) => server.id),
      labels: [
        ...pickedBuiltins.map((id) => BUILTIN_TOOL_LABEL[id]),
        ...pickedServers.map((server) => server.name),
      ],
      queries,
    };
  } catch {
    return null;
  } finally {
    guard.cancel();
  }
}
