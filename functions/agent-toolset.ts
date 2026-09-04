// Tool assembly for project agents (project channels and Slack): access +
// stored secrets → engine tool definitions, native connector routes and the
// external-MCP toolset resolved through the linking admin's account shard.
// Moved out of project-store.ts verbatim; the store injects what only it knows
// (secret reveal, membership, access normalisation, the DO binding) through
// AgentToolsetContext, so this module never touches project storage.

import { capText, type EngineToolDef } from "./agent-engine";
import { normalizeCloudMcpServer, type CloudMcpServer } from "./mcp-cloud";
import { mcpJournalRow, postMcpJournal } from "./mcp-journal";
import {
  createMemoryMcpCatalogStore,
  normalizeMcpCatalogEntries,
  normalizeMcpToolLoading,
  resolveMcpToolset,
  type McpCatalogEntry,
  type McpRoute,
  type McpToolLoadingMode,
  type McpToolset,
} from "./mcp-toolset";
import {
  accessForAgentSurface,
  agentMcpPolicy,
  planAgentTools,
  type AgentAccess,
  type AgentMcpSelection,
  type AgentSecretFlags,
  type AgentSecrets,
  type AgentToolPlan,
} from "./project-shared";
import { builtinToolDefs } from "./run-tools";
import { chatShardId } from "./shard-migration";

/** What the store provides; `A` is its agent row (only the name is read here). */
export type AgentToolsetContext<A extends { name: string } = { name: string }> = {
  /** Durable Object namespace binding; absent → owner-account paths report "backend misconfigured". */
  durable?: { fetch(request: Request): Promise<Response> };
  waitUntil(promise: Promise<unknown>): void;
  /** The agent's normalised access record (surface filtering happens here). */
  agentAccess(agent: A): AgentAccess;
  /** Opens the agent's sealed secrets for this run. */
  revealAgentSecrets(agent: A): Promise<AgentSecrets>;
  secretFlags(secrets: AgentSecrets): AgentSecretFlags;
  /** True when `email` is a current member who may manage the project — linked servers and accounts resolve only through such members. */
  canManage(email: string): boolean;
  /** Function budget for one agent run (native routes + MCP). */
  toolCap: number;
};

export type AgentToolsetResult = {
  tools: EngineToolDef[];
  routes: Map<string, McpRoute>;
  plan: AgentToolPlan;
  access: AgentAccess;
  mcpNote: string;
  /** Resolved external-MCP toolset (inline routes or deferred meta functions); null without linked servers. */
  toolset: McpToolset | null;
};

/**
 * Access + stored secrets → engine tool defs + native/MCP routes for one
 * run. External MCP servers connect live (in parallel) — `mcpNote` reports
 * per-server status honestly for the system prompt ("" when none).
 */
