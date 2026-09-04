// Client side of the composer's MCP prompt (`/`) and resource (`@`) menus.
// Everything protocol-related happens on the account shard (functions/
// mcp-routes.ts); the browser only names a server id, a prompt name or
// resource URI, and the arguments the user typed. Inventories are cached
// per server for the session so reopening a menu costs nothing.

import { authedFetch } from "@/lib/backend";
import { newId } from "@/lib/env";
import type { Attachment, McpServerConfig } from "@/lib/types";

export type McpPromptArgument = { name: string; description?: string; required?: boolean };

export type McpPromptInfo = {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
};

export type McpResourceInfo = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
};

export type McpResourceTemplateInfo = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type McpInventory = {
  prompts: McpPromptInfo[];
  resources: McpResourceInfo[];
  resourceTemplates: McpResourceTemplateInfo[];
  toolCount: number;
  cached: boolean;
};

export type McpPromptMessage = {
  role: "user" | "assistant";
  text: string;
  image?: { data: string; mimeType: string };
};

export type McpPromptResult = { description?: string; messages: McpPromptMessage[] };

export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
  truncated?: boolean;
  blob?: string;
  omitted?: boolean;
  size?: number;
};

const INVENTORY_TTL_MS = 5 * 60_000;
const inventoryCache = new Map<string, { at: number; value: McpInventory }>();
const inventoryInFlight = new Map<string, Promise<McpInventory>>();

/** Drops cached inventories (sign-out, Re-check). */
export function clearMcpInventoryCache(serverId?: string): void {
  if (serverId) {
    inventoryCache.delete(serverId);
    return;
  }
  inventoryCache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function postJson<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const response = await authedFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = isRecord(data) && typeof data.error === "string" ? data.error : "";
    throw new Error(
      error === "server_unavailable"
        ? "This server is not connected any more — reconnect it on the MCP page."
        : error || `${fallback} (${response.status})`,
    );
  }
  if (!isRecord(data)) {
    throw new Error(fallback);
  }
  return data as T;
}

/** Servers whose prompts/resources the menus can offer: connected, enabled, generic MCP (not native connectors). */
export function menuEligibleServers(servers: McpServerConfig[], kind: "prompts" | "resources"): McpServerConfig[] {
  return servers.filter((server) => {
    if (!server.enabled || server.status !== "connected") {
      return false;
    }
    const catalogKey = server.catalogId ?? server.id;
    if (catalogKey === "github" || catalogKey === "slack" || catalogKey === "intercom") {
      return false;
    }
    const count = kind === "prompts" ? server.promptCount : server.resourceCount;
    // Unknown (older check) → ask the server once; 0 → nothing to offer.
    return count === undefined || count > 0;
  });
}

/** Lists prompts/resources/templates of one server (account cache first, then one handshake). */
export function fetchMcpInventory(serverId: string, options: { refresh?: boolean } = {}): Promise<McpInventory> {
  const cached = inventoryCache.get(serverId);
  if (!options.refresh && cached && Date.now() - cached.at < INVENTORY_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  const pending = inventoryInFlight.get(serverId);
  if (pending) {
    return pending;
  }
  const task = postJson<Record<string, unknown>>("/mcp/inventory", { serverId, refresh: options.refresh === true }, "Could not list this server")
    .then((data) => {
      const value: McpInventory = {
        prompts: Array.isArray(data.prompts) ? (data.prompts as McpPromptInfo[]) : [],
        resources: Array.isArray(data.resources) ? (data.resources as McpResourceInfo[]) : [],
        resourceTemplates: Array.isArray(data.resourceTemplates) ? (data.resourceTemplates as McpResourceTemplateInfo[]) : [],
        toolCount: typeof data.toolCount === "number" ? data.toolCount : 0,
        cached: data.cached === true,
      };
      inventoryCache.set(serverId, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inventoryInFlight.delete(serverId);
    });
  inventoryInFlight.set(serverId, task);
  return task;
}

/** `prompts/get` through the account shard. */
export async function getMcpPrompt(serverId: string, name: string, args: Record<string, string>): Promise<McpPromptResult> {
  const data = await postJson<Record<string, unknown>>("/mcp/prompt-get", { serverId, name, arguments: args }, "Could not load this prompt");
  const messages = Array.isArray(data.messages)
    ? data.messages.flatMap((raw): McpPromptMessage[] =>
        isRecord(raw) && typeof raw.text === "string"
          ? [
              {
                role: raw.role === "assistant" ? "assistant" : "user",
                text: raw.text,
                ...(isRecord(raw.image) && typeof raw.image.data === "string"
                  ? { image: { data: raw.image.data, mimeType: typeof raw.image.mimeType === "string" ? raw.image.mimeType : "image/png" } }
                  : {}),
              },
            ]
          : [],
      )
    : [];
  return { ...(typeof data.description === "string" ? { description: data.description } : {}), messages };
}

/** `resources/read` through the account shard. */
export async function readMcpResource(serverId: string, uri: string): Promise<McpResourceContent[]> {
  const data = await postJson<Record<string, unknown>>("/mcp/resource-read", { serverId, uri }, "Could not read this resource");
  return Array.isArray(data.contents)
    ? data.contents.filter((item): item is McpResourceContent => isRecord(item) && typeof item.uri === "string")
    : [];
}

/**
 * Text a prompt result becomes in the composer. One user message is inserted
 * as-is; several messages (or assistant turns) keep role markers so the
 * conversation the prompt scripted stays readable.
 */
export function promptMessagesToText(result: McpPromptResult): string {
  const textual = result.messages.filter((message) => message.text.trim().length > 0);
  if (textual.length === 1 && textual[0].role === "user") {
    return textual[0].text.trim();
  }
  return textual
    .map((message) => `[${message.role === "assistant" ? "assistant" : "user"}]\n${message.text.trim()}`)
    .join("\n\n");
}

/** Inline images a prompt returned, as composer attachments (data URLs). */
export function promptImagesToAttachments(result: McpPromptResult, label: string): Attachment[] {
  return result.messages.flatMap((message, index): Attachment[] =>
    message.image
      ? [
          {
            id: newId(),
            name: `${label}-${index + 1}.${message.image.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png"}`,
            mime: message.image.mimeType,
            dataUrl: `data:${message.image.mimeType};base64,${message.image.data}`,
          },
        ]
      : [],
  );
}

function fileNameFromUri(uri: string): string {
  const tail = uri.split(/[/:]/).filter(Boolean).pop() ?? "resource";
  return tail.replace(/[^\w.-]+/g, "_").slice(0, 80) || "resource";
}

const TEXT_LIKE = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript|toml|csv|markdown))/i;

