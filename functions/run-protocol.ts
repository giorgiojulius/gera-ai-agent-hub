// Shared wire types for server-side agent runs. Platform-neutral on purpose:
// this module (and agent-engine.ts) must import nothing Cloudflare-specific so
// the web app's unit tests can exercise the exact engine that ships to the DO.

export type RunKind = "chat" | "research" | "julius";

export type WireAttachment = {
  name: string;
  mime: string;
  /** Data URL for images; empty for text-like files. */
  dataUrl: string;
  /** Extracted plain text for text-like files. */
  text?: string;
};

export type WireToolCall = {
  id: string;
  name: string;
  arguments: string;
  result?: string;
};

/** One thread message as the client ships it to the server run. */
export type WireMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: WireAttachment[];
  toolCalls?: WireToolCall[];
  /** Julius panel digest source (candidates replayed when no winner picked). */
  julius?: { candidates: Array<{ modelId: string; content: string }> };
};

export type ToolRecordStatus = "running" | "done" | "error";

export type RunToolRecord = {
  id: string;
  name: string;
  arguments: string;
  status: ToolRecordStatus;
  result?: string;
};

/** One file mutation captured from a repository tool call for the chat workbench. */
export type RunCodeChangeFile = {
  id: string;
  path: string;
  action: "create" | "update" | "delete" | "patch";
  status: ToolRecordStatus;
  language?: string;
  additions: number;
  deletions: number;
  /** Bounded unified-style lines; never the raw credential-bearing tool payload. */
  patch?: string;
  truncated?: boolean;
  error?: string;
};

/** A runnable preview proven by a committed HTML file or a deployment tool result. */
export type RunCodePreview =
  | { kind: "html"; label: string; html: string }
  | { kind: "url"; label: string; url: string };

export type RunCodeValidation = {
  status: "running" | "passed" | "failed" | "unknown";
  label: string;
  url?: string;
};

/** Live, persisted code-edit flow shown as Changes / Preview inside the assistant turn. */
export type RunCodeChangeState = {
  status: "running" | "done" | "error";
  files: RunCodeChangeFile[];
  startedAt: number;
  repository?: string;
  branch?: string;
  pullRequestUrl?: string;
  preview?: RunCodePreview;
  validation?: RunCodeValidation;
};

export type RunSource = { url: string; title: string };

// ---------------------------------------------------------------------------
// Autonomous execution contract (Automations + project agents).

export const EXECUTION_OUTCOME_TOOL_NAME = "gera_submit_outcome";

export type ExecutionOutcomeStatus =
  | "completed"
  | "needs_review"
  | "blocked"
  | "no_change"
  | "error";

export type ExecutionArtifactKind = "report" | "draft" | "external_object" | "code_change" | "message" | "check";

export type ExecutionArtifact = {
  id: string;
  kind: ExecutionArtifactKind;
  label: string;
  /** Kept only when it is HTTPS and corroborated by collected evidence. */
  url?: string;
};

export type ExecutionEvidenceKind = "source" | "tool_result" | "code_change" | "check" | "preview" | "delivery";

export type ExecutionEvidence = {
  id: string;
  kind: ExecutionEvidenceKind;
  label: string;
  status: "verified" | "failed";
  url?: string;
  toolName?: string;
};

export type ExecutionHandoffKind = "gera" | "requester" | "member";

export type ExecutionHandoff = {
  kind: ExecutionHandoffKind;
  ownerId?: string;
  ownerName?: string;
  nextStep: string;
  /** Required and concrete whenever outcome = blocked. */
  unblockRequest?: string;
};

export type ExecutionSignificanceKind = "none" | "change" | "risk" | "action" | "human_required";

export type ExecutionSignificance = {
  kind: ExecutionSignificanceKind;
  summary: string;
  /** The single source of truth for sound, toast, and desktop completion signals. */
  notify: boolean;
};

/** Persisted, validated result of one autonomous run. */
export type ExecutionOutcome = {
  version: 1;
  status: ExecutionOutcomeStatus;
  summary: string;
  artifacts: ExecutionArtifact[];
  evidence: ExecutionEvidence[];
  handoff: ExecutionHandoff;
  significance: ExecutionSignificance;
  validation: "verified" | "downgraded";
  validationReason?: string;
  validatedAt: number;
};