export async function buildAgentToolset<A extends { name: string }>(
  ctx: AgentToolsetContext<A>,
  agent: A,
  surface: "project" | "slack" = "project",
): Promise<AgentToolsetResult> {
  const access = accessForAgentSurface(ctx.agentAccess(agent), surface);
  const secrets = await ctx.revealAgentSecrets(agent);
  const requestedSelection = access.mcp ? secrets.mcpSelection : undefined;
  const selection = requestedSelection && ctx.canManage(requestedSelection.owner) ? requestedSelection : undefined;
  const selectionRefs = selection?.servers ?? [];
  const plan = planAgentTools(access, ctx.secretFlags(secrets), selectionRefs.length);
  let accountGitHubAuth = "";
  if (access.github !== "off" && !secrets.githubToken && secrets.githubAccount) {
    if (ctx.canManage(secrets.githubAccount.owner)) {
      accountGitHubAuth = await resolveOwnerAuth(ctx, secrets.githubAccount.owner, secrets.githubAccount.serverId);
    }
  }
  const tools: EngineToolDef[] = [
    ...builtinToolDefs({
      web_search: plan.webEnabled,
      fetch_url: plan.webEnabled,
      selfsurf: false,
      generate_image: false,
      generate_video: false,
      generate_audio: false,
    }),
  ];
  const routes = new Map<string, McpRoute>();
  for (const planned of plan.native) {
    const token =
      planned.kind === "github"
        ? secrets.githubToken ?? accountGitHubAuth
        : planned.kind === "intercom"
          ? secrets.intercomToken ?? ""
          : secrets.slackToken ?? "";
    if (!token) {
      continue;
    }
    routes.set(planned.fnName, {
      type: "native",
      kind: planned.kind,
      auth:
        planned.kind === "github"
          ? token.toLowerCase().startsWith("bearer ")
            ? token
            : `Bearer ${token}`
          : token,
      toolName: planned.toolName,
      serverName: planned.kind,
    });
    tools.push({
      type: "function",
      function: {
        name: planned.fnName,
        description: `[${planned.kind}] ${planned.description}`.slice(0, 1_000),
        parameters: planned.inputSchema,
      },
    });
  }

  let mcpNote =
    requestedSelection && !selection
      ? `\nExternal MCP servers: unavailable — the account that linked them is no longer a project admin. Re-link them in the agent settings.`
      : "";
  let toolset: McpToolset | null = null;
  if (selection && selectionRefs.length > 0) {
    const noteLines: string[] = [];
    const resolved = await resolveOwnerMcp(ctx, selection);
    if (!resolved.ok) {
      for (const ref of selectionRefs) {
        noteLines.push(
          `- "${ref.name}": unavailable (${capText(resolved.error, 160)}) — its tools are missing this run; say so if they are needed.`,
        );
      }
    } else {
      const byId = new Map(resolved.servers.map((server) => [server.id, server] as const));
      const refName = new Map(selectionRefs.map((ref) => [ref.id, ref.name] as const));
      const servers: CloudMcpServer[] = [];
      for (const ref of selectionRefs) {
        const server = byId.get(ref.id);
        if (!server) {
          noteLines.push(
            `- "${ref.name}": connection FAILED (not among ${selection.owner}'s connected servers anymore — reconnect it on the MCP page) — its tools are unavailable this run; say so if they are needed.`,
          );
          continue;
        }
        // The agent's stored label names the server for the model, as before.
        servers.push({ ...server, name: ref.name });
      }
      if (servers.length > 0) {
        // The owner's catalog cache rides along with the resolve response, so
        // deferred runs search it without a handshake. A rejected sign-in
        // re-resolves through the owner's shard (which refreshes + persists
        // the grant) — grants are never rotated inside the project shard.
        const catalog = createMemoryMcpCatalogStore();
        for (const entry of resolved.catalog) {
          catalog.write(entry);
        }
        toolset = await resolveMcpToolset({
          servers,
          mode: resolved.toolLoading,
          surface: "background",
          catalog,
          // Per-agent policy: tool allowlists per linked server and the
          // write policy ("ask" declines write tools — agents run unattended).
          policy: agentMcpPolicy(selection),
          // Decisions land in the linking admin's diagnostics journal.
          onJournal: (entry) => {
            const row = mcpJournalRow(entry, { surface: surface === "slack" ? "slack" : "project", label: agent.name });
            if (row) {
              ctx.waitUntil(postMcpJournal(ctx.durable, selection.owner, [row]));
            }
          },
          // Agent runs are short and background: no GET notification stream
          // to keep alive (list_changed reaches them through the owner's
          // catalog cache on the next resolve); elicitation is declined.
          notificationStreams: false,
          nativeCap: Math.max(0, ctx.toolCap - routes.size),
          // Per-request credential lease through the owner's shard: the grant
          // or key is opened there for each MCP request (refresh inside, forced
          // after an auth rejection) and never retained in this project shard.
          credentials: async (serverId, { force }) => {
            const fresh = await resolveOwnerMcp(ctx, selection, force ? [serverId] : undefined);
            const server = fresh.ok ? fresh.servers.find((candidate) => candidate.id === serverId) : undefined;
            return server ? { ...server, name: refName.get(serverId) ?? server.name } : null;
          },
        });
        for (const [fnName, route] of toolset.routes) {
          if (!routes.has(fnName)) {
            routes.set(fnName, route);
          }
        }
        tools.push(...toolset.toolDefs.filter((def) => !tools.some((tool) => tool.function.name === def.function.name)));
        for (const info of toolset.servers) {
          if (info.unavailable) {
            noteLines.push(
              `- "${info.name}": connection FAILED (${capText(info.unavailable, 200)}) — its tools are unavailable this run; say so if they are needed.`,
            );
          } else if (info.deferred) {
            noteLines.push(
              `- "${info.name}": connected — ${info.toolCount} tools, loaded on demand (find them with mcp_search_tools, run them with mcp_call_tool).`,
            );
          } else {
            noteLines.push(`- "${info.name}": connected — ${info.toolCount} tools available (mcp_* functions).`);
          }
        }
        for (const failure of toolset.failures) {
          if (failure.name === "mcp_limit") {
            noteLines.push(`- ${capText(failure.result, 300)}`);
          }
        }
        if (toolset.promptNote) {
          noteLines.push(toolset.promptNote);
        }
      }
    }
    mcpNote = `\nExternal MCP servers (linked through ${selection.owner}'s account):\n${noteLines.join("\n")}`;
  }
  return { tools, routes, plan, access, mcpNote, toolset };
}

