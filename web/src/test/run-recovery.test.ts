import { afterEach, describe, expect, it, vi } from "vitest";

// A server run must survive the node it runs on. Durable Objects are evicted
// after 70–140 s without incoming traffic (a pending waitUntil or a plain
// fetch() does not keep them alive) and every deploy kills them — the exact
// shape of the reported "Deep research · Stopped · 267 sources / No reply is
// available" turn. These tests pin the recovery contract: the start body is
// stored without credentials, a dead chat run resumes with its draft as the
// base, a dead research run continues from its last checkpoint instead of
// re-searching, and every refusal names its reason.
import {
  CHECKPOINT_PAYLOAD_LIMIT,
  decideRecovery,
  MAX_RUN_RESTARTS,
  parseResearchCheckpoint,
  parseStoredSeed,
  recoveredToolCalls,
  RESTART_TOOL_RESULT,
  resumeChatBody,
  SEED_PAYLOAD_LIMIT,
  seedForStorage,
  SERVER_RESUME_NOTE,
  staleRunError,
  trimResearchCheckpoint,
  type ResearchCheckpoint,
} from "../../../functions/run-recovery";
import { runServerDeepResearch } from "../../../functions/research-runner";
import type { ResearchState, RunSnapshot, StartRunBody } from "../../../functions/run-protocol";

function startBody(overrides: Partial<StartRunBody["config"]> = {}): StartRunBody {
  return {
    runId: "run_1",
    conversationId: "conv_1",
    assistantMessageId: "asst_1",
    kind: "chat",
    title: "Chat",
    modelId: "openai/gpt-6-astra:xhigh",
    chatSeed: { payload: JSON.stringify({ id: "conv_1", messages: [] }), updatedAt: 10 },
    config: {
      history: [{ role: "user", content: "write the report" }],
      prompt: "write the report",
      builtins: {} as never,
      mcpServers: [
        { id: "github", catalogId: "github", token: "ghp_secret", headersJson: "{\"Authorization\":\"x\"}", enabled: true },
        { id: "notion", accessToken: "secret-access", refreshToken: "secret-refresh", clientSecret: "cs", url: "https://n.test" },
      ],
      research: { depth: "max", citations: "numeric", githubAuth: "Bearer ghp_secret" },
      grounding: { block: "grounding block", sources: [{ url: "https://g.test", title: "G" }] },
      ...overrides,
    },
  };
}

describe("seedForStorage", () => {
  it("keeps what a restart needs and never a credential or the chat seed", () => {
    const json = seedForStorage(startBody());
    expect(json).not.toBeNull();
    expect(json).not.toContain("ghp_secret");
    expect(json).not.toContain("secret-access");
    expect(json).not.toContain("secret-refresh");
    expect(json).not.toContain("\"clientSecret\"");
    expect(json).not.toContain("chatSeed");
    const parsed = parseStoredSeed(json ?? "");
    expect(parsed?.config.mcpServers).toEqual([
      { id: "github", catalogId: "github", enabled: true },
      { id: "notion", url: "https://n.test" },
    ]);
    expect(parsed?.config.research).toEqual({ depth: "max", citations: "numeric" });
    expect(parsed?.config.history).toEqual([{ role: "user", content: "write the report" }]);
    expect(parsed?.modelId).toBe("openai/gpt-6-astra:xhigh");
  });

  it("stores nothing for an incognito run", () => {
    expect(seedForStorage(startBody({ ephemeral: true }))).toBeNull();
  });

  it("drops inline media, then the grounding block, before giving up on an oversized body", () => {
    const big = "x".repeat(400_000);
    const body = startBody({
      history: [
        { role: "user", content: "see", attachments: [{ name: "a.png", mime: "image/png", dataUrl: `data:image/png;base64,${big}` }] },
      ],
    });
    // Fits as-is: nothing is touched.
    expect(seedForStorage(body, 500_000)).toContain("data:image/png;base64,");
    // Too big with the image: the image goes, the grounding stays.
    const json = seedForStorage(body, 300_000);
    expect(json).not.toBeNull();
    const parsed = parseStoredSeed(json ?? "");
    expect(parsed?.config.history[0].attachments?.[0].dataUrl).toBe("");
    expect(parsed?.config.history[0].attachments?.[0].name).toBe("a.png");
    expect(parsed?.config.grounding).toBeDefined();
    const tiny = seedForStorage(body, 300);
    expect(tiny).toBeNull();
    expect(SEED_PAYLOAD_LIMIT).toBeLessThan(2_000_000);
  });

  it("refuses malformed stored seeds", () => {
    expect(parseStoredSeed("")).toBeNull();
    expect(parseStoredSeed("{not json")).toBeNull();
    expect(parseStoredSeed(JSON.stringify({ runId: "r" }))).toBeNull();
  });
});