/** Model-authored claim. The backend never trusts it until evidence adapters validate it. */
export type ExecutionOutcomeClaim = {
  outcome: Exclude<ExecutionOutcomeStatus, "error">;
  summary: string;
  artifacts: Array<{ kind: ExecutionArtifactKind; label: string; url?: string }>;
  handoff: ExecutionHandoff;
  significance: { kind: ExecutionSignificanceKind; summary: string };
};

export type ExecutionToolEvidenceInput = {
  id?: string;
  name: string;
  status?: "running" | "done" | "error";
  result?: string;
};

export type BuildExecutionOutcomeInput = {
  claim?: ExecutionOutcomeClaim | null;
  content: string;
  sources?: RunSource[];
  toolCalls?: ExecutionToolEvidenceInput[];
  codeChanges?: RunCodeChangeState;
  technicalStatus: "done" | "error" | "stopped" | "interrupted";
  surface: "automation" | "project";
  requester?: { id?: string; name?: string };
  allowedMemberIds?: string[];
  error?: string;
  now?: number;
};

type ExecutionOutcomeToolDefinition = {
  type: "function";
  function: {
    name: typeof EXECUTION_OUTCOME_TOOL_NAME;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const OUTCOME_VALUES = new Set<ExecutionOutcomeClaim["outcome"]>([
  "completed",
  "needs_review",
  "blocked",
  "no_change",
]);
const ARTIFACT_VALUES = new Set<ExecutionArtifactKind>([
  "report",
  "draft",
  "external_object",
  "code_change",
  "message",
  "check",
]);
const HANDOFF_VALUES = new Set<ExecutionHandoffKind>(["gera", "requester", "member"]);
const SIGNIFICANCE_VALUES = new Set<ExecutionSignificanceKind>([
  "none",
  "change",
  "risk",
  "action",
  "human_required",
]);
const MUTATION_TOOL_PATTERN =
  /(?:^|_)(?:create|update|delete|put|post|send|reply|comment|merge|close|reopen|assign|add|remove|upload|publish|deploy|submit|write|move|rename|invite|cancel|archive|snooze|trigger)(?:_|$)/i;
const GENERIC_BLOCK_REQUEST = /^(?:(?:please\s+)?(?:need|needs|provide|send|share|give|add)\s+(?:(?:more|additional|the|some)\s+)?(?:details?|information|info|context)|(?:more|additional)\s+(?:details?|information|info|context)|(?:уточните|нужн[аоы]?|предоставьте|пришлите|дайте)(?:\s+(?:больше|дополнительн(?:ую|ые)?|нужн(?:ую|ые)?))?\s+(?:данн(?:ые|ых)|детал(?:и|ей)|информац(?:ию|ии)|контекст))[.!]?$/i;
const OUTCOME_MARKER = /<!--\s*gera[_-]outcome\s+([\s\S]*?)\s*-->/gi;

function outcomeText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function outcomeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function outcomeHttpsUrl(value: unknown): string | undefined {
  const raw = outcomeText(value, 2_000);
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function firstHttpsUrl(value: string): string | undefined {
  const matches = value.match(/https:\/\/[^\s<>()\]"']+/g) ?? [];
  for (const match of matches) {
    const clean = match.replace(/[.,;:!?]+$/u, "");
    const url = outcomeHttpsUrl(clean);
    if (url) {
      return url;
    }
  }
  return undefined;
}

function toolResultFailed(value: string): boolean {
  return /(?:^|\b)(?:failed|failure|error|unauthorized|forbidden|denied|not run|cut off|timed out|missing credential)(?:\b|:)/i.test(
    value,
  );
}

function mutationTool(name: string): boolean {
  return name === "surf_submit" || MUTATION_TOOL_PATTERN.test(name);
}

function executionLabel(name: string): string {
  return name
    .replace(/^mcp_[^_]+_/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .slice(0, 100);
}

function defaultRequester(input: BuildExecutionOutcomeInput): ExecutionHandoff {
  return {
    kind: "requester",
    ...(input.requester?.id ? { ownerId: input.requester.id.slice(0, 200) } : {}),
    ...(input.requester?.name ? { ownerName: input.requester.name.slice(0, 120) } : {}),
    nextStep: "Review the result and decide whether Gera should continue.",
  };
}

function concreteUnblockRequest(value: string): boolean {
  return value.length >= 12 && !GENERIC_BLOCK_REQUEST.test(value);
}

function contentSummary(content: string): string {
  const first = content
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-#>*]+\s*/u, "").trim())
    .find(Boolean);
  return (first ?? "Autonomous run finished.").slice(0, 240);
}

/** Structured tool the model calls after writing an autonomous deliverable. */
export function executionOutcomeToolDefinition(): ExecutionOutcomeToolDefinition {
  return {
    type: "function",
    function: {
      name: EXECUTION_OUTCOME_TOOL_NAME,
      description:
        "Submit the typed execution outcome after writing the complete user-visible deliverable. This records metadata only; it does not replace the deliverable. Call exactly once.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          outcome: { type: "string", enum: ["completed", "needs_review", "blocked", "no_change"] },
          summary: { type: "string", description: "One factual sentence describing the run result." },
          artifacts: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: {
                  type: "string",
                  enum: ["report", "draft", "external_object", "code_change", "message", "check"],
                },
                label: { type: "string" },
                url: { type: "string", description: "Real HTTPS URL returned by a tool, when one exists." },
              },
              required: ["kind", "label"],
            },
          },
          handoff: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["gera", "requester", "member"] },
              ownerId: { type: "string" },
              ownerName: { type: "string" },
              nextStep: { type: "string" },
              unblockRequest: { type: "string" },
            },
            required: ["kind", "nextStep"],
          },
          significance: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["none", "change", "risk", "action", "human_required"] },
              summary: { type: "string" },
            },
            required: ["kind", "summary"],
          },
        },
        required: ["outcome", "summary", "artifacts", "handoff", "significance"],
      },
    },
  };
}

