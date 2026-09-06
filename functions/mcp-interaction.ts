import { classifyMcpAuthRejection, describeStepUp } from "./mcp-auth-challenge";
import { CONFIRMATION_TIMEOUT_MS, mcpApprovalKey, mcpPolicyVerdict, previewToolArguments, type McpRunPolicy, type NativeConnectorKind } from "./mcp-policy";
import { redactCloudMcpText } from "./mcp-cloud";
import { JSON_RPC_INVALID_PARAMS, JSON_RPC_METHOD_NOT_FOUND, McpAuthRejectedError, normalizeElicitationRequest, validateElicitationContent, type McpElicitationAnswer, type McpServerRequest, type McpServerRequestReply, type McpToolAnnotations } from "./mcp-protocol";
import type { McpServerState } from "./mcp-lazy-connect";
import type { ResolveMcpToolsetOptions, McpConfirmationAnswer, McpToolOutcome, McpToolsetJournalEntry } from "./mcp-toolset";

export const ELICITATION_TIMEOUT_MS = 5 * 60_000;
function withTimeout<T>(task: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    task.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(onTimeout()); });
  });
}
/** Policy, step-up, and elicitation handlers shared by native and deferred dispatch. */
export function createMcpInteraction(options: ResolveMcpToolsetOptions, policy: McpRunPolicy) {
  const approved = new Set<string>((policy.approved ?? []).map((item) => mcpApprovalKey(item.serverId, item.toolName)));
  const journal: McpToolsetJournalEntry[] = [];
  const note = (entry: McpToolsetJournalEntry): void => { journal.push(entry); options.onJournal?.(entry); };
  const gate = async (
    server: { id: string; name: string }, tool: { name: string; description?: string; annotations?: McpToolAnnotations },
    native: NativeConnectorKind | undefined, args: Record<string, unknown>, redactions: string[],
  ): Promise<McpToolOutcome | null> => {
    const verdict = mcpPolicyVerdict(policy, approved, server.id, tool, native);
    if (verdict.kind === "run") return null;
    const base = { serverId: server.id, serverName: server.name, toolName: tool.name };
    if (verdict.kind === "blocked") {
      note({ kind: "policy_blocked", ...base, detail: `Not run: ${verdict.reason}.` });
      return { text: `Tool "${tool.name}" on "${server.name}" is not allowed by this agent's MCP policy (${verdict.reason}). Do not retry it.`, isError: true };
    }
    const label = verdict.risk === "destructive" ? "destructive" : "write";
    if (!options.confirm) {
      note({ kind: "confirmation_declined", ...base, detail: `${label} tool needs the user's confirmation; this unattended run cannot ask, so the call was declined.` });
      return { text: `Tool "${tool.name}" on "${server.name}" is a ${label} tool and this run's MCP policy requires the user's confirmation before it runs. This unattended run cannot ask, so the call was declined — do not retry it; tell the user what you wanted to do so they can run it from chat or switch the policy to auto-run.`, isError: true };
    }
    const answer = await withTimeout<McpConfirmationAnswer | { action: "timeout" }>(options.confirm({ ...base, risk: verdict.risk, description: (tool.description ?? "").slice(0, 400), argumentsPreview: previewToolArguments(args, (text) => redactCloudMcpText(text, redactions)) }), CONFIRMATION_TIMEOUT_MS, () => ({ action: "timeout" }));
    switch (answer.action) {
      case "accept": note({ kind: "confirmation_granted", ...base, detail: `The user confirmed this ${label} call once.` }); return null;
      case "always": approved.add(mcpApprovalKey(server.id, tool.name)); note({ kind: "confirmation_always", ...base, detail: `The user allowed this ${label} tool for the rest of the chat.` }); return null;
      case "timeout":
        note({ kind: "confirmation_timeout", ...base, detail: "No decision within 10 minutes; the call was declined." });
        return { text: `No decision on running "${tool.name}" on "${server.name}" arrived within 10 minutes, so the call was declined. Do not retry it; ask the user how to proceed.`, isError: true };
      default:
        note({ kind: "confirmation_declined", ...base, detail: `The user declined this ${label} call.` });
        return { text: `The user declined running "${tool.name}" on "${server.name}". Do not retry it; ask the user how to proceed.`, isError: true };
    }
  };
  const parkForStepUp = async (state: McpServerState, error: unknown): Promise<string | null> => {
    if (!(error instanceof McpAuthRejectedError)) return null;
    const rejection = classifyMcpAuthRejection(error.status, error.wwwAuthenticate);
    if (rejection.kind !== "step_up") return null;
    const server = state.server;
    const text = describeStepUp(server.name, rejection.scopes);
    state.stepUp = { scopes: rejection.scopes, code: rejection.code };
    state.failure = text; state.session = null; state.stream?.close(); state.stream = null;
    note({ kind: "step_up_required", serverId: server.id, serverName: server.name, detail: text });
    await options.reportFailure?.(server.id, { ok: false, status: error.status, code: rejection.code, ...(rejection.description ? { detail: rejection.description.slice(0, 300) } : {}), transient: false, ambiguous: false, requiredScopes: rejection.scopes });
    return text;
  };
  const serverRequestHandler = (state: McpServerState) => async (request: McpServerRequest): Promise<McpServerRequestReply> => {
    const server = state.server;
    if (request.method === "elicitation/create") {
      const parsed = normalizeElicitationRequest(request.params);
      if (!parsed) return { error: { code: JSON_RPC_INVALID_PARAMS, message: "elicitation/create params were not understood" } };
      if (parsed.mode === "url") {
        note({ kind: "elicitation_declined", serverId: server.id, serverName: server.name, detail: "URL-mode elicitation is not supported by Gera; declined." });
        return { result: { action: "decline" } };
      }
      if (!options.elicit) {
        note({ kind: "elicitation_declined", serverId: server.id, serverName: server.name, detail: `Server asked for input (“${parsed.message.slice(0, 120)}”); this run cannot ask the user, so it declined.` });
        return { result: { action: "decline" } };
      }
      const answer = await withTimeout(options.elicit({ ...parsed, serverId: server.id, serverName: server.name }), ELICITATION_TIMEOUT_MS, (): McpElicitationAnswer => {
        note({ kind: "elicitation_timeout", serverId: server.id, serverName: server.name, detail: "No answer within 5 minutes; cancelled." });
        return { action: "cancel" };
      });
      if (answer.action !== "accept") return { result: { action: answer.action } };
      const valid = validateElicitationContent(parsed, answer.content ?? {});
      if (valid.ok === false) {
        note({ kind: "elicitation_invalid", serverId: server.id, serverName: server.name, detail: valid.errors.join("; ") });
        return { result: { action: "cancel" } };
      }
      return { result: { action: "accept", content: valid.content } };
    }
    if (request.method === "roots/list") return { result: { roots: [] } };
    if (request.method === "sampling/createMessage") return { error: { code: JSON_RPC_METHOD_NOT_FOUND, message: "Gera does not offer sampling to servers" } };
    return { error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Unsupported request ${request.method}` } };
  };
  return { journal, note, gate, parkForStepUp, serverRequestHandler };
}