describe("resumeChatBody", () => {
  const snapshot = (overrides: Partial<RunSnapshot>): RunSnapshot => ({
    runId: "run_1",
    conversationId: "conv_1",
    kind: "chat",
    status: "running",
    startedAt: 1,
    content: "",
    ...overrides,
  });

  it("restarts from the original body when nothing was produced yet", () => {
    const seed = startBody();
    expect(resumeChatBody(seed, snapshot({}), "asst_1")).toBe(seed);
    expect(resumeChatBody(seed, null, "asst_1")).toBe(seed);
  });

  it("replays the draft, the settled tool results and the consumed steering, then continues in place", () => {
    const seed = startBody();
    const body = resumeChatBody(
      seed,
      snapshot({
        content: "The market has three tiers.\n\nFirst, ",
        toolCalls: [
          { id: "c1", name: "web_search", arguments: "{\"q\":\"tiers\"}", status: "done", result: "R".repeat(10_000) },
          { id: "c2", name: "fetch_url", arguments: "{}", status: "running" },
        ],
        steered: [{ id: "s1", text: "focus on Europe", attachments: [] }],
      }),
      "asst_1",
    );
    const history = body.config.history;
    expect(history.map((message) => message.role)).toEqual(["user", "user", "assistant", "user"]);
    expect(history[1].content).toBe("focus on Europe");
    expect(history[2].content).toBe("The market has three tiers.\n\nFirst,");
    expect(history[2].toolCalls?.map((call) => call.id)).toEqual(["c1", "c2"]);
    expect(history[2].toolCalls?.[0].result?.length).toBe(4_000);
    expect(history[2].toolCalls?.[1].result).toBe(RESTART_TOOL_RESULT);
    expect(history[3].content).toBe(SERVER_RESUME_NOTE);
    expect(body.config.resume).toEqual({ messageId: "asst_1", partial: "The market has three tiers.\n\nFirst," });
    // The original body is untouched.
    expect(seed.config.history).toHaveLength(1);
  });

  it("does not stack resume notes when a resumed run dies again", () => {
    const first = resumeChatBody(startBody(), snapshot({ content: "Alpha beta" }), "asst_1");
    const second = resumeChatBody(first, snapshot({ content: "Alpha beta gamma" }), "asst_1");
    const notes = second.config.history.filter((message) => message.content === SERVER_RESUME_NOTE);
    expect(notes).toHaveLength(1);
    expect(second.config.history.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(second.config.resume?.partial).toBe("Alpha beta gamma");
  });

  it("marks a call the restart caught running as failed with the reason", () => {
    expect(recoveredToolCalls([{ id: "a", name: "x", arguments: "{}", status: "running" }])).toEqual([
      { id: "a", name: "x", arguments: "{}", status: "error", result: RESTART_TOOL_RESULT },
    ]);
    expect(recoveredToolCalls(undefined)).toEqual([]);
  });
});

describe("decideRecovery", () => {
  const base = {
    kind: "chat",
    ephemeral: false,
    seed: startBody(),
    restarts: 0,
    snapshot: null,
    startedAt: 1_000,
    now: 2_000,
    budgetMs: 60_000,
    assistantMessageId: "asst_1",
  };

  it("resumes a chat and a research run that still has budget and a stored seed", () => {
    expect(decideRecovery(base).action).toBe("resume");
    const research = decideRecovery({ ...base, kind: "research", seed: { ...startBody(), kind: "research" } });
    expect(research.action).toBe("resume");
    if (research.action === "resume") {
      expect(research.body.kind).toBe("research");
    }
  });

  it("refuses with a named reason: stopped, incognito, Julius, no seed, too many restarts, budget", () => {
    const reasons = [
      decideRecovery({ ...base, stopRequested: true }),
      decideRecovery({ ...base, ephemeral: true }),
      decideRecovery({ ...base, kind: "julius" }),
      decideRecovery({ ...base, seed: null }),
      decideRecovery({ ...base, restarts: MAX_RUN_RESTARTS }),
      decideRecovery({ ...base, now: 1_000 + 60_000 }),
    ].map((decision) => (decision.action === "finalize" ? decision.reason : "RESUMED"));
    expect(reasons).toEqual([
      "it was stopped",
      "incognito runs leave nothing on the server to resume from",
      "a Julius panel cannot be resumed mid-run",
      "its request was not kept for recovery",
      `it was already restarted ${MAX_RUN_RESTARTS} times`,
      "its time budget ran out",
    ]);
    expect(staleRunError("its time budget ran out")).toContain("could not be resumed (its time budget ran out)");
  });
});

function checkpoint(overrides: Partial<ResearchCheckpoint> = {}): ResearchCheckpoint {
  return {
    version: 1,
    wave: 2,
    queries: ["next query"],
    usedQueries: ["q1", "q2"],
    notes: ["Wave 1: missing pricing"],
    readsTotal: 3,
    browsesTotal: 1,
    browsedUrls: ["https://live.test/"],
    readRepoPicks: [],
    repos: [],
    sources: [
      { index: 1, url: "https://a.test/", title: "A", highlights: ["h"], text: "a".repeat(100) },
      { index: 2, url: "https://b.test/", title: "B", highlights: [], text: "b".repeat(1_000) },
      { index: 3, url: "https://c.test/", title: "C", highlights: [] },
    ],
    steps: [{ id: "s1", kind: "search", label: "q1", status: "done" }],
    startedAt: 5,
    ...overrides,
  };
}

describe("research checkpoints", () => {
  it("round-trips through storage and refuses malformed payloads", () => {
    const stored = JSON.stringify(checkpoint());
    expect(parseResearchCheckpoint(stored)).toEqual(checkpoint());
    expect(parseResearchCheckpoint("")).toBeNull();
    expect(parseResearchCheckpoint("{")).toBeNull();
    expect(parseResearchCheckpoint(JSON.stringify({ ...checkpoint(), version: 2 }))).toBeNull();
    expect(parseResearchCheckpoint(JSON.stringify({ ...checkpoint(), queries: "x" }))).toBeNull();
  });

  it("water-fills page texts to the row limit and never drops a source", () => {
    const small = trimResearchCheckpoint(checkpoint());
    expect(small).toEqual(checkpoint());
    const limit = 1_200;
    const trimmed = trimResearchCheckpoint(checkpoint(), limit);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(limit);
    expect(trimmed.sources.map((source) => source.url)).toEqual(["https://a.test/", "https://b.test/", "https://c.test/"]);
    expect(trimmed.usedQueries).toEqual(["q1", "q2"]);
    // The short text keeps more of itself than the long one loses.
    const a = trimmed.sources[0].text?.length ?? 0;
    const b = trimmed.sources[1].text?.length ?? 0;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeLessThan(1_000);
    expect(CHECKPOINT_PAYLOAD_LIMIT).toBeLessThan(2_000_000);
  });
});

// ---------------------------------------------------------------------------
// The real research loop, driven through a fake toolkit: a checkpoint after
// every wave, and a resumed run that continues from it without re-planning.

type FetchCall = { path: string; body: Record<string, unknown> };

function fakeToolkit(plan: {
  planner: string[];
  reflect: Array<Record<string, unknown>>;
  hits: Record<string, Array<{ url: string; title: string }>>;
  report: string;
}) {
  const calls: FetchCall[] = [];
  let reflectIndex = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const path = new URL(url).pathname;
    calls.push({ path, body });
    if (path.endsWith("/exa/search")) {
      const query = String(body.query);
      return Response.json({ results: plan.hits[query] ?? [] });
    }
    if (path.endsWith("/exa/contents")) {
      const urls = body.urls as string[];
      return Response.json({ results: urls.map((item) => ({ url: item, title: `Page ${item}`, text: `text of ${item}` })) });
    }
    if (path.endsWith("/chat/completions") && body.stream !== true) {
      const messages = body.messages as Array<{ role: string; content: string }>;
      const system = messages[0]?.content ?? "";
      if (system.startsWith("You split a research question")) {
        return Response.json({ choices: [{ message: { content: JSON.stringify({ queries: plan.planner }) } }] });
      }
      const reflect = plan.reflect[Math.min(reflectIndex, plan.reflect.length - 1)];
      reflectIndex += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify(reflect) } }] });
    }
    if (path.endsWith("/chat/completions")) {
      const events = [
        { choices: [{ delta: { content: plan.report } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(payload, { status: 200 });
    }
    throw new Error(`unexpected toolkit call ${path}`);
  });
  return { fetchMock, calls };
}

describe("runServerDeepResearch checkpoints and resume", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits a checkpoint after the preparatory steps and after every wave", async () => {
    const toolkit = fakeToolkit({
      planner: ["alpha", "beta"],
      reflect: [
        { notes: "missing gamma", queries: ["gamma"], read: [1], browse: [], done: false },
        { notes: "", queries: [], read: [], browse: [], done: true },
      ],
      hits: {
        alpha: [{ url: "https://a.test/", title: "A" }],
        beta: [{ url: "https://b.test/", title: "B" }],
        gamma: [{ url: "https://c.test/", title: "C" }],
      },
      report: "Report [1][2][3].",
    });
    vi.stubGlobal("fetch", toolkit.fetchMock);
    const checkpoints: ResearchCheckpoint[] = [];
    const outcome = await runServerDeepResearch({
      authKey: "key",
      prompt: "what is alpha",
      history: [],
      modelId: "test/model",
      depth: "balanced",
      onCheckpoint: (item) => checkpoints.push(item),
      onUpdate: () => {},
      onText: () => {},
    });
    expect(outcome.content).toBe("Report [1][2][3].");
    expect(checkpoints.map((item) => item.wave)).toEqual([0, 1, 2]);
    // Before the first wave: the planner's queries, nothing spent yet.
    expect(checkpoints[0].queries).toEqual(["alpha", "beta"]);
    expect(checkpoints[0].usedQueries).toEqual([]);
    // After wave 1: two queries spent, one page read, the next query planned, the note kept.
    expect(checkpoints[1].usedQueries).toEqual(["alpha", "beta"]);
    expect(checkpoints[1].queries).toEqual(["gamma"]);
    expect(checkpoints[1].readsTotal).toBe(1);
    expect(checkpoints[1].notes).toEqual(["Wave 1: missing gamma"]);
    expect(checkpoints[1].sources.map((source) => source.url)).toEqual(["https://a.test/", "https://b.test/"]);
    expect(checkpoints[1].sources[0].text).toBe("text of https://a.test/");
    // The loop is over: no queries left for a restart, three sources numbered in order.
    expect(checkpoints[2].queries).toEqual([]);
    expect(checkpoints[2].sources.map((source) => source.index)).toEqual([1, 2, 3]);
  });

  it("a resumed run continues from the checkpoint — no re-planning, no repeated searches, same source numbers", async () => {
    const toolkit = fakeToolkit({
      planner: ["MUST NOT BE USED"],
      reflect: [{ notes: "", queries: [], read: [3], browse: [], done: true }],
      hits: {
        gamma: [{ url: "https://c.test/", title: "C" }],
        "MUST NOT BE USED": [{ url: "https://never.test/", title: "Never" }],
      },
      report: "Resumed report [1][3].",
    });
    vi.stubGlobal("fetch", toolkit.fetchMock);
    const saved: ResearchCheckpoint = {
      version: 1,
      wave: 1,
      queries: ["gamma"],
      usedQueries: ["alpha", "beta"],
      notes: ["Wave 1: missing gamma"],
      readsTotal: 1,
      browsesTotal: 0,
      browsedUrls: [],
      readRepoPicks: [],
      repos: [],
      sources: [
        { index: 1, url: "https://a.test/", title: "A", highlights: ["h"], text: "text of https://a.test/" },
        { index: 2, url: "https://b.test/", title: "B", highlights: [] },
      ],
      steps: [
        { id: "p", kind: "plan", label: "Planning research", status: "done", detail: "2 queries" },
        { id: "s", kind: "search", label: "alpha", status: "done" },
        { id: "r", kind: "read", label: "B", status: "running" },
      ],
      startedAt: 123,
    };
    const updates: ResearchState[] = [];
    const checkpoints: ResearchCheckpoint[] = [];
    const outcome = await runServerDeepResearch({
      authKey: "key",
      prompt: "what is alpha",
      history: [],
      modelId: "test/model",
      depth: "balanced",
      resumeFrom: saved,
      onCheckpoint: (item) => checkpoints.push(item),
      onUpdate: (research) => updates.push(research),
      onText: () => {},
    });
    expect(outcome.content).toBe("Resumed report [1][3].");
    // The planner was never consulted again and the spent queries were not re-run.
    const plannerCalls = toolkit.calls.filter(
      (call) =>
        call.path.endsWith("/chat/completions") &&
        String((call.body.messages as Array<{ content: string }>)[0]?.content).startsWith("You split a research question"),
    );
    expect(plannerCalls).toHaveLength(0);
    const searched = toolkit.calls.filter((call) => call.path.endsWith("/exa/search")).map((call) => call.body.query);
    expect(searched).toEqual(["gamma"]);
    // Restored sources keep their numbers; the new one takes the next slot.
    expect(outcome.research.sources.map((source) => source.url)).toEqual([
      "https://a.test/",
      "https://b.test/",
      "https://c.test/",
    ]);
    expect(outcome.research.startedAt).toBe(123);
    // The trail says what the restart caught mid-flight, and continues after it.
    const restored = updates[0];
    expect(restored.steps.find((step) => step.id === "r")).toMatchObject({ status: "error", detail: "server restarted" });
    expect(outcome.research.steps.map((step) => step.kind)).toEqual(["plan", "search", "read", "search", "plan", "read", "synthesize"]);
    // The dossier the writer saw carried the restored page text and the new one.
    const writeCall = toolkit.calls.find((call) => call.path.endsWith("/chat/completions") && call.body.stream === true);
    const userTurn = (writeCall?.body.messages as Array<{ role: string; content: string }>).find((message) => message.role === "user");
    expect(userTurn?.content).toContain("text of https://a.test/");
    expect(userTurn?.content).toContain("text of https://c.test/");
    expect(checkpoints.map((item) => item.wave)).toEqual([2]);
    expect(checkpoints[0].usedQueries).toEqual(["alpha", "beta", "gamma"]);
  });
});