/** Prompt shared by every autonomous engine surface. */
export function executionOutcomeSystemPrompt(mode: "tool" | "marker", surface: "automation" | "project"): string {
  const submit =
    mode === "tool"
      ? `After the complete visible deliverable, call ${EXECUTION_OUTCOME_TOOL_NAME} exactly once. Do not mention this tool in the reply.`
      : 'After the complete visible deliverable, append exactly one hidden marker: <!-- gera_outcome {"outcome":"...","summary":"...","artifacts":[{"kind":"...","label":"..."}],"handoff":{"kind":"...","nextStep":"..."},"significance":{"kind":"...","summary":"..."}} -->. Output valid one-line JSON and do not mention the marker.';
  return [
    "AUTONOMOUS EXECUTION CONTRACT:",
    "- A run is completed only when it delivered at least one named artifact and the backend can corroborate it with real delivery, source, tool, code-change, check, or preview evidence.",
    "- Use report/check for factual analysis or monitoring; those require actually consulted sources or read tools. Use draft/message for delivered writing, external_object for a real object created through a tool, and code_change for verified repository edits.",
    "- If an artifact exists but proof is insufficient, choose needs_review. If work cannot continue, choose blocked and give one concrete minimal unblockRequest (the exact access, input, or decision needed).",
    "- Choose no_change only after a real check found no material difference from prior state. Any new risk, deadline, state change, external action, required human decision, or failure is significant.",
    `- Handoff: use gera when Gera or the next schedule owns the next step; requester when the person who asked must act; member only for a specifically identified project member. ${surface === "automation" ? "A quiet no-change automation stays with Gera." : "Do not invent a member identity."}`,
    "- Never claim evidence the tools did not produce. The backend independently validates the claim and downgrades unsupported completion.",
    submit,
  ].join("\n");
}

/** Parses and caps a model claim; invalid or incomplete claims are rejected. */
export function parseExecutionOutcomeClaim(value: unknown): ExecutionOutcomeClaim | null {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const record = outcomeRecord(raw);
  if (!record || !OUTCOME_VALUES.has(record.outcome as ExecutionOutcomeClaim["outcome"])) {
    return null;
  }
  const summary = outcomeText(record.summary, 300);
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts
        .flatMap((item): ExecutionOutcomeClaim["artifacts"] => {
          const artifact = outcomeRecord(item);
          const kind = artifact?.kind as ExecutionArtifactKind;
          const label = outcomeText(artifact?.label, 160);
          if (!artifact || !ARTIFACT_VALUES.has(kind) || !label) {
            return [];
          }
          const url = outcomeHttpsUrl(artifact.url);
          return [{ kind, label, ...(url ? { url } : {}) }];
        })
        .slice(0, 4)
    : [];
  const handoffRaw = outcomeRecord(record.handoff);
  const handoffKind = handoffRaw?.kind as ExecutionHandoffKind;
  const nextStep = outcomeText(handoffRaw?.nextStep, 300);
  const significanceRaw = outcomeRecord(record.significance);
  const significanceKind = significanceRaw?.kind as ExecutionSignificanceKind;
  const significanceSummary = outcomeText(significanceRaw?.summary, 240);
  if (
    !summary ||
    artifacts.length === 0 ||
    !handoffRaw ||
    !HANDOFF_VALUES.has(handoffKind) ||
    !nextStep ||
    !significanceRaw ||
    !SIGNIFICANCE_VALUES.has(significanceKind) ||
    !significanceSummary
  ) {
    return null;
  }
  return {
    outcome: record.outcome as ExecutionOutcomeClaim["outcome"],
    summary,
    artifacts,
    handoff: {
      kind: handoffKind,
      ...(outcomeText(handoffRaw.ownerId, 200) ? { ownerId: outcomeText(handoffRaw.ownerId, 200) } : {}),
      ...(outcomeText(handoffRaw.ownerName, 120) ? { ownerName: outcomeText(handoffRaw.ownerName, 120) } : {}),
      nextStep,
      ...(outcomeText(handoffRaw.unblockRequest, 300)
        ? { unblockRequest: outcomeText(handoffRaw.unblockRequest, 300) }
        : {}),
    },
    significance: { kind: significanceKind, summary: significanceSummary },
  };
}

