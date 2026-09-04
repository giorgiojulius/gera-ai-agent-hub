// MCP policy journal — every confirmed, approved, declined, timed-out or
// blocked tool call becomes a row in the account's diagnostics journal (the
// same `diagnostics` table the browser's error journal syncs to), so the
// Diagnostics dialog shows what the agent was allowed to do and what it was
// not. Rows name the server, the tool, the decision and the reason — never
// an argument value.
//
// Interactive and automation runs live in the account shard and append
// directly; project agents post to the linking owner's shard through the
// internal `/diag/append` route.

import { DIAG_DETAIL_LIMIT, DIAG_MESSAGE_LIMIT, DIAG_ROWS_LIMIT, type ChatSql } from "./chat-shared";
import type { McpToolsetJournalEntry } from "./mcp-toolset";
import { chatShardId } from "./shard-migration";

/** Scope of policy rows; the browser badge treats them as an audit trail, not errors. */
export const MCP_POLICY_SCOPE = "mcp-policy";
/** Scope of protocol-side records (elicitation declined / timed out / invalid). */
export const MCP_PROTOCOL_SCOPE = "mcp";

export type McpJournalRow = {
  id: string;
  at: number;
  scope: string;
  message: string;
  detail: string;
};

export type McpJournalContext = {
  /** Where the run happened, for the detail line. */
  surface: "chat" | "research" | "automation" | "project" | "slack" | "screen";
  /** Thread title, automation name, agent name… */
  label?: string;
};

const POLICY_KINDS = new Set<McpToolsetJournalEntry["kind"]>([
  "confirmation_granted",
  "confirmation_always",
  "confirmation_declined",
  "confirmation_timeout",
  "policy_blocked",
]);

const ELICITATION_KINDS = new Set<McpToolsetJournalEntry["kind"]>([
  "elicitation_declined",
  "elicitation_timeout",
  "elicitation_invalid",
]);

/** True for the decisions the policy journal records. */
export function isPolicyJournalKind(kind: McpToolsetJournalEntry["kind"]): boolean {
  return POLICY_KINDS.has(kind);
}

function decisionLabel(kind: McpToolsetJournalEntry["kind"]): string {
  switch (kind) {
    case "confirmation_granted":
      return "Confirmed once";
    case "confirmation_always":
      return "Always allowed in this chat";
    case "confirmation_declined":
      return "Declined";
    case "confirmation_timeout":
      return "Timed out";
    case "policy_blocked":
      return "Blocked by allowlist";
    case "elicitation_declined":
      return "Elicitation declined";
    case "elicitation_timeout":
      return "Elicitation timed out";
    case "elicitation_invalid":
      return "Elicitation answer invalid";
    default:
      return "";
  }
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function newRowId(): string {
  return `mcpj_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * One journal row for a toolset entry, or null for entries that are not
 * journal material (catalog refreshes, step-ups — those have their own
 * surfaces). The message names the decision, tool and server; the detail
 * carries the honest reason and where it happened.
 */
export function mcpJournalRow(
  entry: McpToolsetJournalEntry,
  context: McpJournalContext,
  now: number = Date.now(),
): McpJournalRow | null {
  const policy = POLICY_KINDS.has(entry.kind);
  if (!policy && !ELICITATION_KINDS.has(entry.kind)) {
    return null;
  }
  const decision = decisionLabel(entry.kind);
  const subject = entry.toolName ? `${entry.toolName} on ${entry.serverName}` : entry.serverName;
  const where = `${context.surface}${context.label ? ` · ${cap(context.label, 80)}` : ""}`;
  return {
    id: newRowId(),
    at: now,
    scope: policy ? MCP_POLICY_SCOPE : MCP_PROTOCOL_SCOPE,
    message: cap(`${decision}: ${subject}`, DIAG_MESSAGE_LIMIT),
    detail: cap(
      [`server: ${entry.serverId}`, ...(entry.toolName ? [`tool: ${entry.toolName}`] : []), `run: ${where}`, entry.detail].join("\n"),
      DIAG_DETAIL_LIMIT,
    ),
  };
}

/**
 * Appends rows to this shard's account journal (RunManager and ChatStore
 * share the storage, so both use this). Ring semantics like `/diag/append`:
 * only the newest rows survive.
 */
export function appendMcpJournal(sql: ChatSql, owner: string, rows: McpJournalRow[]): void {
  if (rows.length === 0) {
    return;
  }
  try {
    for (const row of rows) {
      sql.exec(
        "INSERT OR IGNORE INTO diagnostics (owner_email, id, at, scope, message, detail) VALUES (?, ?, ?, ?, ?, ?)",
        owner,
        row.id,
        row.at,
        row.scope,
        row.message,
        row.detail,
      );
    }
    sql.exec(
      `DELETE FROM diagnostics WHERE owner_email = ? AND id NOT IN (
        SELECT id FROM diagnostics WHERE owner_email = ? ORDER BY at DESC LIMIT ${DIAG_ROWS_LIMIT}
      )`,
      owner,
      owner,
    );
  } catch (error) {
    // A journal fault never breaks the run.
    console.error("mcp journal append failed:", error instanceof Error ? error.message : "unknown");
  }
}

/**
 * Posts rows to another account's shard (project agents → the admin whose
 * account the servers are linked through). Best effort; failures are logged
 * without detail and never affect the run.
 */
export async function postMcpJournal(
  doBinding: { fetch(request: Request): Promise<Response> } | undefined,
  owner: string,
  rows: McpJournalRow[],
): Promise<void> {
  if (!doBinding || rows.length === 0 || !owner) {
    return;
  }
  try {
    const response = await doBinding.fetch(
      new Request("https://gera.internal/diag/append", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rork-DO-Class": "ChatStore",
          "X-Rork-DO-Id": chatShardId(owner),
          "X-Gera-Email": encodeURIComponent(owner),
        },
        body: JSON.stringify({ entries: rows }),
      }),
    );
    if (!response.ok) {
      console.error("mcp journal post failed:", response.status);
    }
  } catch (error) {
    console.error("mcp journal post failed:", error instanceof Error ? error.message : "unknown");
  }
}