/**
 * Turns one resource read into composer attachments: text rides as an
 * extracted-text attachment (already capped at 300k on the server; truncation
 * noted in the text), small binaries as a data URL, oversized ones as an
 * honest note with mime and size.
 */
export function resourceContentsToAttachments(
  server: Pick<McpServerConfig, "id" | "name">,
  contents: McpResourceContent[],
): Attachment[] {
  const out: Attachment[] = [];
  for (const content of contents) {
    const base = `${server.name} · ${fileNameFromUri(content.uri)}`;
    if (typeof content.text === "string") {
      const mime = content.mimeType && TEXT_LIKE.test(content.mimeType) ? content.mimeType : "text/plain";
      out.push({
        id: newId(),
        name: base,
        mime,
        dataUrl: "",
        text: content.truncated
          ? `${content.text}\n\n[Gera: resource text truncated at 300,000 characters — ${content.uri}]`
          : content.text,
      });
      continue;
    }
    if (typeof content.blob === "string") {
      const mime = content.mimeType ?? "application/octet-stream";
      out.push({ id: newId(), name: base, mime, dataUrl: `data:${mime};base64,${content.blob}` });
      continue;
    }
    const size = typeof content.size === "number" ? `${Math.max(1, Math.round(content.size / 1024))} KB` : "unknown size";
    out.push({
      id: newId(),
      name: base,
      mime: "text/plain",
      dataUrl: "",
      text: `[Gera: binary resource ${content.uri} (${content.mimeType ?? "unknown type"}, ${size}) exceeds the 4 MB attachment limit and was not attached.]`,
    });
  }
  return out;
}

/** Variable names of a URI template (`{var}`, operators stripped) — mirrors the server helper. */
export function uriTemplateVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    for (const part of match[1].replace(/^[+#./;?&]/, "").split(",")) {
      const name = part.replace(/\*$/, "").replace(/:\d+$/, "").trim();
      if (name && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

/** Level-1 URI template expansion with encoding (`{+var}` keeps reserved characters). */
export function expandUriTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (_whole, expression: string) => {
    const operator = /^[+#./;?&]/.exec(expression)?.[0] ?? "";
    const names = expression
      .slice(operator.length)
      .split(",")
      .map((part) => part.replace(/\*$/, "").replace(/:\d+$/, "").trim());
    const encode = (value: string): string => (operator === "+" || operator === "#" ? encodeURI(value) : encodeURIComponent(value));
    const pieces = names.map((name) => encode(values[name] ?? ""));
    switch (operator) {
      case "?":
        return `?${names.map((name, index) => `${name}=${pieces[index]}`).join("&")}`;
      case "&":
        return `&${names.map((name, index) => `${name}=${pieces[index]}`).join("&")}`;
      case "#":
        return `#${pieces.join(",")}`;
      case ".":
        return `.${pieces.join(".")}`;
      case "/":
        return `/${pieces.join("/")}`;
      case ";":
        return `;${names.map((name, index) => `${name}=${pieces[index]}`).join(";")}`;
      default:
        return pieces.join(",");
    }
  });
}

export type ComposerMenuTrigger = {
  kind: "prompt" | "resource";
  /** Text typed after the trigger character (filter). */
  query: string;
  /** Range of the whole token (trigger character included) inside the input. */
  start: number;
  end: number;
};

/**
 * Detects a `/` (prompts) or `@` (resources) token ending at the caret. The
 * trigger must start the input or follow whitespace so paths and emails in
 * the middle of a sentence never open a menu.
 */
export function detectComposerMenuTrigger(input: string, caret: number): ComposerMenuTrigger | null {
  const before = input.slice(0, Math.max(0, Math.min(caret, input.length)));
  const match = /(?:^|\s)([/@])([^\s]*)$/.exec(before);
  if (!match) {
    return null;
  }
  const token = match[1] + match[2];
  const start = before.length - token.length;
  return { kind: match[1] === "/" ? "prompt" : "resource", query: match[2], start, end: before.length };
}

/** Replaces the trigger token with `replacement` (plus a trailing space) and returns the new input + caret. */
export function replaceComposerToken(input: string, trigger: ComposerMenuTrigger, replacement: string): { value: string; caret: number } {
  const head = input.slice(0, trigger.start);
  const tail = input.slice(trigger.end);
  const inserted = replacement.length > 0 && !tail.startsWith(" ") && !tail.startsWith("\n") ? `${replacement} ` : replacement;
  return { value: `${head}${inserted}${tail}`, caret: head.length + inserted.length };
}