/** Removes the hidden research fallback marker and returns its typed claim. */
export function extractExecutionOutcomeMarker(content: string): {
  content: string;
  claim: ExecutionOutcomeClaim | null;
} {
  let claim: ExecutionOutcomeClaim | null = null;
  const clean = content.replace(OUTCOME_MARKER, (_full, json: string) => {
    const parsed = parseExecutionOutcomeClaim(json);
    if (parsed) {
      claim = parsed;
    }
    return "";
  });
  return { content: clean.trimEnd(), claim };
}

/** Outcome-tool calls are control metadata, never user-facing evidence chips. */
export function visibleExecutionToolCalls<T extends { name: string }>(calls: T[]): T[] {
  return calls.filter((call) => call.name !== EXECUTION_OUTCOME_TOOL_NAME);
}

/**
 * Strict validator: model claims choose semantics, but only objective runtime
 * records can prove artifacts and allow completed/no_change states.
 */
export function buildExecutionOutcome(input: BuildExecutionOutcomeInput): ExecutionOutcome {
  const now = input.now ?? Date.now();
  const content = input.content.trim();
  const claim = input.claim ?? null;
  const evidence: ExecutionEvidence[] = [];
  const evidenceUrls = new Set<string>();
  let evidenceId = 0;
  const pushEvidence = (entry: Omit<ExecutionEvidence, "id">): void => {
    const duplicate = evidence.some(
      (item) => item.kind === entry.kind && item.label === entry.label && item.url === entry.url && item.status === entry.status,
    );
    if (duplicate || evidence.length >= 16) {
      return;
    }
    if (entry.url) {
      evidenceUrls.add(entry.url);
    }
    evidence.push({ id: `ev_${evidenceId += 1}`, ...entry });
  };

  for (const source of input.sources ?? []) {
    const url = outcomeHttpsUrl(source.url);
    if (!url) {
      continue;
    }
    pushEvidence({ kind: "source", label: outcomeText(source.title, 160) || url, status: "verified", url });
  }

  const visibleCalls = visibleExecutionToolCalls(input.toolCalls ?? []);
  const successfulMutations: ExecutionToolEvidenceInput[] = [];
  for (const call of visibleCalls) {
    const result = outcomeText(call.result, 4_000);
    const failed = call.status === "error" || call.status === "running" || toolResultFailed(result);
    const url = firstHttpsUrl(result);
    if (!failed && mutationTool(call.name)) {
      successfulMutations.push(call);
    }
    pushEvidence({
      kind: "tool_result",
      label: `${executionLabel(call.name)}${failed ? " failed" : " completed"}`,
      status: failed ? "failed" : "verified",
      ...(url ? { url } : {}),
      toolName: call.name.slice(0, 160),
    });
  }

  let provenCodeChange = false;
  for (const file of input.codeChanges?.files ?? []) {
    provenCodeChange ||= file.status === "done";
    pushEvidence({
      kind: "code_change",
      label: `${file.status === "done" ? "Changed" : "Failed"}: ${file.path}`.slice(0, 180),
      status: file.status === "done" ? "verified" : "failed",
    });
  }
  const validation = input.codeChanges?.validation;
  if (validation && validation.status !== "running" && validation.status !== "unknown") {
    const url = outcomeHttpsUrl(validation.url);
    pushEvidence({
      kind: "check",
      label: validation.label.slice(0, 180),
      status: validation.status === "passed" ? "verified" : "failed",
      ...(url ? { url } : {}),
    });
  }
  const preview = input.codeChanges?.preview;
  if (preview) {
    const url = preview.kind === "url" ? outcomeHttpsUrl(preview.url) : undefined;
    pushEvidence({
      kind: "preview",
      label: preview.label.slice(0, 180),
      status: "verified",
      ...(url ? { url } : {}),
    });
  }
  if (input.codeChanges?.pullRequestUrl) {
    const url = outcomeHttpsUrl(input.codeChanges.pullRequestUrl);
    if (url) {
      evidenceUrls.add(url);
    }
  }
  if (content) {
    pushEvidence({ kind: "delivery", label: "Delivered in this run", status: "verified" });
  }

  const verifiedEvidence = evidence.filter((item) => item.status === "verified");
  const objectiveEvidence = verifiedEvidence.filter((item) => item.kind !== "delivery");
  const hasFailedEvidence = evidence.some((item) => item.status === "failed");
  const artifacts: ExecutionArtifact[] = [];
  if (claim) {
    for (const artifact of claim.artifacts) {
      const valid =
        artifact.kind === "draft" || artifact.kind === "message"
          ? Boolean(content)
          : artifact.kind === "report" || artifact.kind === "check"
            ? Boolean(content) && objectiveEvidence.length > 0
            : artifact.kind === "code_change"
              ? provenCodeChange
              : successfulMutations.length > 0;
      if (!valid) {
        continue;
      }
      const url = artifact.url && evidenceUrls.has(artifact.url) ? artifact.url : undefined;
      artifacts.push({
        id: `art_${artifacts.length + 1}`,
        kind: artifact.kind,
        label: artifact.label,
        ...(url ? { url } : {}),
      });
    }
  }

  const requesterHandoff = defaultRequester(input);
  let handoff: ExecutionHandoff = claim?.handoff ?? requesterHandoff;
  if (handoff.kind === "requester") {
    handoff = {
      ...handoff,
      ...(handoff.ownerId || !input.requester?.id ? {} : { ownerId: input.requester.id.slice(0, 200) }),
      ...(handoff.ownerName || !input.requester?.name ? {} : { ownerName: input.requester.name.slice(0, 120) }),
    };
  }
  if (handoff.kind === "member") {
    const allowed = new Set(input.allowedMemberIds ?? []);
    if (
      !handoff.ownerId ||
      !handoff.ownerName ||
      (input.allowedMemberIds !== undefined && !allowed.has(handoff.ownerId))
    ) {
      handoff = requesterHandoff;
    }
  }

  let status: ExecutionOutcomeStatus = claim?.outcome ?? "needs_review";
  let validationState: ExecutionOutcome["validation"] = "verified";
  let validationReason = "";
  if (input.technicalStatus !== "done") {
    status = "error";
    validationState = "downgraded";
    validationReason =
      input.error ||
      (input.technicalStatus === "stopped"
        ? "The run was stopped before the execution contract could complete."
        : input.technicalStatus === "interrupted"
          ? "The run ended before the execution contract could complete."
          : "The autonomous run failed.");
  } else if (!claim) {
    status = "needs_review";
    validationState = "downgraded";
    validationReason = "The model did not submit a valid execution contract.";
  } else if (status === "completed" && (artifacts.length === 0 || verifiedEvidence.length === 0)) {
    status = "needs_review";
    validationState = "downgraded";
    validationReason = "The claimed artifact was not corroborated by runtime evidence.";
  } else if (status === "no_change") {
    const hasCheckArtifact = artifacts.some((artifact) => artifact.kind === "check" || artifact.kind === "report");
    if (
      !hasCheckArtifact ||
      objectiveEvidence.length === 0 ||
      successfulMutations.length > 0 ||
      hasFailedEvidence ||
      claim.significance.kind !== "none"
    ) {
      status = "needs_review";
      validationState = "downgraded";
      validationReason = "A quiet no-change result needs a successful check, objective evidence, and no failed or mutating actions.";
    }
  } else if (status === "blocked") {
    if (
      handoff.kind === "gera" ||
      !handoff.unblockRequest ||
      !concreteUnblockRequest(handoff.unblockRequest)
    ) {
      status = "needs_review";
      handoff = requesterHandoff;
      validationState = "downgraded";
      validationReason = "A blocked result must name a human owner and one concrete unblock request.";
    }
  }

  if ((status === "needs_review" || status === "blocked" || status === "error") && handoff.kind === "gera") {
    handoff = requesterHandoff;
  }
  if (status === "no_change") {
    handoff = {
      kind: "gera",
      nextStep: claim?.handoff.nextStep || "Run the next scheduled check.",
    };
  }
  if (artifacts.length === 0 && content) {
    artifacts.push({
      id: "art_1",
      kind: "message",
      label: claim?.artifacts[0]?.label || "Delivered result",
    });
  }

  const summary =
    status === "error"
      ? outcomeText(input.error, 300) || claim?.summary || "The autonomous run failed."
      : claim?.summary || contentSummary(content);
  const significance: ExecutionSignificance =
    status === "no_change"
      ? { kind: "none", summary: claim?.significance.summary || "No material change found.", notify: false }
      : status === "blocked" || status === "needs_review"
        ? {
            kind: "human_required",
            summary: claim?.significance.summary || "Human input is required.",
            notify: true,
          }
        : status === "error"
          ? { kind: "risk", summary: "The autonomous run failed.", notify: true }
          : {
              kind: claim?.significance.kind === "none" ? "change" : claim?.significance.kind ?? "change",
              summary: claim?.significance.summary || "A material result is ready.",
              notify: true,
            };

  return {
    version: 1,
    status,
    summary,
    artifacts,
    evidence,
    handoff,
    significance,
    validation: validationState,
    ...(validationReason ? { validationReason } : {}),
    validatedAt: now,
  };
}

