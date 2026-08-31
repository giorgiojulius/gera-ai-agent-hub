import type {
  ExecutionArtifact,
  ExecutionArtifactKind,
  ExecutionEvidence,
  ExecutionEvidenceKind,
  ExecutionHandoffKind,
  ExecutionOutcome,
  ExecutionOutcomeStatus,
  ExecutionSignificanceKind,
} from "@/lib/types";

const STATUSES = new Set<ExecutionOutcomeStatus>([
  "completed",
  "needs_review",
  "blocked",
  "no_change",
  "error",
]);
const ARTIFACT_KINDS = new Set<ExecutionArtifactKind>([
  "report",
  "draft",
  "external_object",
  "code_change",
  "message",
  "check",
]);
const EVIDENCE_KINDS = new Set<ExecutionEvidenceKind>([
  "source",
  "tool_result",
  "code_change",
  "check",
  "preview",
  "delivery",
]);
const HANDOFF_KINDS = new Set<ExecutionHandoffKind>(["gera", "requester", "member"]);
const SIGNIFICANCE_KINDS = new Set<ExecutionSignificanceKind>([
  "none",
  "change",
  "risk",
  "action",
  "human_required",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function httpsUrl(value: unknown): string | undefined {
  const raw = text(value, 2_000);
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

/** Distrust cloud/project wires before rendering autonomous outcome metadata. */
export function normalizeExecutionOutcome(value: unknown): ExecutionOutcome | undefined {
  const raw = record(value);
  const status = raw?.status as ExecutionOutcomeStatus;
  if (!raw || raw.version !== 1 || !STATUSES.has(status)) {
    return undefined;
  }
  const summary = text(raw.summary, 300);
  const handoffRaw = record(raw.handoff);
  const handoffKind = handoffRaw?.kind as ExecutionHandoffKind;
  const nextStep = text(handoffRaw?.nextStep, 300);
  const significanceRaw = record(raw.significance);
  const significanceKind = significanceRaw?.kind as ExecutionSignificanceKind;
  const significanceSummary = text(significanceRaw?.summary, 240);
  if (
    !summary ||
    !handoffRaw ||
    !HANDOFF_KINDS.has(handoffKind) ||
    !nextStep ||
    !significanceRaw ||
    !SIGNIFICANCE_KINDS.has(significanceKind) ||
    !significanceSummary ||
    typeof significanceRaw.notify !== "boolean" ||
    (raw.validation !== "verified" && raw.validation !== "downgraded")
  ) {
    return undefined;
  }
  const artifacts: ExecutionArtifact[] = Array.isArray(raw.artifacts)
    ? raw.artifacts.flatMap((value): ExecutionArtifact[] => {
        const item = record(value);
        const id = text(item?.id, 100);
        const label = text(item?.label, 160);
        const kind = item?.kind as ExecutionArtifactKind;
        if (!item || !id || !label || !ARTIFACT_KINDS.has(kind)) {
          return [];
        }
        const url = httpsUrl(item.url);
        return [{ id, kind, label, ...(url ? { url } : {}) }];
      }).slice(0, 8)
    : [];
  const evidence: ExecutionEvidence[] = Array.isArray(raw.evidence)
    ? raw.evidence.flatMap((value): ExecutionEvidence[] => {
        const item = record(value);
        const id = text(item?.id, 100);
        const label = text(item?.label, 180);
        const kind = item?.kind as ExecutionEvidenceKind;
        if (
          !item ||
          !id ||
          !label ||
          !EVIDENCE_KINDS.has(kind) ||
          (item.status !== "verified" && item.status !== "failed")
        ) {
          return [];
        }
        const url = httpsUrl(item.url);
        const toolName = text(item.toolName, 160);
        return [{
          id,
          kind,
          label,
          status: item.status,
          ...(url ? { url } : {}),
          ...(toolName ? { toolName } : {}),
        }];
      }).slice(0, 24)
    : [];
  const ownerId = text(handoffRaw.ownerId, 200);
  const ownerName = text(handoffRaw.ownerName, 120);
  const unblockRequest = text(handoffRaw.unblockRequest, 300);
  const validationReason = text(raw.validationReason, 300);
  return {
    version: 1,
    status,
    summary,
    artifacts,
    evidence,
    handoff: {
      kind: handoffKind,
      ...(ownerId ? { ownerId } : {}),
      ...(ownerName ? { ownerName } : {}),
      nextStep,
      ...(unblockRequest ? { unblockRequest } : {}),
    },
    significance: {
      kind: significanceKind,
      summary: significanceSummary,
      notify: significanceRaw.notify,
    },
    validation: raw.validation,
    ...(validationReason ? { validationReason } : {}),
    validatedAt: typeof raw.validatedAt === "number" && Number.isFinite(raw.validatedAt) ? raw.validatedAt : 0,
  };
}

/** Missing metadata keeps legacy behavior; only validated quiet outcomes suppress signals. */
export function shouldSignalExecution(outcome: ExecutionOutcome | undefined): boolean {
  return outcome?.significance.notify !== false;
}