/** Resolves one native account credential without copying it into this project. */
export async function resolveOwnerAuth(
  ctx: Pick<AgentToolsetContext, "durable">,
  owner: string,
  serverId: string,
): Promise<string> {
  const doBinding = ctx.durable;
  if (!doBinding) {
    return "";
  }
  try {
    const headers = new Headers({
      "Content-Type": "application/json",
      "X-Rork-DO-Class": "ChatStore",
      "X-Rork-DO-Id": chatShardId(owner),
      "X-Gera-Email": encodeURIComponent(owner),
    });
    const response = await doBinding.fetch(
      new Request("https://gera.internal/mcp/auth-lease", {
        method: "POST",
        headers,
        body: JSON.stringify({ serverId, catalogId: "github" }),
      }),
    );
    if (!response.ok) {
      return "";
    }
    const data = (await response.json().catch(() => ({}))) as { authorization?: unknown };
    return typeof data.authorization === "string" ? data.authorization : "";
  } catch {
    return "";
  }
}

export type OwnerMcpResolution =
  | { ok: true; servers: CloudMcpServer[]; toolLoading: McpToolLoadingMode; catalog: McpCatalogEntry[] }
  | { ok: false; error: string };

/**
 * Resolves the agent's linked MCP servers through the linking admin's
 * account shard — the exact pipeline cloud automations use. Keys and
 * sign-ins stay on that account; expiring sign-ins refresh there, and
 * `force` re-redeems a grant after an auth-rejected connect.
 */
export async function resolveOwnerMcp(
  ctx: Pick<AgentToolsetContext, "durable">,
  selection: AgentMcpSelection,
  force?: string[],
): Promise<OwnerMcpResolution> {
  const doBinding = ctx.durable;
  if (!doBinding) {
    return { ok: false, error: "backend misconfigured — no shard binding" };
  }
  try {
    const headers = new Headers();
    headers.set("X-Rork-DO-Class", "ChatStore");
    headers.set("X-Rork-DO-Id", chatShardId(selection.owner));
    headers.set("X-Gera-Email", encodeURIComponent(selection.owner));
    headers.set("Content-Type", "application/json");
    const response = await doBinding.fetch(
      new Request("https://gera.internal/mcp/resolve", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ids: selection.servers.map((server) => server.id),
          ...(force && force.length > 0 ? { force } : {}),
        }),
      }),
    );
    if (response.status === 428) {
      return { ok: false, error: `${selection.owner}'s account has not synced to the server yet` };
    }
    if (!response.ok) {
      return { ok: false, error: `${selection.owner}'s account shard answered ${response.status}` };
    }
    const data = (await response.json().catch(() => null)) as {
      servers?: unknown;
      toolLoading?: unknown;
      catalog?: unknown;
    } | null;
    const rawList = data && Array.isArray(data.servers) ? data.servers : [];
    const servers: CloudMcpServer[] = [];
    for (const raw of rawList) {
      const server = normalizeCloudMcpServer(raw);
      if (server) {
        servers.push(server);
      }
    }
    return {
      ok: true,
      servers,
      toolLoading: normalizeMcpToolLoading(data?.toolLoading),
      catalog: normalizeMcpCatalogEntries(data?.catalog),
    };
  } catch (error) {
    console.error("agent mcp resolve failed:", error instanceof Error ? error.message : "unknown");
    return { ok: false, error: "could not reach the owner's account shard" };
  }
}
