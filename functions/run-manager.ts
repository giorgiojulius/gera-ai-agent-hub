// RunManager — server-side interactive agent runs inside the account's
// ChatStore Durable Object shard. Owns the run lifecycle end to end:
//
// - start: seeds the chat (LWW), spawns the engine via ctx.waitUntil;
// - live channel: SSE streams per conversation (snapshot first, then events);
// - steering: an inbox + watcher pings — the engine soft-cuts its in-flight
//   gateway stream at the next token, keeps the draft, and continues in place;
// - stop: finishes NOW with the draft kept exactly as shown;
// - persistence: throttled snapshots + heartbeat, so a reopened tab gets the
//   current state instantly and a crashed node leaves an honest trail;
// - recovery: stale running rows (dead heartbeat) finalize as "interrupted"
//   with the collected draft written into the chat — nothing is redrawn;
// - results: the final assistant message is appended to the chat history
//   (LWW clock bump) so normal sync delivers it to every device; generated
//   media is stored in chunked rows and referenced as gera-cloud: refs.

import {
  buildApiMessages,
  runEngineTurn,
  type EngineSteerItem,
  type EngineToolRecord,
} from "./agent-engine";
import { armCloudMcp, emptyMcpRuntime, type McpRuntime } from "./automation-runner";
import { deriveCodeChangeFlow, finalizeCodeChangeFlow, mergeRunCodeChangeStates } from "./code-change-flow";
import {
  chainRotationBases,
  cloudMcpServersForAutomation,
  cloudOAuthTokens,
  normalizeOAuthOverride,
  overlayOAuthRotations,
  unlockGithubChatWrites,
  type CloudOAuthRefreshFailure,
  type CloudOAuthToken,
  type OAuthRotation,
  type RefreshedOAuth,
} from "./mcp-cloud";
import { runServerDeepResearch, RunStoppedError } from "./research-runner";
import { openGrantPayload, openRotationValue, sealGrantPayload } from "./secret-rows";
import { SecretVault, SecretVaultError } from "./secret-vault";
import { runServerJulius } from "./julius-runner";
import { callGitHubNativeTool, fetchGitHubRepoMeta, githubRunRepoRefs } from "./native-github";
import {
  builtinToolDefs,
  createServerSurfSession,
  createSourceLedger,
  executeServerTool,
  type ServerToolContext,
} from "./run-tools";
import {
  buildExecutionOutcome,
  cloudMediaRef,
  executionOutcomeSystemPrompt,
  executionOutcomeToolDefinition,
  extractExecutionOutcomeMarker,
  parseExecutionOutcomeClaim,
  visibleExecutionToolCalls,
  type ExecutionOutcomeClaim,
  type JuliusState,
  type ResearchState,
  type RunCodeChangeState,
  type RunEvent,
  type RunFinalMessage,
  type RunKind,
  type RunSnapshot,
  type RunSource,
  type RunStatus,
  type RunSteerItem,
  type RunToolRecord,
  type RunUsageEvent,
  type StartRunBody,
} from "./run-protocol";

const CHAT_PAYLOAD_LIMIT = 900_000;
const TITLE_LIMIT = 160;
const ID_LIMIT = 80;
const MAX_CHATS_PER_OWNER = 500;
const OAUTH_REF_PREFIX = "oauthref:";

/** Finished, unacked results stay listable this long for reopened tabs. */
const RESULT_RETENTION_MS = 30 * 60_000;
/** Finished run rows are GC'd after this. */
const ROW_TTL_MS = 48 * 3_600_000;
/** Generated media chunks are GC'd after this (chat refs resolve until then). */
const MEDIA_TTL_MS = 7 * 24 * 3_600_000;
const MEDIA_CHUNK_CHARS = 900_000;
/** Honest wall-clock budgets per run kind. */
const TIME_BUDGET_MS: Record<RunKind, number> = {
  chat: 15 * 60_000,
  research: 40 * 60_000,
  julius: 40 * 60_000,
};
const MAX_LIVE_RUNS_PER_OWNER = 3;

/** Caps for the final assistant message written into chat history. */
const FINAL_CONTENT_CHARS = 300_000;
const FINAL_TOOLCALLS = 40;
const FINAL_TOOL_RESULT_CHARS = 4_000;
const FINAL_TOOL_ARGS_CHARS = 500;
const FINAL_SOURCES = 100;
const STEER_TEXT_CHARS = 8_000;

/** Snapshot caps — the row must stay well under the 2 MB SQLite value limit. */
const SNAP_CONTENT_CHARS = 400_000;
const SNAP_TOOL_RESULT_CHARS = 1_200;
const SNAP_TOOLCALLS = 48;
const SNAP_REASONING_CHARS = 2_000;

type RunRow = {
  owner_email: string;
  conversation_id: string;
  run_id: string;
  kind: string;
  status: string;
  started_at: number;
  heartbeat_at: number;
  finished_at: number;
  title: string;
  model_id: string;
  assistant_message_id: string;
  ephemeral: number;
  acked: number;
  snapshot: string;
  result: string;
  error: string;
};

type RunReceiptRow = {
  owner_email: string;
  run_id: string;
  conversation_id: string;
  request_hash: string;
  status: string;
  history_on_server: number;
  result: string;
  error: string;
  created_at: number;
  updated_at: number;
};

type LiveRun = {
  owner: string;
  runId: string;
  conversationId: string;
  kind: RunKind;
  startedAt: number;
  body: StartRunBody;
  /** History was seeded into server chat storage (results may be written there). */
  chatWritable: boolean;
  // Display state (what a snapshot must reproduce).
  content: string;
  reasoningTail: string;
  toolCalls: RunToolRecord[];
  codeChanges?: RunCodeChangeState;
  sources: RunSource[];
  research?: ResearchState;
  julius?: JuliusState;
  steered: RunSteerItem[];
  usageEvents: RunUsageEvent[];
  /** Model claim captured by gera_submit_outcome; runtime evidence still validates it. */
  executionClaim?: ExecutionOutcomeClaim;
  // Control.
  seq: number;
  inbox: RunSteerItem[];
  watchers: Set<() => void>;
  stopRequested: boolean;
  subscribers: Set<(event: RunEvent) => void>;
  done: boolean;
  // Throttles.
  textTimer: ReturnType<typeof setTimeout> | null;
  toolsTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
};

type ManagerEnv = {
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  RORK_TOOLKIT_SECRET_KEY?: string;
  /** Test-only deterministic gateway; production leaves both unset. */
  STAGING_GATEWAY_URL?: string;
  STAGING_GATEWAY_SECRET?: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isValidId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= ID_LIMIT;
}