/** Distrust persisted/synced envelope metadata before rendering it. */
export function normalizeExecutionOutcome(value: unknown): ExecutionOutcome | undefined {
  const raw = outcomeRecord(value);
  if (!raw || raw.version !== 1) {
    return undefined;
  }
  const status = raw.status as ExecutionOutcomeStatus;
  if (!["completed", "needs_review", "blocked", "no_change", "error"].includes(status)) {
    return undefined;
  }
  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts.flatMap((item): ExecutionArtifact[] => {
        const artifact = outcomeRecord(item);
        const kind = artifact?.kind as ExecutionArtifactKind;
        const id = outcomeText(artifact?.id, 100);
        const label = outcomeText(artifact?.label, 160);
        if (!artifact || !id || !label || !ARTIFACT_VALUES.has(kind)) {
          return [];
        }
        const url = outcomeHttpsUrl(artifact.url);
        return [{ id, kind, label, ...(url ? { url } : {}) }];
      }).slice(0, 8)
    : [];
  const evidenceKinds = new Set<ExecutionEvidenceKind>([
    "source",
    "tool_result",
    "code_change",
    "check",
    "preview",
    "delivery",
  ]);
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.flatMap((item): ExecutionEvidence[] => {
        const entry = outcomeRecord(item);
        const kind = entry?.kind as ExecutionEvidenceKind;
        const id = outcomeText(entry?.id, 100);
        const label = outcomeText(entry?.label, 180);
        if (
          !entry ||
          !id ||
          !label ||
          !evidenceKinds.has(kind) ||
          (entry.status !== "verified" && entry.status !== "failed")
        ) {
          return [];
        }
        const url = outcomeHttpsUrl(entry.url);
        return [{
          id,
          kind,
          label,
          status: entry.status,
          ...(url ? { url } : {}),
          ...(outcomeText(entry.toolName, 160) ? { toolName: outcomeText(entry.toolName, 160) } : {}),
        }];
      }).slice(0, 24)
    : [];
  const handoffRaw = outcomeRecord(raw.handoff);
  const handoffKind = handoffRaw?.kind as ExecutionHandoffKind;
  const nextStep = outcomeText(handoffRaw?.nextStep, 300);
  const significanceRaw = outcomeRecord(raw.significance);
  const significanceKind = significanceRaw?.kind as ExecutionSignificanceKind;
  const significanceSummary = outcomeText(significanceRaw?.summary, 240);
  const summary = outcomeText(raw.summary, 300);
  if (
    !summary ||
    !handoffRaw ||
    !HANDOFF_VALUES.has(handoffKind) ||
    !nextStep ||
    !significanceRaw ||
    !SIGNIFICANCE_VALUES.has(significanceKind) ||
    !significanceSummary ||
    typeof significanceRaw.notify !== "boolean" ||
    (raw.validation !== "verified" && raw.validation !== "downgraded")
  ) {
    return undefined;
  }
  return {
    version: 1,
    status,
    summary,
    artifacts,
    evidence,
    handoff: {
      kind: handoffKind,
      ...(outcomeText(handoffRaw.ownerId, 200) ? { ownerId: outcomeText(handoffRaw.ownerId, 200) } : {}),
      ...(outcomeText(handoffRaw.ownerName, 120) ? { ownerName: outcomeText(handoffRaw.ownerName, 120) } : {}),
      nextStep,
      ...(outcomeText(handoffRaw.unblockRequest, 300)
        ? { unblockRequest: outcomeText(handoffRaw.unblockRequest, 300) }
        : {}),
    },
    significance: { kind: significanceKind, summary: significanceSummary, notify: significanceRaw.notify },
    validation: raw.validation,
    ...(outcomeText(raw.validationReason, 300) ? { validationReason: outcomeText(raw.validationReason, 300) } : {}),
    validatedAt: typeof raw.validatedAt === "number" && Number.isFinite(raw.validatedAt) ? raw.validatedAt : 0,
  };
}

