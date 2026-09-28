import { afterEach, describe, expect, it, vi } from "vitest";

import { runAutomationJob, type ClaimJob } from "../../../functions/automation-runner";
import {
  buildExecutionOutcome,
  EXECUTION_OUTCOME_TOOL_NAME,
  executionOutcomeSlackFooter,
  extractExecutionOutcomeMarker,
  parseExecutionOutcomeClaim,
  type ExecutionOutcomeClaim,
} from "../../../functions/run-protocol";
import { normalizeExecutionOutcome, shouldSignalExecution } from "@/lib/execution-outcome";

function claim(overrides: Partial<ExecutionOutcomeClaim> = {}): ExecutionOutcomeClaim {
  return {
    outcome: "completed",
    summary: "A verified result is ready.",
    artifacts: [{ kind: "report", label: "Release report" }],
    handoff: { kind: "gera", nextStep: "Continue on the next scheduled run." },
    significance: { kind: "change", summary: "The tracked state changed." },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("autonomous execution outcome", () => {
  it("allows a sourced report to complete", () => {
    const outcome = buildExecutionOutcome({
      claim: claim(),
      content: "The release moved to production [1].",
      sources: [{ url: "https://status.example.com/release", title: "Release status" }],
      technicalStatus: "done",
      surface: "automation",
      now: 10,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.validation).toBe("verified");
    expect(outcome.artifacts).toEqual([{ id: "art_1", kind: "report", label: "Release report" }]);
    expect(outcome.evidence.map((item) => item.kind)).toEqual(["source", "delivery"]);
    expect(shouldSignalExecution(outcome)).toBe(true);
  });

  it("accepts delivered writing as its own artifact without pretending it is sourced analysis", () => {
    const outcome = buildExecutionOutcome({
      claim: claim({
        artifacts: [{ kind: "draft", label: "Customer reply draft" }],
        significance: { kind: "action", summary: "A requested draft is ready." },
      }),
      content: "Hi Sam — thanks for reporting this.",
      technicalStatus: "done",
      surface: "project",
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.evidence).toHaveLength(1);
    expect(outcome.evidence[0].kind).toBe("delivery");
  });

  it("downgrades unsupported completion instead of trusting the model", () => {
    const outcome = buildExecutionOutcome({
      claim: claim(),
      content: "An unsourced factual report.",
      technicalStatus: "done",
      surface: "automation",
    });

    expect(outcome.status).toBe("needs_review");
    expect(outcome.validation).toBe("downgraded");
    expect(outcome.validationReason).toContain("not corroborated");
    expect(outcome.significance.notify).toBe(true);
  });

  it("validates a concrete blocked handoff and rejects a vague one", () => {
    const blocked = claim({
      outcome: "blocked",
      summary: "GitHub access is missing.",
      artifacts: [{ kind: "message", label: "Access diagnostic" }],
      handoff: {
        kind: "requester",
        ownerId: "owner@example.com",
        ownerName: "Owner",
        nextStep: "Connect the repository credential.",
        unblockRequest: "Connect the acme/private-app repository with Contents read permission.",
      },
      significance: { kind: "human_required", summary: "Repository access is required." },
    });
    const valid = buildExecutionOutcome({
      claim: blocked,
      content: "GitHub access is missing.",
      technicalStatus: "done",
      surface: "project",
      requester: { id: "owner@example.com", name: "Owner" },
    });
    const vague = buildExecutionOutcome({
      claim: claim({
        ...blocked,
        handoff: { ...blocked.handoff, unblockRequest: "Need more information" },
      }),
      content: "Blocked.",
      technicalStatus: "done",
      surface: "project",
      requester: { id: "owner@example.com", name: "Owner" },
    });

    expect(valid.status).toBe("blocked");
    expect(valid.handoff.unblockRequest).toContain("Contents read permission");
    expect(vague.status).toBe("needs_review");
    expect(vague.handoff.kind).toBe("requester");
  });

  it("keeps a proven no-change check quiet", () => {
    const outcome = buildExecutionOutcome({
      claim: claim({
        outcome: "no_change",
        summary: "No material release change was found.",
        artifacts: [{ kind: "check", label: "Release monitor check" }],
        handoff: { kind: "gera", nextStep: "Check again tomorrow." },
        significance: { kind: "none", summary: "No material change found." },
      }),
      content: "Checked the release feed; no material change.",
      toolCalls: [{ name: "github_list_releases", status: "done", result: "Latest: v2.1" }],
      technicalStatus: "done",
      surface: "automation",
    });

    expect(outcome.status).toBe("no_change");
    expect(outcome.handoff.kind).toBe("gera");
    expect(outcome.significance.notify).toBe(false);
    expect(shouldSignalExecution(outcome)).toBe(false);
  });

  it("refuses to silence a failed or mutating check", () => {
    const quietClaim = claim({
      outcome: "no_change",
      summary: "No material change.",
      artifacts: [{ kind: "check", label: "Monitor check" }],
      handoff: { kind: "gera", nextStep: "Check again later." },
      significance: { kind: "none", summary: "No material change found." },
    });
    const failed = buildExecutionOutcome({
      claim: quietClaim,
      content: "No change.",
      toolCalls: [{ name: "fetch_url", status: "error", result: "Fetch failed (503)." }],
      technicalStatus: "done",
      surface: "automation",
    });
    const mutated = buildExecutionOutcome({
      claim: quietClaim,
      content: "No change.",
      toolCalls: [{ name: "github_create_issue", status: "done", result: "Created #42" }],
      technicalStatus: "done",
      surface: "automation",
    });

    expect(failed.status).toBe("needs_review");
    expect(mutated.status).toBe("needs_review");
    expect(shouldSignalExecution(failed)).toBe(true);
    expect(shouldSignalExecution(mutated)).toBe(true);
  });

  it("never reports an interrupted technical run as complete", () => {
    const outcome = buildExecutionOutcome({
      claim: claim({ artifacts: [{ kind: "draft", label: "Partial draft" }] }),
      content: "Partial output",
      technicalStatus: "interrupted",
      surface: "automation",
      error: "Worker restarted.",
    });

    expect(outcome.status).toBe("error");
    expect(outcome.validation).toBe("downgraded");
    expect(outcome.significance.notify).toBe(true);
  });

  it("extracts the hidden research marker without leaking it into content", () => {
    const payload = claim({
      outcome: "no_change",
      artifacts: [{ kind: "check", label: "Daily check" }],
      significance: { kind: "none", summary: "Nothing material changed." },
    });
    const extracted = extractExecutionOutcomeMarker(
      `Visible report.\n\n<!-- gera_outcome ${JSON.stringify(payload)} -->`,
    );

    expect(extracted.content).toBe("Visible report.");
    expect(extracted.claim).toEqual(payload);
    expect(parseExecutionOutcomeClaim(JSON.stringify(payload))).toEqual(payload);
  });

  it("normalizes synced metadata and formats the Slack footer", () => {
    const outcome = buildExecutionOutcome({
      claim: claim({ artifacts: [{ kind: "draft", label: "Reply draft" }] }),
      content: "Draft",
      technicalStatus: "done",
      surface: "project",
      now: 99,
    });
    const normalized = normalizeExecutionOutcome(JSON.parse(JSON.stringify(outcome)) as unknown);

    expect(normalized).toEqual(outcome);
    expect(executionOutcomeSlackFooter(outcome)).toContain("*Outcome · Ready*");
    expect(executionOutcomeSlackFooter(outcome)).toContain("Next: Gera");
    expect(normalizeExecutionOutcome({ ...outcome, version: 2 })).toBeUndefined();
  });
});

describe("cloud automation runner contract", () => {
  it("captures the outcome tool separately from evidence and validates the delivered artifact", async () => {
    const submitted = claim({
      artifacts: [{ kind: "draft", label: "Prepared announcement" }],
      significance: { kind: "action", summary: "A requested announcement is ready." },
    });
    let gatewayCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // The runner first reads the model catalog (model-line upgrade); unreachable → pick unchanged.
      if (String(input).endsWith("/v1/models")) {
        return new Response("{}", { status: 503 });
      }
      gatewayCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      if (gatewayCalls === 1) {
        expect(body.messages?.[0]?.content).toContain("AUTONOMOUS EXECUTION CONTRACT");
        expect(body.tools?.some((tool) => tool.function?.name === EXECUTION_OUTCOME_TOOL_NAME)).toBe(true);
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "The announcement draft is ready.",
                tool_calls: [{
                  id: "outcome_1",
                  type: "function",
                  function: { name: EXECUTION_OUTCOME_TOOL_NAME, arguments: JSON.stringify(submitted) },
                }],
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const job: ClaimJob = {
      owner: "owner@example.com",
      automationId: "auto_1",
      conversationId: "chat_1",
      name: "Announcement",
      prompt: "Draft an announcement",
      modelId: "spacexai/grok-4.6:xhigh",
      systemPrompt: "",
      agentId: null,
      memories: [],
      knowledge: "",
      prior: [],
      mcpServers: [],
    };
    const result = await runAutomationJob(job, "test-key");

    expect(result.content).toBe("The announcement draft is ready.");
    expect(result.execution.status).toBe("completed");
    expect(result.toolCalls).toEqual([]);
    expect(gatewayCalls).toBe(2);
  });
});