function capStr(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// --- Resume stitching (port of web/src/lib/resume.ts joinResumedText) -------

const MIN_OVERLAP = 3;
const MAX_OVERLAP = 320;
const BLOCK_START = /^(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||<)/u;
const CLOSED_END = /(```|[.!?…:;)\]}»”"'|*_])$/u;

/** Stitches a cut-off reply with its continuation without a visible seam. */
export function joinResumedText(head: string, tail: string): string {
  const base = head.replace(/\s+$/u, "");
  const next = tail.replace(/^\n+/u, "");
  if (base.length === 0) {
    return next;
  }
  if (next.length === 0) {
    return base;
  }
  if (next.length < MAX_OVERLAP && base.endsWith(next)) {
    return base;
  }
  const cap = Math.min(base.length, next.length, MAX_OVERLAP);
  for (let k = cap; k >= MIN_OVERLAP; k -= 1) {
    if (base.endsWith(next.slice(0, k))) {
      return base + next.slice(k);
    }
  }
  if (BLOCK_START.test(next) || CLOSED_END.test(base)) {
    return `${base}\n\n${next}`;
  }
  return `${base} ${next}`;
}

// ---------------------------------------------------------------------------

export class RunManager {
  private readonly ctx: DurableObjectState;
  private readonly env: ManagerEnv;
  /** Same key as the owning ChatStore — grants it rotates stay readable there. */
  private readonly vault: SecretVault;
  private readonly live = new Map<string, LiveRun>();

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = (env ?? {}) as ManagerEnv;
    this.vault = SecretVault.fromEnv(env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        owner_email TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        assistant_message_id TEXT NOT NULL DEFAULT '',
        ephemeral INTEGER NOT NULL DEFAULT 0,
        acked INTEGER NOT NULL DEFAULT 0,
        snapshot TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (owner_email, conversation_id)
      )
    `);
    // Immutable idempotency receipts survive replacement of a conversation's
    // current run row. Retrying the same accepted runId can therefore never
    // execute tools twice, even when the first HTTP response vanished.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_run_receipts (
        owner_email TEXT NOT NULL,
        run_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        history_on_server INTEGER NOT NULL DEFAULT 0,
        result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, run_id)
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_run_receipts_owner_updated ON agent_run_receipts (owner_email, updated_at)",
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_states (
        owner_email TEXT NOT NULL,
        server_id TEXT NOT NULL,
        state TEXT NOT NULL,
        error_code TEXT NOT NULL DEFAULT '',
        retry_after INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, server_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_run_media (
        owner_email TEXT NOT NULL,
        run_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, run_id, idx, chunk)
      )
    `);
  }

  /** Conversations that must not be overwritten by sync while a run lives. */
  lockedConversationIds(owner: string): Set<string> {
    const locked = new Set<string>();
    for (const run of this.live.values()) {
      if (run.owner === owner && !run.done) {
        locked.add(run.conversationId);
      }
    }
    const rows = this.ctx.storage.sql
      .exec<{ conversation_id: string }>(
        "SELECT conversation_id FROM agent_runs WHERE owner_email = ? AND status = 'running'",
        owner,
      )
      .toArray();
    for (const row of rows) {
      locked.add(row.conversation_id);
    }
    return locked;
  }

  /** Routes one /runs/* call; null when the path is not a run route. */
  async handle(request: Request, owner: string, pathname: string): Promise<Response | null> {
    if (!pathname.startsWith("/runs/")) {
      return null;
    }
    this.sweepStale(owner);
    if (request.method === "POST" && pathname === "/runs/start") {
      return this.handleStart(request, owner);
    }
    if (request.method === "POST" && pathname === "/runs/steer") {
      return this.handleSteer(request, owner);
    }
    if (request.method === "POST" && pathname === "/runs/retract") {
      return this.handleRetract(request, owner);
    }
    if (request.method === "POST" && pathname === "/runs/stop") {
      return this.handleStop(request, owner);
    }
    if (request.method === "POST" && pathname === "/runs/ack") {
      return this.handleAck(request, owner);
    }
    if (request.method === "GET" && pathname === "/runs/active") {
      return this.handleActive(owner);
    }
    if (request.method === "GET" && pathname === "/runs/stream") {
      return this.handleStream(request, owner);
    }
    if (request.method === "GET" && pathname === "/runs/media") {
      return this.handleMedia(request, owner);
    }
    return json({ error: "not_found" }, 404);
  }

  // -------------------------------------------------------------------------
  // Routes

  private async handleStart(request: Request, owner: string): Promise<Response> {
    let body: StartRunBody;
    try {
      body = (await request.json()) as StartRunBody;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (
      !isValidId(body.runId) ||
      !isValidId(body.conversationId) ||
      !isValidId(body.assistantMessageId) ||
      !body.config ||
      (body.kind !== "chat" && body.kind !== "research" && body.kind !== "julius")
    ) {
      return json({ error: "invalid_run" }, 400);
    }
    const requestHash = await this.startRequestHash(body);
    const receipt = this.receiptRow(owner, body.runId);
    if (receipt) {
      if (receipt.request_hash !== requestHash || receipt.conversation_id !== body.conversationId) {
        return json({ error: "idempotency_conflict" }, 409);
      }
      let receiptStatus = receipt.status;
      let result = receipt.result ? this.parseJson<Record<string, unknown>>(receipt.result) : null;
      const receiptRun = this.runRowById(owner, body.runId);
      if (receiptStatus === "running" && receiptRun?.status !== "running") {
        if (receiptRun) {
          receiptStatus = receiptRun.status;
          result = receiptRun.result ? this.parseJson<Record<string, unknown>>(receiptRun.result) : null;
          this.ctx.storage.sql.exec(
            `UPDATE agent_run_receipts SET status = ?, result = ?, error = ?, updated_at = ?
             WHERE owner_email = ? AND run_id = ? AND status = 'running'`,
            receiptStatus,
            receiptRun.result,
            receiptRun.error,
            Date.now(),
            owner,
            body.runId,
          );
        } else {
          // Crash before execution ownership was recorded: the accepted id is
          // terminally interrupted and can never execute tools on a retry.
          receiptStatus = "interrupted";
          result = {
            message: { id: body.assistantMessageId, content: "", interrupted: true },
            usageEvents: [],
            steered: [],
            chatUpdatedAt: 0,
          };
          this.ctx.storage.sql.exec(
            `UPDATE agent_run_receipts SET status = 'interrupted', result = ?, error = ?, updated_at = ?
             WHERE owner_email = ? AND run_id = ? AND status = 'running'`,
            JSON.stringify(result),
            "Run acceptance was interrupted before execution ownership was recorded.",
            Date.now(),
            owner,
            body.runId,
          );
        }
      }
      return json({
        ok: true,
        runId: receipt.run_id,
        replayed: true,
        historyOnServer: receipt.history_on_server === 1,
        status: receiptStatus,
        ...(result ? { result } : {}),
      });
    }
    // Rows created by the pre-receipt bundle still reserve their runId. We do
    // not know their original request hash, so replay returns the durable row
    // and never risks executing an old tool request a second time.
    const legacyRow = this.runRowById(owner, body.runId);
    if (legacyRow) {
      const result = legacyRow.result ? this.parseJson<Record<string, unknown>>(legacyRow.result) : null;
      return json({
        ok: true,
        runId: legacyRow.run_id,
        replayed: true,
        historyOnServer: legacyRow.ephemeral !== 1,
        status: legacyRow.status,
        ...(result ? { result } : {}),
      });
    }
    const existing = this.live.get(this.liveKey(owner, body.conversationId));
    if (existing && !existing.done) {
      return json({ error: "run_active", runId: existing.runId }, 409);
    }
    const runningRow = this.runRow(owner, body.conversationId);
    if (runningRow && runningRow.status === "running") {
      return json({ error: "run_active", runId: runningRow.run_id }, 409);
    }
    let liveCount = 0;
    for (const run of this.live.values()) {
      if (run.owner === owner && !run.done) {
        liveCount += 1;
      }
    }
    if (liveCount >= MAX_LIVE_RUNS_PER_OWNER) {
      return json({ error: "too_many_runs" }, 429);
    }
    const authKey = this.env.STAGING_GATEWAY_URL
      ? this.env.STAGING_GATEWAY_SECRET ?? ""
      : this.env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY ?? this.env.RORK_TOOLKIT_SECRET_KEY ?? "";
    if (!authKey) {
      return json({ error: "toolkit_key_missing" }, 503);
    }

    const ephemeral = body.config.ephemeral === true;
    const now = Date.now();
    const run: LiveRun = {
      owner,
      runId: body.runId,
      conversationId: body.conversationId,
      kind: body.kind,
      startedAt: now,
      body,
      chatWritable: false,
      content: body.config.resume?.partial ?? "",
      reasoningTail: "",
      toolCalls: [],
      sources: body.config.grounding ? body.config.grounding.sources.map((s) => ({ ...s })) : [],
      steered: [],
      usageEvents: [],
      seq: 0,
      inbox: [],
      watchers: new Set(),
      stopRequested: false,
      subscribers: new Set(),
      done: false,
      textTimer: null,
      toolsTimer: null,
      flushTimer: null,
    };
    // Seed + idempotency receipt + execution ownership commit together. A
    // deploy can observe all three or none; it can never accept a run id while
    // leaving a second request free to execute its tools.
    this.ctx.storage.transactionSync(() => {
      run.chatWritable = !ephemeral && this.applyChatSeed(owner, body);
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_run_receipts
          (owner_email, run_id, conversation_id, request_hash, status, history_on_server, result, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, '', '', ?, ?)`,
        owner,
        body.runId,
        body.conversationId,
        requestHash,
        run.chatWritable ? 1 : 0,
        now,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO agent_runs
          (owner_email, conversation_id, run_id, kind, status, started_at, heartbeat_at, finished_at,
           title, model_id, assistant_message_id, ephemeral, acked, snapshot, result, error)
         VALUES (?, ?, ?, ?, 'running', ?, ?, 0, ?, ?, ?, ?, 0, ?, '', '')`,
        owner,
        body.conversationId,
        body.runId,
        body.kind,
        now,
        now,
        capStr(body.title || "Chat", TITLE_LIMIT),
        capStr(body.modelId || "", 120),
        body.assistantMessageId,
        ephemeral ? 1 : 0,
        JSON.stringify(this.snapshotOf(run)),
      );
    });
    this.live.set(this.liveKey(owner, body.conversationId), run);
    this.ctx.waitUntil(
      this.executeRun(run, authKey).catch((error) => {
        console.error("run crashed:", error instanceof Error ? error.message : "unknown");
        this.finishRun(run, "error", {
          message: this.buildFinalMessage(run, run.content, { interrupted: run.content.trim().length > 0 }),
          error: error instanceof Error ? capStr(error.message, 300) : "Run failed.",
        });
      }),
    );
    return json({ ok: true, runId: body.runId, historyOnServer: run.chatWritable, status: "running" });
  }

  private async handleSteer(request: Request, owner: string): Promise<Response> {
    let body: { conversationId?: unknown; item?: RunSteerItem };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const item = body.item;
    if (!isValidId(conversationId) || !item || !isValidId(item.id) || typeof item.text !== "string") {
      return json({ error: "invalid_body" }, 400);
    }
    const run = this.live.get(this.liveKey(owner, conversationId));
    if (!run || run.done) {
      return json({ accepted: false, reason: "not_running" });
    }
    if (run.kind !== "chat") {
      // Research and Julius runs honestly refuse mid-run guidance.
      return json({ accepted: false, reason: "not_steerable" });
    }
    run.inbox.push({
      id: item.id,
      text: capStr(item.text, STEER_TEXT_CHARS),
      attachments: Array.isArray(item.attachments) ? item.attachments.slice(0, 6) : [],
    });
    // Ping AFTER the push so a drain fired by the ping already sees the item.
    for (const listener of [...run.watchers]) {
      listener();
    }
    return json({ accepted: true });
  }

  private async handleRetract(request: Request, owner: string): Promise<Response> {
    let body: { conversationId?: unknown; itemId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    const run = this.live.get(this.liveKey(owner, conversationId));
    if (!run || run.done) {
      return json({ removed: false });
    }
    const index = run.inbox.findIndex((entry) => entry.id === itemId);
    if (index >= 0) {
      run.inbox.splice(index, 1);
      return json({ removed: true });
    }
    return json({ removed: false });
  }

  private async handleStop(request: Request, owner: string): Promise<Response> {
    let body: { conversationId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const run = this.live.get(this.liveKey(owner, conversationId));
    if (run && !run.done) {
      run.stopRequested = true;
      for (const listener of [...run.watchers]) {
        listener();
      }
      return json({ ok: true });
    }
    const row = this.runRow(owner, conversationId);
    if (row && row.status === "running") {
      // The node running it died — finalize honestly as interrupted now.
      this.finalizeStaleRow(row);
      return json({ ok: true, stale: true });
    }
    return json({ ok: false, reason: "not_running" });
  }

  private async handleAck(request: Request, owner: string): Promise<Response> {
    let body: { runId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!isValidId(runId)) {
      return json({ error: "invalid_body" }, 400);
    }
    this.ctx.storage.sql.exec(
      "UPDATE agent_runs SET acked = 1 WHERE owner_email = ? AND run_id = ? AND status != 'running'",
      owner,
      runId,
    );
    return json({ ok: true });
  }

  private handleActive(owner: string): Response {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<RunRow>(
        `SELECT * FROM agent_runs WHERE owner_email = ?
           AND (status = 'running' OR (acked = 0 AND finished_at > ?))`,
        owner,
        now - RESULT_RETENTION_MS,
      )
      .toArray();
    const runs = rows.map((row) => {
      const live = this.live.get(this.liveKey(owner, row.conversation_id));
      const snapshot: RunSnapshot | null =
        live && live.runId === row.run_id ? this.snapshotOf(live) : this.parseJson<RunSnapshot>(row.snapshot);
      return {
        runId: row.run_id,
        conversationId: row.conversation_id,
        kind: row.kind,
        status: row.status,
        startedAt: row.started_at,
        title: row.title,
        assistantMessageId: row.assistant_message_id,
        snapshot,
        result: row.status !== "running" ? this.parseJson<Record<string, unknown>>(row.result) : null,
      };
    });
    return json({ runs });
  }

  private handleStream(request: Request, owner: string): Response {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") ?? "";
    if (!isValidId(conversationId)) {
      return json({ error: "invalid_body" }, 400);
    }
    const encoder = new TextEncoder();
    const run = this.live.get(this.liveKey(owner, conversationId));
    if (run && !run.done) {
      let cleanup: () => void = () => undefined;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const send = (event: RunEvent): void => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } catch {
              cleanup();
            }
            if (event.t === "done") {
              try {
                controller.close();
              } catch {
                // already closed
              }
              cleanup();
            }
          };
          const keepalive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ t: "ping", seq: run.seq })}\n\n`));
            } catch {
              cleanup();
            }
          }, 15_000);
          cleanup = () => {
            clearInterval(keepalive);
            run.subscribers.delete(send);
          };
          send({ t: "snapshot", seq: (run.seq += 1), snapshot: this.snapshotOf(run) });
          run.subscribers.add(send);
        },
        cancel: () => {
          cleanup();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }
    // Not live — answer from the stored row: snapshot + terminal event.
    const row = this.runRow(owner, conversationId);
    if (!row) {
      return json({ error: "not_found" }, 404);
    }
    const events: RunEvent[] = [];
    const snapshot = this.parseJson<RunSnapshot>(row.snapshot);
    if (snapshot) {
      events.push({ t: "snapshot", seq: 1, snapshot });
    }
    if (row.status !== "running") {
      const result = this.parseJson<{
        message: RunFinalMessage;
        usageEvents: RunUsageEvent[];
        steered: RunSteerItem[];
        chatUpdatedAt: number;
      }>(row.result);
      if (result) {
        events.push({
          t: "done",
          seq: 2,
          status: row.status as Exclude<RunStatus, "running">,
          message: result.message,
          usageEvents: result.usageEvents ?? [],
          steered: result.steered ?? [],
          chatUpdatedAt: result.chatUpdatedAt ?? 0,
          ...(row.error ? { error: row.error } : {}),
        });
      }
    }
    const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(payload, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  private handleMedia(request: Request, owner: string): Response {
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId") ?? "";
    const idx = Number(url.searchParams.get("idx") ?? "-1");
    if (!isValidId(runId) || !Number.isInteger(idx) || idx < 0) {
      return json({ error: "invalid_body" }, 400);
    }
    const rows = this.ctx.storage.sql
      .exec<{ kind: string; data: string; chunk: number }>(
        "SELECT kind, data, chunk FROM agent_run_media WHERE owner_email = ? AND run_id = ? AND idx = ? ORDER BY chunk",
        owner,
        runId,
        idx,
      )
      .toArray();
    if (rows.length === 0) {
      return json({ error: "media_expired" }, 404);
    }
    return json({ kind: rows[0].kind, dataUrl: rows.map((row) => row.data).join("") });
  }

  // -------------------------------------------------------------------------
  // Execution

  private async executeRun(run: LiveRun, authKey: string): Promise<void> {
    const config = run.body.config;
    // The tab chooses connector ids only. Runtime config and every credential
    // are re-read from this account's durable profile on the server.
    const durableMcpConfigs = this.profileMcpConfigsForRun(run.owner, config.mcpServers);
    const isAutomation = Boolean(run.body.automationId);
    const contractPrompt = isAutomation
      ? executionOutcomeSystemPrompt(run.kind === "research" ? "marker" : "tool", "automation")
      : "";
    const systemPrompt = [config.systemPrompt?.trim() ?? "", contractPrompt].filter(Boolean).join("\n\n") || undefined;
    const deadlineAt = run.startedAt + TIME_BUDGET_MS[run.kind];
    const onUsage = (modelId: string, usage: unknown, service?: boolean): void => {
      run.usageEvents.push({ modelId, usage, ...(service ? { service: true } : {}) });
    };
    const isCancelled = (): boolean => run.stopRequested || Date.now() >= deadlineAt;

    if (run.kind === "research") {
      try {
        const { tokens: oauthTokens, appliedChains } = await this.oauthTokensFor(run.owner);
        const githubRuntime = await armCloudMcp(
          cloudMcpServersForAutomation(durableMcpConfigs, null, oauthTokens).filter(
            (server) => server.kind === "github",
          ),
          (rotated) => this.persistRefreshedGrant(run.owner, rotated, appliedChains),
          (id, outcome) => this.recordOAuthFailure(run.owner, id, outcome),
          (id) => this.markOAuthRefreshStarted(run.owner, id),
        );
        const githubRoute = [...githubRuntime.routes.values()].find(
          (route) => route.type === "native" && route.kind === "github",
        );
        const outcome = await runServerDeepResearch({
          authKey,
          prompt: config.prompt,
          history: config.history,
          modelId: run.body.modelId,
          systemPrompt,
          depth: config.research?.depth ?? "balanced",
          githubAuth: githubRoute?.type === "native" ? githubRoute.auth : undefined,
          githubDisabledTools: unlockGithubChatWrites("github", config.research?.githubDisabledTools ?? []),
          githubRepo: config.githubRepo,
          citations: config.research?.citations ?? "numeric",
          isCancelled,
          onUpdate: (research) => {
            run.research = research;
            run.sources = research.sources;
            this.emit(run, { t: "research", seq: 0, research });
            this.scheduleFlush(run);
          },
          onText: (full) => this.emitText(run, full),
          onUsage,
        });
        this.finishRun(run, "done", {
          message: this.buildFinalMessage(run, outcome.content, {
            research: outcome.research,
            sources: outcome.research.sources,
            servedBy: outcome.servedBy,
          }),
        });
      } catch (error) {
        if (error instanceof RunStoppedError || run.stopRequested) {
          this.finishRun(run, "stopped", {
            message: this.buildFinalMessage(run, run.content, { research: run.research, sources: run.sources }),
          });
          return;
        }
        this.finishRun(run, "error", {
          message: this.buildFinalMessage(run, run.content, {
            research: run.research,
            sources: run.sources,
            interrupted: run.content.trim().length > 0,
          }),
          error: error instanceof Error ? capStr(error.message, 300) : "Research failed.",
        });
      }
      return;
    }

    if (run.kind === "julius") {
      const juliusConfig = config.julius;
      if (!juliusConfig) {
        this.finishRun(run, "error", {
          message: this.buildFinalMessage(run, "", {}),
          error: "julius_config_missing",
        });
        return;
      }
      try {
        // Arm the scoped native GitHub route once for every Julius mode.
        // Plain candidates can inspect it directly; research candidates use
        // their deterministic preload, while the council Verifier still needs
        // the same route to independently check their repository claims.
        let juliusMcp: McpRuntime = emptyMcpRuntime();
        if (durableMcpConfigs.length > 0) {
          const { tokens: oauthTokens, appliedChains } = await this.oauthTokensFor(run.owner);
          const servers = cloudMcpServersForAutomation(durableMcpConfigs, null, oauthTokens).filter(
            (server) => server.kind === "github",
          );
          juliusMcp = servers.length > 0
            ? await armCloudMcp(
                servers,
                (rotated) => this.persistRefreshedGrant(run.owner, rotated, appliedChains),
                (id, outcome) => this.recordOAuthFailure(run.owner, id, outcome),
                (id) => this.markOAuthRefreshStarted(run.owner, id),
              )
            : emptyMcpRuntime();
        }
        const juliusGithubRoute = [...juliusMcp.routes.values()].find(
          (route) => route.type === "native" && route.kind === "github",
        );
        const result = await runServerJulius({
          authKey,
          history: config.history,
          prompt: config.prompt,
          settings: juliusConfig.settings,
          builtins: config.builtins,
          mcpToolDefs: juliusMcp.toolDefs,
          mcpRoutes: juliusMcp.routes,
          systemPrompt,
          isCancelled,
          research: juliusConfig.research
            ? async ({ modelId, onText, onResearch }) => {
                const outcome = await runServerDeepResearch({
                  authKey,
                  prompt: config.prompt,
                  history: config.history.slice(0, -1),
                  modelId,
                  systemPrompt: config.systemPrompt,
                  depth: config.research?.depth ?? "balanced",
                  githubAuth: juliusGithubRoute?.type === "native" ? juliusGithubRoute.auth : undefined,
                  githubDisabledTools: unlockGithubChatWrites("github", config.research?.githubDisabledTools ?? []),
                  githubRepo: config.githubRepo,
                  // Candidates compete as SPECIFIC models — the report write
                  // fails honestly instead of being ghost-written by a backup.
                  fallbacks: false,
                  isCancelled,
                  onUpdate: onResearch,
                  onText,
                  onUsage,
                });
                onResearch(outcome.research);
                return outcome.content;
              }
            : undefined,
          onUpdate: (julius) => {
            run.julius = julius;
            if (julius.sources && julius.sources.length > 0) {
              run.sources = julius.sources;
            }
            this.emit(run, {
              t: "julius",
              seq: 0,
              julius,
              ...(julius.sources && julius.sources.length > 0 ? { sources: julius.sources } : {}),
            });
            this.scheduleFlush(run);
          },
          onContent: (full) => this.emitText(run, full),
          onUsage,
        });
        this.finishRun(run, run.stopRequested ? "stopped" : "done", {
          message: this.buildFinalMessage(run, result.content, {
            julius: result.julius,
            servedBy: result.servedBy,
            sources: result.julius.sources,
          }),
        });
      } catch (error) {
        this.finishRun(run, run.stopRequested ? "stopped" : "error", {
          message: this.buildFinalMessage(run, run.content, {
            julius: run.julius,
            interrupted: run.content.trim().length > 0 && !run.stopRequested,
          }),
          error:
            run.stopRequested || !(error instanceof Error) ? undefined : capStr(error.message, 300),
        });
      }
      return;
    }

    // --- chat / resume ---
    const ledger = createSourceLedger();
    for (const source of run.sources) {
      ledger.assign(source.url, source.title);
    }
    // MCP first, so honest failure records are visible from the start.
    let mcp: McpRuntime = emptyMcpRuntime();
    if (durableMcpConfigs.length > 0) {
      try {
        const { tokens: oauthTokens, appliedChains } = await this.oauthTokensFor(run.owner);
        const servers = cloudMcpServersForAutomation(durableMcpConfigs, null, oauthTokens);
        mcp = servers.length > 0
          ? await armCloudMcp(
              servers,
              (rotated) => this.persistRefreshedGrant(run.owner, rotated, appliedChains),
              (id, outcome) => this.recordOAuthFailure(run.owner, id, outcome),
              (id) => this.markOAuthRefreshStarted(run.owner, id),
            )
          : emptyMcpRuntime();
      } catch (error) {
        console.error("mcp arming failed:", error instanceof Error ? error.message : "unknown");
      }
    }
    // A pin is an explicit promise that the agent can read this repo. Verify
    // that promise on the SAME server route the model will use, then preload
    // the root listing. This closes the misleading state where /user/repos in
    // the browser showed a private repo but the cloud credential or Contents
    // permission failed later — and it gives the model real repo context even
    // before its first tool call.
    let pinnedGitHubBlock = "";
    let pinnedGitHubFailure: RunToolRecord | null = null;
    const pinnedRef = githubRunRepoRefs("", config.githubRepo)[0];
    if (pinnedRef) {
      const route = [...mcp.routes.values()].find(
        (item) => item.type === "native" && item.kind === "github" && item.toolName === "get_contents",
      );
      const target = `${pinnedRef.owner}/${pinnedRef.repo}`;
      if (!route || route.type !== "native") {
        const reason = `GitHub is not armed for this run — the active profile may exclude it or the sign-in is missing.`;
        pinnedGitHubFailure = {
          id: "github_pin_preflight",
          name: "mcp_github_get_contents",
          arguments: JSON.stringify({ owner: pinnedRef.owner, repo: pinnedRef.repo, path: "" }),
          status: "error",
          result: reason,
        };
        pinnedGitHubBlock = `Pinned GitHub repository check FAILED for ${target}: ${reason} Do not claim to have read its code.`;
      } else {
        try {
          const meta = await fetchGitHubRepoMeta(route.auth, pinnedRef.owner, pinnedRef.repo);
          const root = await callGitHubNativeTool(route.auth, "get_contents", {
            owner: pinnedRef.owner,
            repo: pinnedRef.repo,
            path: "",
            ref: meta.defaultBranch,
          });
          pinnedGitHubBlock = [
            `## Server-verified pinned GitHub repository`,
            `The cloud run authenticated to GitHub and read ${meta.fullName}${meta.isPrivate ? " (private)" : ""} on branch ${meta.defaultBranch}. The root listing below is real tool output. Use the armed mcp_github_* tools to inspect relevant files before making code-level claims.`,
            capStr(root, 12_000),
          ].join("\n");
        } catch (error) {
          const reason = error instanceof Error ? capStr(error.message, 300) : "GitHub access check failed.";
          pinnedGitHubFailure = {
            id: "github_pin_preflight",
            name: "mcp_github_get_contents",
            arguments: JSON.stringify({ owner: pinnedRef.owner, repo: pinnedRef.repo, path: "" }),
            status: "error",
            result: reason,
          };
          pinnedGitHubBlock = `Pinned GitHub repository check FAILED for ${target}: ${reason} The browser may list repository metadata even when file Contents permission is missing. Do not claim to have read its code.`;
        }
      }
    }
    const failureRecords: RunToolRecord[] = [
      ...mcp.failures.map((failure, index) => ({
        id: `mcpfail_${index}`,
        name: failure.name,
        arguments: failure.arguments,
        status: "error" as const,
        result: failure.result,
      })),
      ...(pinnedGitHubFailure ? [pinnedGitHubFailure] : []),
    ];
    if (failureRecords.length > 0) {
      run.toolCalls = [...failureRecords];
      this.emitTools(run);
    }

    const toolCtx: ServerToolContext = {
      authKey,
      ledger,
      surf: createServerSurfSession(),
      mcpRoutes: mcp.routes.size > 0 ? mcp.routes : null,
    };
    const tools = [
      ...builtinToolDefs(config.builtins),
      ...mcp.toolDefs.map((def) => ({ ...def })),
      ...(isAutomation ? [executionOutcomeToolDefinition()] : []),
    ];

    const apiMessages = buildApiMessages(config.history, systemPrompt);
    if (pinnedGitHubBlock) {
      apiMessages.push({ role: "system", content: pinnedGitHubBlock });
    }
    if (config.grounding && config.grounding.sources.length > 0) {
      apiMessages.push({ role: "system", content: config.grounding.block });
    }

    const resumeBase = config.resume?.partial ?? "";
    const joined = (tail: string): string => (resumeBase ? joinResumedText(resumeBase, tail) : tail);

    let sourceCount = run.sources.length;
    const syncSources = (): void => {
      const list = ledger.list();
      if (list.length !== sourceCount) {
        sourceCount = list.length;
        run.sources = list;
        this.emit(run, { t: "sources", seq: 0, sources: list });
      }
    };

    try {
      const result = await runEngineTurn({
        authKey,
        modelId: run.body.modelId,
        gatewayUrl: this.env.STAGING_GATEWAY_URL,
        apiMessages,
        tools,
        executeTool: async (name, argsJson) => {
          if (isAutomation && name === executionOutcomeToolDefinition().function.name) {
            run.executionClaim = parseExecutionOutcomeClaim(argsJson) ?? undefined;
            return {
              text: run.executionClaim
                ? "Execution outcome recorded. Do not repeat the deliverable."
                : "Execution outcome was invalid. Submit it again with every required field.",
              ...(run.executionClaim ? {} : { isError: true }),
            };
          }
          const outcome = await executeServerTool(name, argsJson, toolCtx);
          syncSources();
          return outcome;
        },
        takeSteering: () => run.inbox.splice(0, run.inbox.length),
        watchSteering: (listener) => {
          run.watchers.add(listener);
          return () => {
            run.watchers.delete(listener);
          };
        },
        steeringWrapNote: config.steeringWrapNote,
        isStopped: () => run.stopRequested,
        deadlineAt,
        handlers: {
          onText: (full) => this.emitText(run, joined(full)),
          onReasoning: (full) => {
            run.reasoningTail = full.length > SNAP_REASONING_CHARS ? `…${full.slice(-SNAP_REASONING_CHARS)}` : full;
            this.emit(run, { t: "reasoning", seq: 0, tail: run.reasoningTail });
          },
          onToolCalls: (calls) => {
            const visibleCalls = visibleExecutionToolCalls(calls);
            run.toolCalls = [...failureRecords, ...visibleCalls];
            this.emitTools(run);
            this.captureCodeChanges(run, visibleCalls);
          },
        },
        onUsage,
        onSteered: (items) => {
          const wire: RunSteerItem[] = items.map((item: EngineSteerItem) => ({
            id: item.id,
            text: item.text,
            attachments: item.attachments,
          }));
          run.steered.push(...wire);
          this.emit(run, { t: "steered", seq: 0, items: wire });
          this.scheduleFlush(run);
        },
      });
      syncSources();
      // A stop that lands in the instant the reply completes still counts as
      // a stop — the client holds its follow-up queue on "stopped".
      const status: Exclude<RunStatus, "running"> =
        result.stopReason === "stopped" || run.stopRequested ? "stopped" : "done";
      this.finishRun(run, status, {
        message: this.buildFinalMessage(run, joined(result.content), {
          servedBy: result.servedBy,
          sources: ledger.list(),
          media: { images: result.images, videos: result.videos, audioUrl: result.audioUrl },
        }),
      });
    } catch (error) {
      syncSources();
      this.finishRun(run, run.stopRequested ? "stopped" : "error", {
        message: this.buildFinalMessage(run, run.content, {
          sources: ledger.list(),
          interrupted: run.content.trim().length > 0 && !run.stopRequested,
        }),
        error:
          run.stopRequested || !(error instanceof Error) ? undefined : capStr(error.message, 300),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Events, snapshots, persistence

  private liveKey(owner: string, conversationId: string): string {
    return `${owner}\u0000${conversationId}`;
  }

  private emit(run: LiveRun, event: RunEvent): void {
    run.seq += 1;
    const stamped = { ...event, seq: run.seq } as RunEvent;
    for (const send of [...run.subscribers]) {
      send(stamped);
    }
  }

  /** Text deltas are token-frequency — batch them to ~12 events/second. */
  private emitText(run: LiveRun, full: string): void {
    run.content = full;
    this.scheduleFlush(run);
    if (run.textTimer !== null) {
      return;
    }
    run.textTimer = setTimeout(() => {
      run.textTimer = null;
      this.emit(run, { t: "text", seq: 0, content: run.content });
    }, 80);
  }

  private captureCodeChanges(run: LiveRun, calls: RunToolRecord[]): void {
    const next = deriveCodeChangeFlow(calls, run.startedAt, run.codeChanges);
    if (!next || JSON.stringify(next) === JSON.stringify(run.codeChanges)) {
      return;
    }
    run.codeChanges = next;
    this.emit(run, { t: "code", seq: 0, codeChanges: next });
    this.scheduleFlush(run);
  }

  private emitTools(run: LiveRun): void {
    this.scheduleFlush(run);
    if (run.toolsTimer !== null) {
      return;
    }
    run.toolsTimer = setTimeout(() => {
      run.toolsTimer = null;
      this.emit(run, { t: "tools", seq: 0, toolCalls: this.cappedToolCalls(run.toolCalls, SNAP_TOOL_RESULT_CHARS) });
    }, 150);
  }

  private cappedToolCalls(calls: RunToolRecord[], resultCap: number): RunToolRecord[] {
    return calls.slice(-SNAP_TOOLCALLS).map((call) => ({
      id: call.id,
      name: call.name,
      arguments: capStr(call.arguments, FINAL_TOOL_ARGS_CHARS),
      status: call.status,
      ...(call.result !== undefined ? { result: capStr(call.result, resultCap) } : {}),
    }));
  }

  private snapshotOf(run: LiveRun): RunSnapshot {
    return {
      runId: run.runId,
      conversationId: run.conversationId,
      kind: run.kind,
      status: run.done ? "done" : "running",
      startedAt: run.startedAt,
      content: capStr(run.content, SNAP_CONTENT_CHARS),
      ...(run.reasoningTail ? { reasoningTail: run.reasoningTail } : {}),
      ...(run.toolCalls.length > 0
        ? { toolCalls: this.cappedToolCalls(run.toolCalls, SNAP_TOOL_RESULT_CHARS) }
        : {}),
      ...(run.codeChanges ? { codeChanges: run.codeChanges } : {}),
      ...(run.sources.length > 0 ? { sources: run.sources.slice(0, FINAL_SOURCES) } : {}),
      ...(run.research ? { research: run.research } : {}),
      ...(run.julius ? { julius: run.julius } : {}),
      ...(run.steered.length > 0 ? { steered: run.steered } : {}),
    };
  }

  /** Coalesced snapshot + heartbeat write (~1.5s) while the run streams. */
  private scheduleFlush(run: LiveRun): void {
    if (run.flushTimer !== null || run.done) {
      return;
    }
    run.flushTimer = setTimeout(() => {
      run.flushTimer = null;
      if (run.done) {
        return;
      }
      try {
        this.ctx.storage.sql.exec(
          "UPDATE agent_runs SET heartbeat_at = ?, snapshot = ? WHERE owner_email = ? AND conversation_id = ? AND run_id = ?",
          Date.now(),
          JSON.stringify(this.snapshotOf(run)),
          run.owner,
          run.conversationId,
          run.runId,
        );
      } catch (error) {
        console.error("run snapshot flush failed:", error instanceof Error ? error.message : "unknown");
      }
    }, 1_500);
  }

  private parseJson<T>(raw: string): T | null {
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async startRequestHash(body: StartRunBody): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private receiptRow(owner: string, runId: string): RunReceiptRow | undefined {
    return this.ctx.storage.sql
      .exec<RunReceiptRow>(
        "SELECT * FROM agent_run_receipts WHERE owner_email = ? AND run_id = ?",
        owner,
        runId,
      )
      .toArray()[0];
  }

  private runRowById(owner: string, runId: string): RunRow | undefined {
    return this.ctx.storage.sql
      .exec<RunRow>(
        "SELECT * FROM agent_runs WHERE owner_email = ? AND run_id = ?",
        owner,
        runId,
      )
      .toArray()[0];
  }

  private runRow(owner: string, conversationId: string): RunRow | undefined {
    return this.ctx.storage.sql
      .exec<RunRow>(
        "SELECT * FROM agent_runs WHERE owner_email = ? AND conversation_id = ?",
        owner,
        conversationId,
      )
      .toArray()[0];
  }

  // -------------------------------------------------------------------------
  // Finalization

  private storeMedia(run: LiveRun, items: Array<{ kind: "image" | "video" | "audio"; data: string }>): string[] {
    const refs: string[] = [];
    const now = Date.now();
    for (const item of items) {
      // Provider URLs stay as-is (nothing to store); data URLs get chunked.
      if (!item.data.startsWith("data:")) {
        refs.push(item.data);
        continue;
      }
      const idx = refs.length;
      for (let chunk = 0; chunk * MEDIA_CHUNK_CHARS < item.data.length; chunk += 1) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO agent_run_media (owner_email, run_id, idx, chunk, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          run.owner,
          run.runId,
          idx,
          chunk,
          item.kind,
          item.data.slice(chunk * MEDIA_CHUNK_CHARS, (chunk + 1) * MEDIA_CHUNK_CHARS),
          now,
        );
      }
      refs.push(cloudMediaRef(run.runId, idx));
    }
    return refs;
  }

  private buildFinalMessage(
    run: LiveRun,
    content: string,
    extra: {
      servedBy?: string;
      sources?: RunSource[];
      research?: ResearchState;
      julius?: JuliusState;
      interrupted?: boolean;
      media?: { images: string[]; videos: string[]; audioUrl?: string };
    },
  ): RunFinalMessage {
    const mediaItems: Array<{ kind: "image" | "video" | "audio"; data: string }> = [];
    for (const image of extra.media?.images ?? []) {
      mediaItems.push({ kind: "image", data: image });
    }
    for (const video of extra.media?.videos ?? []) {
      mediaItems.push({ kind: "video", data: video });
    }
    if (extra.media?.audioUrl) {
      mediaItems.push({ kind: "audio", data: extra.media.audioUrl });
    }
    const refs = mediaItems.length > 0 ? this.storeMedia(run, mediaItems) : [];
    const images: string[] = [];
    const videos: string[] = [];
    let audioUrl: string | undefined;
    refs.forEach((ref, index) => {
      const kind = mediaItems[index].kind;
      if (kind === "image") {
        images.push(ref);
      } else if (kind === "video") {
        videos.push(ref);
      } else {
        audioUrl = ref;
      }
    });
    const sources = (extra.sources ?? run.sources).slice(0, FINAL_SOURCES);
    return {
      id: run.body.config.resume?.messageId ?? run.body.assistantMessageId,
      content: capStr(content, FINAL_CONTENT_CHARS),
      ...(run.toolCalls.length > 0
        ? { toolCalls: this.cappedToolCalls(run.toolCalls, FINAL_TOOL_RESULT_CHARS).slice(-FINAL_TOOLCALLS) }
        : {}),
      ...(run.codeChanges ? { codeChanges: run.codeChanges } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(extra.servedBy ? { servedBy: extra.servedBy } : {}),
      ...(extra.research ? { research: extra.research } : {}),
      ...(extra.julius ? { julius: extra.julius } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(videos.length > 0 ? { videos } : {}),
      ...(audioUrl ? { audioUrl } : {}),
      ...(extra.interrupted ? { interrupted: true } : {}),
    };
  }

  private finishRun(
    run: LiveRun,
    status: Exclude<RunStatus, "running">,
    outcome: { message: RunFinalMessage; error?: string },
  ): void {
    if (run.done) {
      return;
    }
    const settledCodeChanges = finalizeCodeChangeFlow(run.toolCalls, run.startedAt, run.codeChanges);
    if (settledCodeChanges) {
      run.codeChanges = settledCodeChanges;
      outcome.message.codeChanges = settledCodeChanges;
    }
    if (run.body.automationId) {
      const marked = extractExecutionOutcomeMarker(outcome.message.content);
      outcome.message.content = marked.content;
      outcome.message.execution = buildExecutionOutcome({
        claim: run.executionClaim ?? marked.claim,
        content: marked.content,
        sources: outcome.message.sources ?? run.sources,
        toolCalls: run.toolCalls,
        codeChanges: outcome.message.codeChanges,
        technicalStatus:
          status === "done"
            ? "done"
            : status === "stopped"
              ? "stopped"
              : status === "interrupted"
                ? "interrupted"
                : "error",
        surface: "automation",
        error: outcome.error,
      });
    }
    if (run.textTimer !== null) {
      clearTimeout(run.textTimer);
      run.textTimer = null;
    }
    if (run.toolsTimer !== null) {
      clearTimeout(run.toolsTimer);
      run.toolsTimer = null;
    }
    if (run.flushTimer !== null) {
      clearTimeout(run.flushTimer);
      run.flushTimer = null;
    }
    let chatUpdatedAt = 0;
    let result: {
      message: RunFinalMessage;
      usageEvents: RunUsageEvent[];
      steered: RunSteerItem[];
      chatUpdatedAt: number;
    };
    const now = Date.now();
    try {
      this.ctx.storage.transactionSync(() => {
        if (run.chatWritable) {
          chatUpdatedAt = this.writeResultIntoChat(run, outcome.message);
        }
        result = {
          message: outcome.message,
          usageEvents: run.usageEvents,
          steered: run.steered,
          chatUpdatedAt,
        };
        const resultPayload = JSON.stringify(result);
        this.ctx.storage.sql.exec(
          `UPDATE agent_runs SET status = ?, finished_at = ?, heartbeat_at = ?, snapshot = ?, result = ?, error = ?
            WHERE owner_email = ? AND conversation_id = ? AND run_id = ?`,
          status,
          now,
          now,
          JSON.stringify({ ...this.snapshotOf(run), status }),
          resultPayload,
          outcome.error ?? "",
          run.owner,
          run.conversationId,
          run.runId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE agent_run_receipts SET status = ?, result = ?, error = ?, updated_at = ?
            WHERE owner_email = ? AND run_id = ?`,
          status,
          resultPayload,
          outcome.error ?? "",
          now,
          run.owner,
          run.runId,
        );
      });
    } catch (error) {
      console.error("run result write failed:", error instanceof Error ? error.message : "unknown");
      throw error;
    }
    run.done = true;
    this.emit(run, {
      t: "done",
      seq: 0,
      status,
      message: outcome.message,
      usageEvents: run.usageEvents,
      steered: run.steered,
      chatUpdatedAt,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    run.subscribers.clear();
    run.watchers.clear();
    this.live.delete(this.liveKey(run.owner, run.conversationId));
    console.log("run finished:", run.kind, status, run.conversationId);
  }

  /**
   * Writes the settled run into the chat history: steered user messages in
   * consumption order, then the assistant message (or a resume merge into the
   * existing bubble). LWW clock bump so normal sync delivers it everywhere.
   */
  private writeResultIntoChat(run: LiveRun, message: RunFinalMessage): number {
    const existing = this.ctx.storage.sql
      .exec<{ id: string; title: string; updated_at: number; payload: string }>(
        "SELECT id, title, updated_at, payload FROM chats WHERE owner_email = ? AND id = ?",
        run.owner,
        run.conversationId,
      )
      .toArray()[0];
    if (!existing) {
      return 0; // seed was never applied — history stays client-owned
    }
    type LooseMessage = Record<string, unknown>;
    type LooseChat = { messages?: unknown } & Record<string, unknown>;
    let chat: LooseChat;
    try {
      chat = JSON.parse(existing.payload) as LooseChat;
    } catch {
      return 0;
    }
    if (!Array.isArray(chat.messages)) {
      return 0;
    }
    const now = Date.now();
    const messages = chat.messages as LooseMessage[];

    // Steered messages land right above the assistant bubble.
    const steerMessages: LooseMessage[] = run.steered
      .filter((item) => !messages.some((entry) => entry.id === item.id))
      .map((item) => ({
        id: item.id,
        role: "user",
        content: capStr(item.text, STEER_TEXT_CHARS),
        ...(item.attachments.length > 0
          ? {
              attachments: item.attachments.slice(0, 6).map((file) => ({
                id: crypto.randomUUID(),
                name: capStr(file.name, 120),
                mime: file.mime,
                dataUrl: file.dataUrl,
                ...(file.text ? { text: file.text } : {}),
              })),
            }
          : {}),
        createdAt: now,
      }));

    const assistant: LooseMessage = {
      id: message.id,
      role: "assistant",
      content: message.content,
      createdAt: now,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.codeChanges ? { codeChanges: message.codeChanges } : {}),
      ...(message.execution ? { execution: message.execution } : {}),
      ...(message.sources ? { sources: message.sources } : {}),
      ...(message.servedBy ? { servedBy: message.servedBy } : {}),
      ...(message.research ? { research: message.research } : {}),
      ...(message.julius ? { julius: message.julius } : {}),
      ...(message.images ? { images: message.images } : {}),
      ...(message.videos ? { videos: message.videos } : {}),
      ...(message.audioUrl ? { audioUrl: message.audioUrl } : {}),
      ...(message.interrupted ? { interrupted: true } : {}),
    };

    const resumeId = run.body.config.resume?.messageId;
    const resumeIndex = resumeId ? messages.findIndex((entry) => entry.id === resumeId) : -1;
    if (resumeId && resumeIndex >= 0) {
      const base = messages[resumeIndex];
      const baseCalls = Array.isArray(base.toolCalls) ? (base.toolCalls as RunToolRecord[]) : [];
      const baseSources = Array.isArray(base.sources) ? (base.sources as RunSource[]) : [];
      const knownUrls = new Set(baseSources.map((item) => item.url));
      const baseCodeChanges = base.codeChanges as RunCodeChangeState | undefined;
      const mergedCodeChanges = mergeRunCodeChangeStates(baseCodeChanges, message.codeChanges);
      const merged: LooseMessage = {
        ...base,
        content: assistant.content,
        pending: undefined,
        interrupted: message.interrupted ? true : undefined,
        toolCalls: [...baseCalls, ...(message.toolCalls ?? [])].slice(-FINAL_TOOLCALLS),
        ...(mergedCodeChanges ? { codeChanges: mergedCodeChanges } : {}),
        ...(message.execution ? { execution: message.execution } : {}),
        sources: [...baseSources, ...(message.sources ?? []).filter((item) => !knownUrls.has(item.url))].slice(
          0,
          FINAL_SOURCES,
        ),
        ...(message.servedBy ? { servedBy: message.servedBy } : {}),
        ...(message.images
          ? { images: [...(Array.isArray(base.images) ? (base.images as string[]) : []), ...message.images] }
          : {}),
        ...(message.videos
          ? { videos: [...(Array.isArray(base.videos) ? (base.videos as string[]) : []), ...message.videos] }
          : {}),
        ...(message.audioUrl ? { audioUrl: message.audioUrl } : {}),
      };
      messages.splice(resumeIndex, 0, ...steerMessages);
      messages[messages.findIndex((entry) => entry.id === resumeId)] = merged;
    } else {
      const existingAssistantIndex = messages.findIndex(
        (entry) => entry.id === message.id && entry.role === "assistant",
      );
      if (existingAssistantIndex >= 0) {
        // A crash may happen after the chat write but before the terminal run
        // row update. Recovery is idempotent by assistant message id: never
        // duplicate or replace an already-settled answer with an interrupted
        // snapshot from the stale row.
        if (messages[existingAssistantIndex].pending !== true) {
          return existing.updated_at;
        }
        messages.splice(existingAssistantIndex, 1, ...steerMessages, assistant);
      } else {
        messages.push(...steerMessages, assistant);
      }
    }

    chat.messages = messages;
    const updatedAt = Math.max(now, existing.updated_at + 1);
    chat.updatedAt = updatedAt;

    let payload = JSON.stringify(chat);
    if (payload.length > CHAT_PAYLOAD_LIMIT) {
      // Runnable HTML and long patches are the first optional payload to trim;
      // the compact file ledger remains so the chat still tells what changed.
      for (const entry of messages) {
        const code = entry.codeChanges as RunCodeChangeState | undefined;
        if (!code) {
          continue;
        }
        entry.codeChanges = {
          ...code,
          preview: code.preview?.kind === "url" ? code.preview : undefined,
          files: code.files.map((file) => ({
            ...file,
            patch: file.patch ? capStr(file.patch, 2_000) : undefined,
            truncated: file.patch && file.patch.length > 2_000 ? true : file.truncated,
          })),
        };
      }
      payload = JSON.stringify(chat);
    }
    if (payload.length > CHAT_PAYLOAD_LIMIT) {
      // Progressive honest trims: shrink tool results, then drop them.
      for (const entry of messages) {
        if (Array.isArray(entry.toolCalls)) {
          entry.toolCalls = (entry.toolCalls as RunToolRecord[]).map((call) => ({
            ...call,
            result: call.result ? capStr(call.result, 400) : call.result,
          }));
        }
      }
      payload = JSON.stringify(chat);
    }
    if (payload.length > CHAT_PAYLOAD_LIMIT) {
      for (const entry of messages) {
        delete entry.toolCalls;
      }
      payload = JSON.stringify(chat);
    }
    if (payload.length > CHAT_PAYLOAD_LIMIT) {
      console.error("run result: chat payload too large — history stays client-owned");
      return 0;
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO chats (owner_email, id, title, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
      run.owner,
      run.conversationId,
      capStr(typeof chat.title === "string" && chat.title ? (chat.title as string) : existing.title, TITLE_LIMIT),
      payload,
      updatedAt,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM tombstones WHERE owner_email = ? AND id = ?",
      run.owner,
      run.conversationId,
    );
    return updatedAt;
  }

  // -------------------------------------------------------------------------
  // Seeding, recovery, GC

  /** LWW-guarded upsert of the client's seeded conversation. */
  private applyChatSeed(owner: string, body: StartRunBody): boolean {
    const seed = body.chatSeed;
    if (!seed || typeof seed.payload !== "string" || seed.payload.length === 0) {
      return false;
    }
    if (seed.payload.length > CHAT_PAYLOAD_LIMIT) {
      return false;
    }
    const updatedAt = Math.max(0, Math.floor(seed.updatedAt || 0));
    const existing = this.ctx.storage.sql
      .exec<{ updated_at: number }>(
        "SELECT updated_at FROM chats WHERE owner_email = ? AND id = ?",
        owner,
        body.conversationId,
      )
      .toArray()[0];
    if (existing && existing.updated_at >= updatedAt) {
      return true; // server already has this or newer — the run appends to it
    }
    if (!existing) {
      const count = (
        this.ctx.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM chats WHERE owner_email = ?", owner)
          .toArray()[0] ?? { n: 0 }
      ).n;
      if (count >= MAX_CHATS_PER_OWNER) {
        return false;
      }
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO chats (owner_email, id, title, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
      owner,
      body.conversationId,
      capStr(body.title || "Chat", TITLE_LIMIT),
      seed.payload,
      updatedAt || Date.now(),
    );
    // Starting a run in a thread resurrects it — explicit user intent.
    this.ctx.storage.sql.exec(
      "DELETE FROM tombstones WHERE owner_email = ? AND id = ?",
      owner,
      body.conversationId,
    );
    return true;
  }

  /**
   * Finalizes runs whose node died: status stays honest ("interrupted"), the
   * collected draft lands in the chat exactly as last persisted, and the
   * client's Continue affordance takes over. Also GC's old rows and media.
   */
  sweepStale(owner: string): void {
    const now = Date.now();
    try {
      const rows = this.ctx.storage.sql
        .exec<RunRow>(
          "SELECT * FROM agent_runs WHERE owner_email = ? AND status = 'running'",
          owner,
        )
        .toArray();
      for (const row of rows) {
        const live = this.live.get(this.liveKey(owner, row.conversation_id));
        if (live && live.runId === row.run_id && !live.done) {
          continue; // alive in this isolate — heartbeat will catch up
        }
        this.finalizeStaleRow(row);
      }
      // GC: acked/old finished rows and expired media.
      this.ctx.storage.sql.exec(
        "DELETE FROM agent_runs WHERE owner_email = ? AND status != 'running' AND (finished_at < ? OR (acked = 1 AND ephemeral = 1))",
        owner,
        now - ROW_TTL_MS,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM agent_run_receipts WHERE owner_email = ? AND updated_at < ?",
        owner,
        now - ROW_TTL_MS,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM agent_run_media WHERE owner_email = ? AND created_at < ?",
        owner,
        now - MEDIA_TTL_MS,
      );
    } catch (error) {
      console.error("run sweep failed:", error instanceof Error ? error.message : "unknown");
    }
  }

  private finalizeStaleRow(row: RunRow): void {
    const snapshot = this.parseJson<RunSnapshot>(row.snapshot);
    const content = snapshot?.content ?? "";
    const research = snapshot?.research
      ? {
          ...snapshot.research,
          status: "error" as const,
          steps: snapshot.research.steps.map((step) =>
            step.status === "running" ? { ...step, status: "error" as const } : step,
          ),
          finishedAt: Date.now(),
        }
      : undefined;
    const julius = snapshot?.julius
      ? {
          ...snapshot.julius,
          status: snapshot.julius.candidates.some((item) => item.content.trim().length > 0)
            ? ("choice" as const)
            : ("error" as const),
          candidates: snapshot.julius.candidates.map((item) =>
            item.status === "running" ? { ...item, status: "error" as const } : item,
          ),
          finishedAt: Date.now(),
        }
      : undefined;
    let automationId: string | undefined;
    let settledMessage: RunFinalMessage | undefined;
    const chatRow = this.ctx.storage.sql
      .exec<{ payload: string; updated_at: number }>(
        "SELECT payload FROM chats WHERE owner_email = ? AND id = ?",
        row.owner_email,
        row.conversation_id,
      )
      .toArray()[0];
    if (chatRow) {
      try {
        const chat = JSON.parse(chatRow.payload) as { automationId?: unknown; messages?: unknown };
        automationId = typeof chat.automationId === "string" && chat.automationId ? chat.automationId : undefined;
        const messages = Array.isArray(chat.messages) ? chat.messages : [];
        const existingAssistant = messages.find(
          (item): item is Record<string, unknown> =>
            Boolean(item) &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            (item as Record<string, unknown>).id === row.assistant_message_id &&
            (item as Record<string, unknown>).role === "assistant" &&
            (item as Record<string, unknown>).pending !== true,
        );
        if (existingAssistant && typeof existingAssistant.content === "string") {
          settledMessage = {
            ...(existingAssistant as unknown as RunFinalMessage),
            id: row.assistant_message_id,
            content: existingAssistant.content,
          };
        }
      } catch {
        automationId = undefined;
      }
    }
    if (settledMessage && chatRow) {
      const now = Date.now();
      const resultPayload = JSON.stringify({
        message: settledMessage,
        usageEvents: [],
        steered: snapshot?.steered ?? [],
        chatUpdatedAt: chatRow.updated_at,
      });
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO agent_run_receipts
          (owner_email, run_id, conversation_id, request_hash, status, history_on_server, result, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'done', 1, ?, '', ?, ?)`,
        row.owner_email,
        row.run_id,
        row.conversation_id,
        `legacy:${row.run_id}`,
        resultPayload,
          row.started_at,
          now,
        );
        this.ctx.storage.sql.exec(
          `UPDATE agent_runs SET status = 'done', finished_at = ?, heartbeat_at = ?, snapshot = ?, result = ?, error = ''
         WHERE owner_email = ? AND conversation_id = ? AND run_id = ? AND status = 'running'`,
        now,
        now,
        JSON.stringify(snapshot ? { ...snapshot, status: "done" } : {}),
        resultPayload,
        row.owner_email,
        row.conversation_id,
          row.run_id,
        );
        this.ctx.storage.sql.exec(
          `UPDATE agent_run_receipts SET status = 'done', result = ?, error = '', updated_at = ?
         WHERE owner_email = ? AND run_id = ? AND status = 'running'`,
        resultPayload,
        now,
          row.owner_email,
          row.run_id,
        );
      });
      console.log("orphaned run recovered from settled chat:", row.conversation_id);
      return;
    }
    const message: RunFinalMessage = {
      id: row.assistant_message_id,
      content,
      ...(snapshot?.toolCalls ? { toolCalls: snapshot.toolCalls } : {}),
      ...(snapshot?.sources ? { sources: snapshot.sources } : {}),
      ...(research ? { research } : {}),
      ...(julius ? { julius } : {}),
      ...(automationId
        ? {
            execution: buildExecutionOutcome({
              content,
              sources: snapshot?.sources,
              toolCalls: snapshot?.toolCalls,
              technicalStatus: "interrupted",
              surface: "automation",
              error: "The server node restarted before the autonomous run finished.",
            }),
          }
        : {}),
      interrupted: true,
    };
    let chatUpdatedAt = 0;
    const fake: LiveRun = {
        owner: row.owner_email,
        runId: row.run_id,
        conversationId: row.conversation_id,
        kind: (row.kind as RunKind) || "chat",
        startedAt: row.started_at,
        body: {
          runId: row.run_id,
          conversationId: row.conversation_id,
          assistantMessageId: row.assistant_message_id,
          kind: (row.kind as RunKind) || "chat",
          title: row.title,
          modelId: row.model_id,
          ...(automationId ? { automationId } : {}),
          config: { history: [], prompt: "", builtins: {} as never, mcpServers: [] },
        },
        chatWritable: true,
        content,
        reasoningTail: "",
        toolCalls: snapshot?.toolCalls ?? [],
        sources: snapshot?.sources ?? [],
        steered: snapshot?.steered ?? [],
        usageEvents: [],
        seq: 0,
        inbox: [],
        watchers: new Set(),
        stopRequested: false,
        subscribers: new Set(),
        done: false,
        textTimer: null,
        toolsTimer: null,
      flushTimer: null,
    };
    const now = Date.now();
    const error = "The server node running this reply restarted — the collected draft is shown as-is.";
    this.ctx.storage.transactionSync(() => {
      if (row.ephemeral !== 1) {
        chatUpdatedAt = this.writeResultIntoChat(fake, message);
      }
      const resultPayload = JSON.stringify({
        message,
        usageEvents: [],
        steered: snapshot?.steered ?? [],
        chatUpdatedAt,
      });
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO agent_run_receipts
        (owner_email, run_id, conversation_id, request_hash, status, history_on_server, result, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'interrupted', ?, ?, ?, ?, ?)`,
      row.owner_email,
      row.run_id,
      row.conversation_id,
      `legacy:${row.run_id}`,
      row.ephemeral === 1 ? 0 : 1,
      resultPayload,
      error,
        row.started_at,
        now,
      );
      this.ctx.storage.sql.exec(
        `UPDATE agent_runs SET status = 'interrupted', finished_at = ?, heartbeat_at = ?, snapshot = ?, result = ?, error = ?
        WHERE owner_email = ? AND conversation_id = ? AND run_id = ? AND status = 'running'`,
      now,
      now,
      JSON.stringify(snapshot ? { ...snapshot, status: "interrupted" } : {}),
      resultPayload,
      error,
      row.owner_email,
        row.conversation_id,
        row.run_id,
      );
      this.ctx.storage.sql.exec(
        `UPDATE agent_run_receipts SET status = 'interrupted', result = ?, error = ?, updated_at = ?
        WHERE owner_email = ? AND run_id = ? AND status = 'running'`,
      resultPayload,
      error,
      now,
        row.owner_email,
        row.run_id,
      );
    });
    console.log("stale run finalized as interrupted:", row.conversation_id);
  }

  // -------------------------------------------------------------------------
  // MCP config + OAuth grants. Browser requests carry ids/scopes, never the
  // authoritative connector configuration used by a run.

  private profileMcpConfigsForRun(owner: string, requested: Array<Record<string, unknown>>): unknown[] {
    const ids = new Set<string>();
    for (const item of requested) {
      if (typeof item.id === "string" && item.id) ids.add(item.id);
      if (typeof item.catalogId === "string" && item.catalogId) ids.add(item.catalogId);
    }
    if (ids.size === 0) return [];
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
      .toArray()[0];
    try {
      const parsed = row ? JSON.parse(row.payload) as unknown : null;
      const settings = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).settings
        : null;
      const servers = settings && typeof settings === "object" && !Array.isArray(settings)
        ? (settings as Record<string, unknown>).mcpServers
        : null;
      if (!Array.isArray(servers)) return [];
      const secretRows = this.ctx.storage.sql
        .exec<{ server_id: string; payload: string }>(
          "SELECT server_id, payload FROM mcp_server_secrets WHERE owner_email = ?",
          owner,
        )
        .toArray();
      const secrets = new Map<string, Record<string, unknown>>();
      for (const secret of secretRows) {
        try {
          secrets.set(secret.server_id, JSON.parse(secret.payload) as Record<string, unknown>);
        } catch {
          // malformed secret rows authenticate nothing
        }
      }
      return servers.flatMap((item): unknown[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const server = item as Record<string, unknown>;
        const id = typeof server.id === "string" ? server.id : "";
        const catalogId = typeof server.catalogId === "string" ? server.catalogId : "";
        if (!ids.has(id) && !ids.has(catalogId)) return [];
        return [{ ...server, ...(secrets.get(id) ?? {}) }];
      });
    } catch {
      return [];
    }
  }

  private async markOAuthRefreshStarted(owner: string, serverId: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO mcp_oauth_states
        (owner_email, server_id, state, error_code, retry_after, updated_at)
       VALUES (?, ?, 'refreshing', '', 0, ?)
       ON CONFLICT(owner_email, server_id) DO UPDATE SET
         state = CASE
           WHEN mcp_oauth_states.state = 'refresh_unknown' THEN 'refresh_unknown'
           ELSE 'refreshing'
         END,
         error_code = CASE
           WHEN mcp_oauth_states.state = 'refresh_unknown' THEN mcp_oauth_states.error_code
           ELSE ''
         END,
         retry_after = 0,
         updated_at = excluded.updated_at`,
      owner,
      serverId,
      now,
    );
  }

  private oauthGrantState(owner: string, serverId: string): string {
    return this.ctx.storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM mcp_oauth_states WHERE owner_email = ? AND server_id = ?",
        owner,
        serverId,
      )
      .toArray()[0]?.state ?? "ready";
  }

  private async recordOAuthFailure(
    owner: string,
    serverId: string,
    outcome: CloudOAuthRefreshFailure,
  ): Promise<void> {
    const previousState = this.oauthGrantState(owner, serverId);
    const stepUpCodes = new Set(["interaction_required", "consent_required", "insufficient_scope", "invalid_scope"]);
    const followsUnknownRotation = previousState === "refresh_unknown" && outcome.code === "invalid_grant";
    const state = outcome.transient
      ? outcome.ambiguous ? "refresh_unknown" : "retryable_error"
      : followsUnknownRotation || stepUpCodes.has(outcome.code)
        ? "step_up_required"
        : "reauth_required";
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO mcp_oauth_states
        (owner_email, server_id, state, error_code, retry_after, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      owner,
      serverId,
      state,
      capStr(outcome.code, 120),
      outcome.transient ? Date.now() + 30_000 : 0,
      Date.now(),
    );
  }

  private markOAuthReady(owner: string, serverId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO mcp_oauth_states
        (owner_email, server_id, state, error_code, retry_after, updated_at)
       VALUES (?, ?, 'ready', '', 0, ?)`,
      owner,
      serverId,
      Date.now(),
    );
  }

  private async oauthTokensFor(
    owner: string,
  ): Promise<{ tokens: Record<string, CloudOAuthToken>; appliedChains: Map<string, string[]> }> {
    const profileRow = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM profiles WHERE owner_email = ?", owner)
      .toArray()[0];
    let parsed: unknown = null;
    if (profileRow) {
      try {
        parsed = JSON.parse(profileRow.payload);
      } catch {
        parsed = null;
      }
    }
    const raw =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).mcpOAuth
        : undefined;
    const tokens = cloudOAuthTokens(raw);
    const durableRows = this.ctx.storage.sql
      .exec<{ server_id: string; payload: string }>(
        "SELECT server_id, payload FROM mcp_oauth_grants WHERE owner_email = ?",
        owner,
      )
      .toArray();
    for (const row of durableRows) {
      // Sealed at rest; a row this key cannot open authenticates nothing and
      // surfaces as a missing grant rather than a crashed run.
      try {
        const token = await openGrantPayload(this.vault, owner, row.server_id, row.payload);
        if (token) tokens[row.server_id] = token;
      } catch (error) {
        if (!(error instanceof SecretVaultError)) throw error;
        console.error("oauth grant unreadable", row.server_id, error.code);
      }
    }
    const revoked = this.ctx.storage.sql
      .exec<{ server_id: string }>(
        "SELECT server_id FROM mcp_oauth_revocations WHERE owner_email = ?",
        owner,
      )
      .toArray();
    for (const row of revoked) {
      delete tokens[row.server_id];
    }
    const blocked = this.ctx.storage.sql
      .exec<{ server_id: string }>(
        "SELECT server_id FROM mcp_oauth_states WHERE owner_email = ? AND state IN ('reauth_required', 'step_up_required')",
        owner,
      )
      .toArray();
    for (const row of blocked) {
      delete tokens[row.server_id];
    }
    const prefix = `${OAUTH_REF_PREFIX}${owner}:`;
    const rows = await this.ctx.storage.list<unknown>({ prefix });
    const rotations: OAuthRotation[] = [];
    for (const [key, value] of rows) {
      const serverId = key.slice(prefix.length);
      let opened: unknown = null;
      try {
        opened = await openRotationValue(this.vault, owner, serverId, value);
      } catch (error) {
        if (!(error instanceof SecretVaultError)) throw error;
      }
      const rotation = normalizeOAuthOverride(serverId, opened);
      if (rotation) {
        rotations.push(rotation);
      } else {
        await this.ctx.storage.delete(key); // malformed or unreadable — cannot authenticate anything
      }
    }
    const { appliedChains, staleIds } = overlayOAuthRotations(tokens, rotations);
    for (const id of staleIds) {
      await this.ctx.storage.delete(`${prefix}${id}`); // caught up or replaced by a fresh sign-in
    }
    return { tokens, appliedChains };
  }

  /**
   * Persists grants rotated during the run — losing them would strand later
   * runs AND the browser's synced copy. The chain stays anchored to the
   * browser-synced token, so sync (and the browser's rescue call) can
   * recognize the rotation and hand the fresh pair back.
   */
  private async persistRefreshedGrant(
    owner: string,
    rotated: RefreshedOAuth,
    appliedChains: Map<string, string[]>,
  ): Promise<void> {
    // SQL is the canonical grant source. Calling the same resolver used by
    // run arming also overlays a still-live legacy rotation, so old accounts
    // migrate safely without letting the deleted profile.mcpOAuth field make
    // every new server-owned grant look stale.
    const { tokens: currentTokens } = await this.oauthTokensFor(owner);
    const currentAccess = currentTokens[rotated.serverId]?.accessToken;
    if (currentAccess !== rotated.baseAccessToken && currentAccess !== rotated.token.accessToken) {
      throw new Error("stale OAuth refresh result");
    }
    const bases = chainRotationBases(appliedChains, rotated);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO mcp_oauth_grants (owner_email, server_id, payload, updated_at) VALUES (?, ?, ?, ?)",
      owner,
      rotated.serverId,
      await sealGrantPayload(this.vault, owner, rotated.serverId, rotated.token),
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM mcp_oauth_revocations WHERE owner_email = ? AND server_id = ?",
      owner,
      rotated.serverId,
    );
    this.markOAuthReady(owner, rotated.serverId);
    await this.ctx.storage.delete(`${OAUTH_REF_PREFIX}${owner}:${rotated.serverId}`);
    appliedChains.set(rotated.serverId, bases);
  }
}
