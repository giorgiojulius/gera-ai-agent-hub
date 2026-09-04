// MCP tool policy — the ONE place a run decides what the model may see and
// which calls need a human. Two knobs:
//
// - allowlist: per server, the tool names an agent may see (search results,
//   inline function definitions, mcp_call_tool); servers absent from a set
//   allowlist stay out of the run entirely;
// - writes: "ask" pauses an interactive run for the user's confirmation
//   before a write / destructive tool runs (background runs decline honestly
//   and journal it); "auto" runs every allowed tool.
//
// Risk comes from the spec's tool annotations: `readOnlyHint: true` → read;
// `destructiveHint: true` → destructive; anything else — annotations missing
// included — is a write, because an unannotated tool may change data. The
// native GitHub / Slack / Intercom connectors carry a static classification.
// Argument values never reach a journal entry; the confirmation card gets a
// redacted, capped preview.

import type { McpToolAnnotations } from "./mcp-protocol";

export type McpWritePolicy = "ask" | "auto";
export type McpToolRisk = "read" | "write" | "destructive";
export type NativeConnectorKind = "github" | "slack" | "intercom";

/** Server id → allowed tool names; null lists every tool of that server. */
export type McpToolAllowlist = Record<string, string[] | null>;

/** A tool the user approved for the rest of a chat ("Always allow in this chat"). */
export type McpToolApproval = { serverId: string; toolName: string };

export type McpRunPolicy = {
  /** null = every resolved server with every tool. */
  allow: McpToolAllowlist | null;
  writes: McpWritePolicy;
  /** Tools already approved for this chat — they run without asking again. */
  approved?: McpToolApproval[];
};

/** Nothing filtered, nothing confirmed — the historical behavior. */
export const OPEN_MCP_POLICY: McpRunPolicy = { allow: null, writes: "auto" };

/** A confirmation waits this long for the user before the call is declined. */
export const CONFIRMATION_TIMEOUT_MS = 10 * 60_000;
/** The confirmation card never shows more of the arguments than this. */
export const ARGUMENT_PREVIEW_CHARS = 2_000;
/** Approvals a run config may carry (one chat rarely approves more than a handful). */
const MAX_APPROVALS = 200;
const ID_CHARS = 120;

export const MCP_WRITE_POLICIES: readonly McpWritePolicy[] = ["ask", "auto"];

/** Parses a stored / synced value; anything unknown means "auto". */
export function normalizeMcpWritePolicy(value: unknown): McpWritePolicy {
  return value === "ask" ? "ask" : "auto";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Revives the approvals a client sent with a run config (bounded, deduplicated). */
export function normalizeMcpApprovals(raw: unknown): McpToolApproval[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: McpToolApproval[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_APPROVALS) {
      break;
    }
    if (!isRecord(item) || typeof item.serverId !== "string" || typeof item.toolName !== "string") {
      continue;
    }
    const serverId = item.serverId.trim().slice(0, ID_CHARS);
    const toolName = item.toolName.trim().slice(0, ID_CHARS);
    if (!serverId || !toolName) {
      continue;
    }
    const key = mcpApprovalKey(serverId, toolName);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ serverId, toolName });
  }
  return out;
}

/**
 * The account's policy for its own runs (chat, Deep Research, automations):
 * open unless "Confirm write tools by default" is on.
 */
export function accountMcpPolicy(confirmWriteTools: unknown, approved?: unknown): McpRunPolicy {
  const approvals = normalizeMcpApprovals(approved);
  return {
    allow: null,
    writes: confirmWriteTools === true ? "ask" : "auto",
    ...(approvals.length > 0 ? { approved: approvals } : {}),
  };
}

/** Composite key of one tool on one server. */
export function mcpApprovalKey(serverId: string, toolName: string): string {
  return `${serverId}\u0000${toolName}`;
}

// ---------------------------------------------------------------------------
// Risk.

/**
 * Static risk of the first-party connectors' tools — their tables carry no
 * annotations. Everything not listed reads.
 */
const NATIVE_TOOL_RISK: Record<NativeConnectorKind, Record<string, McpToolRisk>> = {
  github: {
    create_issue: "write",
    add_issue_comment: "write",
    create_branch: "write",
    put_file: "write",
    delete_file: "destructive",
    create_pull: "write",
    update_pull: "write",
  },
  slack: { send_message: "write" },
  intercom: { reply_to_conversation: "write", send_new_message: "write" },
};

/**
 * Read / write / destructive for one tool. Native connectors use the static
 * table; MCP tools use their annotations, and a tool without annotations
 * counts as a write.
 */