/** Compact mrkdwn footer for the Slack project-agent surface. */
export function executionOutcomeSlackFooter(outcome: ExecutionOutcome): string {
  const statusLabel: Record<ExecutionOutcomeStatus, string> = {
    completed: "Ready",
    needs_review: "Needs review",
    blocked: "Blocked",
    no_change: "No material change",
    error: "Error",
  };
  const owner =
    outcome.handoff.kind === "gera"
      ? "Gera"
      : outcome.handoff.ownerName || (outcome.handoff.kind === "member" ? "Project member" : "Requester");
  const artifact = outcome.artifacts[0];
  const proofCount = outcome.evidence.filter((item) => item.status === "verified").length;
  return [
    `*Outcome · ${statusLabel[outcome.status]}* — ${outcome.summary}`,
    artifact ? `Artifact: ${artifact.url ? `<${artifact.url}|${artifact.label}>` : artifact.label}` : "",
    `Evidence: ${proofCount} verified record${proofCount === 1 ? "" : "s"}`,
    `Next: ${owner} — ${outcome.handoff.nextStep}`,
    outcome.handoff.unblockRequest ? `Needed: ${outcome.handoff.unblockRequest}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type ResearchStepKind = "plan" | "search" | "read" | "browse" | "synthesize";

export type ResearchStep = {
  id: string;
  kind: ResearchStepKind;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
};

export type ResearchState = {
  status: "running" | "done" | "error";
  steps: ResearchStep[];
  sources: RunSource[];
  startedAt: number;
  finishedAt?: number;
};

export type ResearchDepth = "eco" | "balanced" | "max";

export type JuliusDecision = "manual" | "council";

export type JuliusRunStatus =
  | "waiting"
  | "candidates"
  | "debate"
  | "synthesis"
  | "choice"
  | "done"
  | "error";

export type JuliusCandidateState = {
  id: string;
  modelId: string;
  label?: string;
  content: string;
  status: "running" | "done" | "error";
  error?: string;
  toolCalls?: RunToolRecord[];
  research?: ResearchState;
  thinking?: string;
  servedBy?: string;
};

export type JuliusReviewState = {
  role: "proponent" | "critic" | "verifier";
  modelId: string;
  content: string;
  status: "running" | "done" | "error";
  toolCalls?: RunToolRecord[];
  thinking?: string;
  servedBy?: string;
};

export type JuliusState = {
  decision: JuliusDecision;
  status: JuliusRunStatus;
  candidates: JuliusCandidateState[];
  reviews: JuliusReviewState[];
  verdict?: string;
  chairmanModelId?: string;
  chairmanServedBy?: string;
  chairmanThinking?: string;
  winner?: number;
  decidedBy?: "user" | "chairman";
  hubOpsApplied?: number[];
  sources?: RunSource[];
  startedAt: number;
  finishedAt?: number;
};

export type JuliusWireSettings = {
  candidateModelIds: string[];
  decision: JuliusDecision;
  proponentModelId: string;
  criticModelId: string;
  verifierModelId: string;
  chairmanModelId: string;
};

export type BuiltinToolId =
  | "web_search"
  | "fetch_url"
  | "selfsurf"
  | "generate_image"
  | "generate_video"
  | "generate_audio";

/** One steering item handed to a live run. */
export type RunSteerItem = {
  id: string;
  text: string;
  attachments: WireAttachment[];
};

/** MCP server config as the client ships it (mirrors the profile blob shape). */
export type WireMcpServer = Record<string, unknown>;

export type StartRunConfig = {
  systemPrompt?: string;
  history: WireMessage[];
  prompt: string;
  builtins: Record<BuiltinToolId, boolean>;
  mcpServers: WireMcpServer[];
  /** Thread-pinned owner/repo; server modes treat it as the structured default. */
  githubRepo?: string;
  grounding?: { block: string; sources: RunSource[] };
  steeringWrapNote?: string;
  /** Resume: continue an existing assistant message instead of appending. */
  resume?: { messageId: string; partial: string };
  research?: {
    depth: ResearchDepth;
    citations?: "numeric" | "links";
    githubAuth?: string;
    githubDisabledTools?: string[];
  };
  julius?: { settings: JuliusWireSettings; research?: boolean };
  /** Incognito threads: the run never writes into server chat history. */
  ephemeral?: boolean;
};

export type StartRunBody = {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  kind: RunKind;
  title: string;
  /** Model selection id (may carry :effort suffix). */
  modelId: string;
  agentId?: string;
  automationId?: string;
  /** Serialized conversation INCLUDING the new user message (no pending bubble). */
  chatSeed?: { payload: string; updatedAt: number };
  config: StartRunConfig;
};

export type RunUsageEvent = {
  modelId: string;
  usage: unknown;
  /** True for internal helper calls (research planner) — excluded from model standings. */
  service?: boolean;
};

/** Cloud media reference stored in chat messages: gera-cloud:v1:<runId>:<idx>. */
export const CLOUD_MEDIA_PREFIX = "gera-cloud:v1:";

export function cloudMediaRef(runId: string, index: number): string {
  return `${CLOUD_MEDIA_PREFIX}${runId}:${index}`;
}

export function parseCloudMediaRef(ref: string): { runId: string; index: number } | null {
  if (!ref.startsWith(CLOUD_MEDIA_PREFIX)) {
    return null;
  }
  const rest = ref.slice(CLOUD_MEDIA_PREFIX.length);
  const split = rest.lastIndexOf(":");
  if (split <= 0) {
    return null;
  }
  const rawIndex = rest.slice(split + 1);
  if (!/^\d+$/.test(rawIndex)) {
    return null;
  }
  return { runId: rest.slice(0, split), index: Number(rawIndex) };
}

/** Final assistant message payload produced by a settled run. */
export type RunFinalMessage = {
  id: string;
  content: string;
  toolCalls?: RunToolRecord[];
  codeChanges?: RunCodeChangeState;
  /** Strict, evidence-backed result for Automations; absent on ordinary chat in v1. */
  execution?: ExecutionOutcome;
  sources?: RunSource[];
  servedBy?: string;
  research?: ResearchState;
  julius?: JuliusState;
  /** Cloud media refs (resolve via /runs/media). */
  images?: string[];
  videos?: string[];
  audioUrl?: string;
  interrupted?: boolean;
};

export type RunStatus = "running" | "done" | "stopped" | "interrupted" | "error";

export type RunSnapshot = {
  runId: string;
  conversationId: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: number;
  /** Streamed text as currently shown (steering base already stitched in). */
  content: string;
  reasoningTail?: string;
  toolCalls?: RunToolRecord[];
  codeChanges?: RunCodeChangeState;
  sources?: RunSource[];
  research?: ResearchState;
  julius?: JuliusState;
  /** Steer items already woven into the live context, in consumption order. */
  steered?: RunSteerItem[];
  error?: string;
};

/** Server → client live events over the run stream. */
export type RunEvent =
  | { t: "snapshot"; seq: number; snapshot: RunSnapshot }
  | { t: "text"; seq: number; content: string }
  | { t: "reasoning"; seq: number; tail: string }
  | { t: "tools"; seq: number; toolCalls: RunToolRecord[] }
  | { t: "code"; seq: number; codeChanges: RunCodeChangeState }
  | { t: "sources"; seq: number; sources: RunSource[] }
  | { t: "research"; seq: number; research: ResearchState }
  | { t: "julius"; seq: number; julius: JuliusState; sources?: RunSource[] }
  | { t: "steered"; seq: number; items: RunSteerItem[] }
  | {
      t: "done";
      seq: number;
      status: Exclude<RunStatus, "running">;
      message: RunFinalMessage;
      usageEvents: RunUsageEvent[];
      steered: RunSteerItem[];
      chatUpdatedAt: number;
      error?: string;
    }
  | { t: "ping"; seq: number };