export function classifyMcpToolRisk(
  tool: { name: string; annotations?: McpToolAnnotations },
  native?: NativeConnectorKind,
): McpToolRisk {
  if (native) {
    return NATIVE_TOOL_RISK[native][tool.name] ?? "read";
  }
  const annotations = tool.annotations;
  if (annotations?.readOnlyHint === true) {
    return "read";
  }
  if (annotations?.destructiveHint === true) {
    return "destructive";
  }
  return "write";
}

// ---------------------------------------------------------------------------
// Allowlist.

/** True when the policy lets this server take part in the run at all. */
export function mcpServerAllowed(policy: McpRunPolicy, serverId: string): boolean {
  return policy.allow === null || Object.prototype.hasOwnProperty.call(policy.allow, serverId);
}

/** True when the policy lets the model see and call this tool. */
export function mcpToolAllowed(policy: McpRunPolicy, serverId: string, toolName: string): boolean {
  if (policy.allow === null) {
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(policy.allow, serverId)) {
    return false;
  }
  const tools = policy.allow[serverId];
  return tools === null || tools.includes(toolName);
}

// ---------------------------------------------------------------------------
// Verdict.

export type McpPolicyVerdict =
  | { kind: "run" }
  | { kind: "confirm"; risk: Exclude<McpToolRisk, "read"> }
  | { kind: "blocked"; reason: string };

/**
 * What happens to one call: outside the allowlist → blocked; read-only, an
 * auto-run policy, or a tool the user already approved → run; otherwise the
 * user must confirm.
 */
export function mcpPolicyVerdict(
  policy: McpRunPolicy,
  approved: ReadonlySet<string>,
  serverId: string,
  tool: { name: string; annotations?: McpToolAnnotations },
  native?: NativeConnectorKind,
): McpPolicyVerdict {
  if (!mcpServerAllowed(policy, serverId)) {
    return { kind: "blocked", reason: "the server is not in this agent's allowlist" };
  }
  if (!mcpToolAllowed(policy, serverId, tool.name)) {
    return { kind: "blocked", reason: "the tool is not in this agent's allowlist" };
  }
  if (policy.writes === "auto") {
    return { kind: "run" };
  }
  const risk = classifyMcpToolRisk(tool, native);
  if (risk === "read" || approved.has(mcpApprovalKey(serverId, tool.name))) {
    return { kind: "run" };
  }
  return { kind: "confirm", risk };
}

/** The answer a confirmation card (or its timeout) produces. */
export type McpConfirmationAction = "accept" | "always" | "decline" | "cancel";

// ---------------------------------------------------------------------------
// Argument preview.

const SECRET_KEY = /(token|secret|passw|authorization|api[_-]?key|cookie|credential|private[_-]?key|session)/i;

function maskSecrets(value: unknown, depth: number): unknown {
  if (depth > 6) {
    return "…";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => maskSecrets(item, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      out[key] = SECRET_KEY.test(key) && item !== null && item !== undefined && item !== "" ? "•••" : maskSecrets(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * JSON preview of a call's arguments for the confirmation card: values under
 * secret-looking keys are masked, the caller's redaction (server credentials)
 * runs over the text, and the result is capped with an honest marker.
 */
export function previewToolArguments(
  args: Record<string, unknown>,
  redact: (text: string) => string = (text) => text,
): string {
  let text: string;
  try {
    text = Object.keys(args).length === 0 ? "{}" : JSON.stringify(maskSecrets(args, 0), null, 1);
  } catch {
    text = "{ … arguments could not be rendered … }";
  }
  text = redact(text);
  if (text.length > ARGUMENT_PREVIEW_CHARS) {
    const extra = text.length - ARGUMENT_PREVIEW_CHARS;
    text = `${text.slice(0, ARGUMENT_PREVIEW_CHARS)}\n… ${extra} more characters not shown`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Prompt wording.

/** One sentence for the system prompt so the model knows what a confirmation means for it. */
export function describeMcpWritePolicy(writes: McpWritePolicy, interactive: boolean): string {
  if (writes !== "ask") {
    return "";
  }
  return interactive
    ? "MCP policy: write and destructive tools (anything not marked read-only) pause the run for the user's confirmation before they execute — say briefly what you are about to change before calling one, and if the user declines, do not retry it."
    : "MCP policy: write and destructive tools (anything not marked read-only) need the user's confirmation, which this unattended run cannot ask for — such calls are declined and must not be retried; read-only tools run normally. Tell the user what you would have done.";
}
