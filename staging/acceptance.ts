#!/usr/bin/env bun

/**
 * Public black-box Cloudflare acceptance runner.
 *
 * Required environment:
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 *
 * Optional preselected secrets (otherwise generated in memory):
 *   STAGING_AUTH_SECRET, CONTROL_SECRET, GATEWAY_SECRET
 *
 * Optional controls:
 *   STAGING_IDLE_MS=70000, STAGING_SKIP_BROWSER=1,
 *   STAGING_EVIDENCE_FILE=/absolute/or/relative/report.json
 *
 * Run from the repository root:
 *   bun staging/acceptance.ts
 */

type JsonRecord = Record<string, unknown>;

type ProviderStats = {
  registrations: number;
  authorizations: number;
  codeExchanges: number;
  refreshes: number;
  initialize: number;
  toolLists: number;
  toolCalls: number;
  gatewayCalls: number;
  violations: number;
  generation: number;
};

type ProviderSnapshot = {
  stats: ProviderStats;
  config: JsonRecord;
  grant: { generation: number; expired: boolean } | null;
};

type EvidencePhase = "deploy" | "A" | "idle" | "A→B" | "B" | "browser";

type EvidenceRow = {
  phase: EvidencePhase;
  test: string;
  expected: string;
  actual: string;
  passed: boolean;
};

type Deployment = {
  url: string;
  versionId: string;
};

type HttpResult<T> = {
  status: number;
  data: T;
  headers: Headers;
};

type OAuthProof = {
  state: string;
  browserNonce: string;
};

type ActiveRun = {
  runId?: unknown;
  conversationId?: unknown;
  status?: unknown;
  result?: unknown;
};

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");
const PROVIDER_CONFIG = "staging/provider/wrangler.toml";
const BACKEND_CONFIG = "staging/wrangler.backend.toml";
const evidence: EvidenceRow[] = [];

function help(): void {
  console.log(`Gera Cloudflare persistence acceptance

Required:
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID

Optional:
  STAGING_AUTH_SECRET   generated in memory when absent
  CONTROL_SECRET        generated in memory when absent
  GATEWAY_SECRET        generated in memory when absent
  STAGING_IDLE_MS       idle reconnect wait, default 70000
  STAGING_SKIP_BROWSER  set to 1 to skip the real Chromium reconnect
  STAGING_EVIDENCE_FILE optional JSON report path

Command:
  bun staging/acceptance.ts`);
}

function randomSecret(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function safeChildEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "BUN_INSTALL", "NODE_EXTRA_CA_CERTS"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if ((key.startsWith("EXPO_PUBLIC_") || key.startsWith("VITE_")) && value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

function safeUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} did not produce a URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must be HTTPS without embedded credentials`);
  }
  return parsed.origin;
}

function safeActual(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/[\r\n]+/g, " ").slice(0, 220);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  return value && typeof value === "object" ? `{${Object.keys(value as JsonRecord).slice(0, 8).join(",")}}` : typeof value;
}

function verify(
  phase: EvidencePhase,
  test: string,
  passed: boolean,
  expected: string,
  actual: unknown,
): void {
  const row: EvidenceRow = { phase, test, expected, actual: safeActual(actual), passed };
  evidence.push(row);
  console.log(`${passed ? "PASS" : "FAIL"} [${phase}] ${test} — ${row.actual}`);
  if (!passed) {
    throw new Error(`${test}: expected ${expected}; got ${row.actual}`);
  }
}

function publicResponseHasProviderCredential(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return /"(?:access_?token|refresh_?token|client_?secret|code_?verifier|authorization_?code|token|headersJson|Authorization)"\s*:/i.test(serialized);
}

function providerStatsValue(value: unknown): ProviderSnapshot {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
  const rawStats = record.stats && typeof record.stats === "object" && !Array.isArray(record.stats)
    ? record.stats as JsonRecord
    : {};
  const number = (key: keyof ProviderStats): number => {
    const candidate = rawStats[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
  };
  return {
    stats: {
      registrations: number("registrations"),
      authorizations: number("authorizations"),
      codeExchanges: number("codeExchanges"),
      refreshes: number("refreshes"),
      initialize: number("initialize"),
      toolLists: number("toolLists"),
      toolCalls: number("toolCalls"),
      gatewayCalls: number("gatewayCalls"),
      violations: number("violations"),
      generation: number("generation"),
    },
    config: record.config && typeof record.config === "object" && !Array.isArray(record.config)
      ? record.config as JsonRecord
      : {},
    grant: record.grant && typeof record.grant === "object" && !Array.isArray(record.grant)
      ? record.grant as { generation: number; expired: boolean }
      : null,
  };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function stagingJwt(secret: string, subject: string, email: string): Promise<string> {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    sub: subject,
    email,
    name: "Gera staging acceptance",
    aud: "gera-staging",
    exp: Math.floor(Date.now() / 1_000) + 4 * 60 * 60,
  })));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  ));
  return `${header}.${payload}.${base64Url(signature)}`;
}

async function runCommand(command: string[], input?: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: process.env,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    child.stdin.write(`${input}\n`);
    child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}\n${stderr}`.trim();
  if (exitCode !== 0) {
    const sanitized = output
      .split("\n")
      .filter((line) => !/secret|token/i.test(line))
      .slice(-12)
      .join("\n");
    throw new Error(`command failed (${command.slice(0, 4).join(" ")}): ${sanitized || `exit ${exitCode}`}`);
  }
  return output;
}

function deploymentFromOutput(output: string, fallbackUrl?: string): Deployment {
  const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi) ?? [];
  const versionMatches = [...output.matchAll(/(?:Current\s+)?Version ID:\s*([a-z0-9-]+)/gi)];
  const url = urls.at(-1) || fallbackUrl?.trim() || "";
  return {
    url: safeUrl(url, "wrangler deployment"),
    versionId: versionMatches.at(-1)?.[1] ?? "wrangler-version-unreported",
  };
}

async function deploy(
  config: string,
  vars: Record<string, string>,
  workerName: string,
  fallbackUrl?: string,
): Promise<Deployment> {
  const args = ["bunx", "wrangler", "deploy", "--config", config, "--name", workerName];
  for (const [key, value] of Object.entries(vars)) {
    args.push("--var", `${key}:${value}`);
  }
  const output = await runCommand(args);
  return deploymentFromOutput(output, fallbackUrl);
}

async function putSecret(config: string, name: string, value: string, workerName: string): Promise<void> {
  await runCommand(
    ["bunx", "wrangler", "secret", "put", name, "--config", config, "--name", workerName],
    value,
  );
}

async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = 20_000,
): Promise<HttpResult<T>> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const data = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, data, headers: response.headers };
}

function backendRequest<T>(
  backendUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<HttpResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetchJson<T>(new URL(path, backendUrl).toString(), { ...init, headers }, timeoutMs);
}

function providerRequest<T>(
  providerUrl: string,
  controlSecret: string,
  path: string,
  init: RequestInit = {},
): Promise<HttpResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${controlSecret}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetchJson<T>(new URL(path, providerUrl).toString(), { ...init, headers });
}

async function providerControl(
  providerUrl: string,
  controlSecret: string,
  patch: JsonRecord,
  phase: EvidencePhase,
): Promise<void> {
  const response = await providerRequest<JsonRecord>(providerUrl, controlSecret, "/control", {
    method: "POST",
    body: JSON.stringify(patch),
  });
  verify(phase, "provider control accepted", response.status === 200, "HTTP 200", response.status);
}

async function providerStats(providerUrl: string, controlSecret: string): Promise<ProviderSnapshot> {
  const response = await providerRequest<unknown>(providerUrl, controlSecret, "/stats");
  if (response.status !== 200) {
    throw new Error(`provider stats returned HTTP ${response.status}`);
  }
  return providerStatsValue(response.data);
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!predicate(latest) && Date.now() < deadline) {
    await Bun.sleep(250);
    latest = await read();
  }
  if (!predicate(latest)) {
    throw new Error(`${label} timed out after ${timeoutMs}ms`);
  }
  return latest;
}

function mcpServer(providerUrl: string, runTag: string): JsonRecord {
  return {
    id: `blackbox-${runTag}`,
    catalogId: "blackbox",
    name: "Gera black-box MCP",
    url: new URL("/mcp", providerUrl).toString(),
    authMode: "oauth",
    enabled: true,
    status: "connected",
    credentialStored: true,
    tools: [],
    disabledTools: [],
  };
}

async function oauthAuthorize(params: {
  backendUrl: string;
  providerUrl: string;
  controlSecret: string;
  token: string;
  otherToken: string;
  server: JsonRecord;
  phase: EvidencePhase;
  assertGuards: boolean;
}): Promise<OAuthProof> {
  const before = await providerStats(params.providerUrl, params.controlSecret);
  const start = await backendRequest<JsonRecord>(params.backendUrl, params.token, "/mcp/oauth-start", {
    method: "POST",
    headers: { Origin: params.backendUrl },
    body: JSON.stringify({ server: params.server }),
  });
  const authorizationUrl = typeof start.data.authorizationUrl === "string" ? start.data.authorizationUrl : "";
  const state = typeof start.data.state === "string" ? start.data.state : "";
  const browserNonce = typeof start.data.browserNonce === "string" ? start.data.browserNonce : "";
  verify(params.phase, "OAuth start returned only browser proof", start.status === 200 && Boolean(authorizationUrl && state && browserNonce) && !publicResponseHasProviderCredential(start.data), "HTTP 200, state/nonce, no provider credential", start.status);

  const authorization = await fetch(authorizationUrl, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const callbackUrl = authorization.headers.get("Location") ?? "";
  verify(params.phase, "provider authorization redirected to callback", authorization.status === 302 && callbackUrl.startsWith(params.backendUrl), "302 to staging backend callback", authorization.status);

  const callback = await fetch(callbackUrl, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const popupUrl = callback.headers.get("Location") ?? "";
  const popup = new URL(popupUrl);
  const challenge = popup.searchParams.get("challenge") ?? "";
  verify(params.phase, "public callback returned status-only popup proof", callback.status === 302 && popup.searchParams.get("state") === state && popup.searchParams.get("status") === "confirm" && Boolean(challenge) && !popup.searchParams.has("code") && !popup.searchParams.has("access_token"), "302 with challenge and no provider code/token", callback.status);

  if (params.assertGuards) {
    const replay = await fetch(callbackUrl, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const replayPopup = new URL(replay.headers.get("Location") ?? "https://invalid.example");
    verify(
      params.phase,
      "lost callback response replays the same durable challenge",
      replay.status === 302 && replayPopup.searchParams.get("challenge") === challenge,
      "HTTP 302 with the same challenge",
      replay.status,
    );

    const crossAccount = await backendRequest<JsonRecord>(params.backendUrl, params.otherToken, "/mcp/oauth-complete", {
      method: "POST",
      body: JSON.stringify({ state, browserNonce, callbackChallenge: challenge }),
    });
    verify(params.phase, "cross-account OAuth completion rejected", crossAccount.status === 404, "HTTP 404", crossAccount.status);

    const wrongProof = await backendRequest<JsonRecord>(params.backendUrl, params.token, "/mcp/oauth-complete", {
      method: "POST",
      body: JSON.stringify({ state, browserNonce: `${browserNonce}-wrong`, callbackChallenge: challenge }),
    });
    verify(params.phase, "OAuth completion requires both browser proofs", wrongProof.status === 403, "HTTP 403", wrongProof.status);
  }

  const complete = await backendRequest<JsonRecord>(params.backendUrl, params.token, "/mcp/oauth-complete", {
    method: "POST",
    body: JSON.stringify({ state, browserNonce, callbackChallenge: challenge }),
  });
  verify(params.phase, "OAuth code exchange committed server-side", complete.status === 200 && complete.data.status === "completed" && !publicResponseHasProviderCredential(complete.data), "completed with no provider credential", complete.status);

  if (params.assertGuards) {
    const consumedReplay = await fetch(callbackUrl, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    verify(params.phase, "completed OAuth callback route is consumed", consumedReplay.status === 400, "HTTP 400", consumedReplay.status);
  }

  const status = await backendRequest<JsonRecord>(params.backendUrl, params.token, `/mcp/oauth-status?state=${encodeURIComponent(state)}`);
  verify(params.phase, "OAuth status survives a new public request", status.status === 200 && status.data.status === "completed" && !publicResponseHasProviderCredential(status.data), "completed with no provider credential", status.status);

  const after = await providerStats(params.providerUrl, params.controlSecret);
  verify(params.phase, "authorization code redeemed exactly once", after.stats.codeExchanges - before.stats.codeExchanges === 1, "one code exchange", after.stats.codeExchanges - before.stats.codeExchanges);
  return { state, browserNonce };
}

async function checkMcp(
  backendUrl: string,
  token: string,
  server: JsonRecord,
  timeoutMs: number = 25_000,
  signal?: AbortSignal,
): Promise<HttpResult<JsonRecord>> {
  return backendRequest<JsonRecord>(backendUrl, token, "/mcp/check", {
    method: "POST",
    body: JSON.stringify({ server }),
    signal,
  }, timeoutMs);
}

function conversationPayload(id: string, marker: string, updatedAt: number): string {
  return JSON.stringify({
    id,
    title: `Staging ${marker}`,
    modelId: "staging/deterministic",
    messages: [{ id: `${id}-user`, role: "user", content: marker, createdAt: updatedAt }],
    createdAt: updatedAt,
    updatedAt,
  });
}

function runBody(params: {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  serverId: string;
  marker: string;
}): JsonRecord {
  const now = Date.now();
  const user = { id: `${params.conversationId}-user`, role: "user", content: params.marker, createdAt: now };
  const seed = {
    id: params.conversationId,
    title: `Staging run ${params.marker}`,
    modelId: "staging/deterministic",
    messages: [user],
    createdAt: now,
    updatedAt: now,
  };
  return {
    runId: params.runId,
    conversationId: params.conversationId,
    assistantMessageId: params.assistantMessageId,
    kind: "chat",
    title: seed.title,
    modelId: "staging/deterministic",
    chatSeed: { payload: JSON.stringify(seed), updatedAt: now },
    config: {
      history: [{ role: "user", content: params.marker }],
      prompt: params.marker,
      builtins: {
        web_search: false,
        fetch_url: false,
        selfsurf: false,
        generate_image: false,
        generate_video: false,
        generate_audio: false,
      },
      mcpServers: [{ id: params.serverId, catalogId: "blackbox" }],
    },
  };
}

async function activeRuns(backendUrl: string, token: string): Promise<ActiveRun[]> {
  const response = await backendRequest<{ runs?: unknown }>(backendUrl, token, "/runs/active");
  if (response.status !== 200 || !Array.isArray(response.data.runs)) {
    throw new Error(`/runs/active returned HTTP ${response.status}`);
  }
  return response.data.runs.filter(
    (item): item is ActiveRun => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

async function waitRunTerminal(
  backendUrl: string,
  token: string,
  runId: string,
  timeoutMs: number = 30_000,
): Promise<ActiveRun> {
  const runs = await waitFor(
    () => activeRuns(backendUrl, token),
    (items) => items.some((item) => item.runId === runId && item.status !== "running"),
    timeoutMs,
    `run ${runId}`,
  );
  const run = runs.find((item) => item.runId === runId && item.status !== "running");
  if (!run) throw new Error(`terminal run ${runId} disappeared`);
  return run;
}

async function writeEvidence(report: JsonRecord): Promise<void> {
  const target = process.env.STAGING_EVIDENCE_FILE?.trim();
  if (!target) return;
  const path = target.startsWith("/") ? target : `${ROOT}/${target}`;
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Evidence written to ${target}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }
  requiredEnv("CLOUDFLARE_API_TOKEN");
  requiredEnv("CLOUDFLARE_ACCOUNT_ID");

  const authSecret = process.env.STAGING_AUTH_SECRET?.trim() || randomSecret("auth");
  const controlSecret = process.env.CONTROL_SECRET?.trim() || randomSecret("control");
  const gatewaySecret = process.env.GATEWAY_SECRET?.trim() || randomSecret("gateway");
  const idleMsRaw = Number(process.env.STAGING_IDLE_MS ?? "70000");
  const idleMs = Number.isFinite(idleMsRaw) ? Math.max(0, Math.min(10 * 60_000, Math.floor(idleMsRaw))) : 70_000;
  const skipBrowser = process.env.STAGING_SKIP_BROWSER === "1";
  const runTag = crypto.randomUUID().replace(/-/g, "").slice(0, 14);
  const providerWorkerName = `gera-oauth-provider-${runTag}`;
  const backendWorkerName = `gera-persistence-${runTag}`;

  console.log("Deploying isolated deterministic provider…");
  const providerInitial = await deploy(PROVIDER_CONFIG, {}, providerWorkerName, process.env.STAGING_PROVIDER_URL);
  await putSecret(PROVIDER_CONFIG, "CONTROL_SECRET", controlSecret, providerWorkerName);
  await putSecret(PROVIDER_CONFIG, "GATEWAY_SECRET", gatewaySecret, providerWorkerName);
  const provider = await deploy(PROVIDER_CONFIG, {}, providerWorkerName, providerInitial.url);
  verify("deploy", "provider deployed", Boolean(provider.url), "public workers.dev URL", provider.url);

  console.log("Deploying backend version A with stable Durable Object bindings…");
  const backendVarsA = {
    STAGING_VERSION: `A-${runTag}`,
    STAGING_GATEWAY_URL: new URL("/v1/chat/completions", provider.url).toString(),
  };
  const backendInitial = await deploy(BACKEND_CONFIG, backendVarsA, backendWorkerName, process.env.STAGING_BACKEND_URL);
  await putSecret(BACKEND_CONFIG, "STAGING_AUTH_SECRET", authSecret, backendWorkerName);
  await putSecret(BACKEND_CONFIG, "STAGING_GATEWAY_SECRET", gatewaySecret, backendWorkerName);
  const backendA = await deploy(BACKEND_CONFIG, backendVarsA, backendWorkerName, backendInitial.url);
  verify("deploy", "backend version A deployed", Boolean(backendA.url), "public workers.dev URL", backendA.url);

  const versionA = await fetchJson<JsonRecord>(new URL("/__staging/version", backendA.url).toString());
  verify("A", "version marker A is public", versionA.status === 200 && versionA.data.version === backendVarsA.STAGING_VERSION, backendVarsA.STAGING_VERSION, versionA.data.version ?? versionA.status);

  await providerControl(provider.url, controlSecret, { reset: true }, "A");
  await providerControl(provider.url, controlSecret, {
    accessTtlSeconds: 4,
    mcpDelayMs: 0,
    refreshDelayMs: 0,
    refreshResponseDelayMs: 0,
    idempotencyReplayDelayMs: 0,
    gatewayFinalDelayMs: 0,
    holdRefreshResponse: false,
    holdGatewayFinal: false,
    mcp401Once: false,
    refresh503Once: false,
    invalidGrant: false,
  }, "A");

  const subject = `staging-subject-${runTag}`;
  const otherSubject = `staging-other-${runTag}`;
  const emailA = `gera-staging-${runTag}@rork.com`;
  const emailAlias = `gera-staging-${runTag}-renamed@rork.com`;
  const otherEmail = `gera-staging-${runTag}-other@rork.com`;
  const tokenA = await stagingJwt(authSecret, subject, emailA);
  const tokenAlias = await stagingJwt(authSecret, subject, emailAlias);
  const tokenOther = await stagingJwt(authSecret, otherSubject, otherEmail);
  const tokenAliasAttacker = await stagingJwt(authSecret, otherSubject, emailA);

  const access = await backendRequest<JsonRecord>(backendA.url, tokenA, "/access/status", {
    headers: {
      "X-Rork-User-Id": "spoofed-subject",
      "X-Rork-User-Email": "attacker@example.com",
    },
  });
  verify("A", "verified JWT overrides spoofed identity headers", access.status === 200 && access.data.status === "invited" && access.data.email === emailA, `invited ${emailA}`, `${access.status}:${String(access.data.email ?? "")}`);

  const otherAccess = await backendRequest<JsonRecord>(backendA.url, tokenOther, "/access/status");
  verify("A", "second verified principal is independently invited", otherAccess.status === 200 && otherAccess.data.status === "invited", "HTTP 200 invited", otherAccess.status);

  const occupiedAlias = await backendRequest<JsonRecord>(backendA.url, tokenAliasAttacker, "/access/status");
  verify("A", "occupied email alias cannot be claimed by another subject", occupiedAlias.status === 409 && occupiedAlias.data.error === "principal_conflict", "HTTP 409 principal_conflict", `${occupiedAlias.status}:${String(occupiedAlias.data.error ?? "")}`);

  const server = mcpServer(provider.url, runTag);
  const chatId = `chat-${runTag}`;
  const deletedChatId = `deleted-${runTag}`;
  const chatMarker = `PERSIST_CHAT_${runTag}`;
  const deletedMarker = `DELETE_ME_${runTag}`;
  const redactionSentinel = `NEVER_RETURN_${runTag}`;
  const now = Date.now();
  const profileAt = now + 3;
  const profilePayload = JSON.stringify({
    settings: {
      modelId: "staging/deterministic",
      systemPrompt: "",
      mcpServers: [
        server,
        {
          id: `legacy-secret-${runTag}`,
          name: "Legacy secret migration canary",
          url: new URL("/mcp", provider.url).toString(),
          authMode: "bearer",
          enabled: false,
          status: "connected",
          token: redactionSentinel,
          headersJson: JSON.stringify({ Authorization: `Bearer ${redactionSentinel}` }),
          tools: [],
          disabledTools: [],
        },
      ],
      agents: [],
      automations: [],
      skills: [],
    },
    life: { memories: [], trackers: [], tasks: [], shareWithAgent: true },
    mcpOAuth: {
      [`legacy-oauth-${runTag}`]: {
        accessToken: redactionSentinel,
        refreshToken: `${redactionSentinel}-refresh`,
        tokenEndpoint: new URL("/token", provider.url).toString(),
        clientId: "legacy-client",
        mcpUrl: new URL("/mcp", provider.url).toString(),
      },
    },
  });
  const seeded = await backendRequest<JsonRecord>(backendA.url, tokenA, "/chats/sync", {
    method: "POST",
    body: JSON.stringify({
      have: [],
      push: [
        { id: chatId, title: "Persistent staging chat", updatedAt: now + 1, payload: conversationPayload(chatId, chatMarker, now + 1) },
        { id: deletedChatId, title: "Deleted staging chat", updatedAt: now + 2, payload: conversationPayload(deletedChatId, deletedMarker, now + 2) },
      ],
      delete: [],
      profile: { updatedAt: profileAt, payload: profilePayload },
    }),
  });
  verify(
    "A",
    "legacy credentials migrate server-side and the browser profile is redacted",
    seeded.status === 200 &&
      seeded.data.profileAck === profileAt &&
      !publicResponseHasProviderCredential(seeded.data) &&
      !JSON.stringify(seeded.data).includes(redactionSentinel),
    "HTTP 200 with profile ack and no credential canary",
    `${seeded.status}:${String(seeded.data.profileAck ?? "")}`,
  );

  const deletedAt = Date.now() + 10;
  const deleted = await backendRequest<JsonRecord>(backendA.url, tokenA, "/chats/sync", {
    method: "POST",
    body: JSON.stringify({
      have: [{ id: chatId, updatedAt: now + 1 }, { id: deletedChatId, updatedAt: now + 2 }],
      push: [],
      delete: [{ id: deletedChatId, deletedAt }],
      profile: { updatedAt: profileAt },
    }),
  });
  verify("A", "chat tombstone acknowledged", deleted.status === 200 && Array.isArray(deleted.data.deleteAck) && deleted.data.deleteAck.includes(deletedChatId), "deleteAck contains chat id", deleted.data.deleteAck ?? deleted.status);

  await oauthAuthorize({
    backendUrl: backendA.url,
    providerUrl: provider.url,
    controlSecret,
    token: tokenA,
    otherToken: tokenOther,
    server,
    phase: "A",
    assertGuards: true,
  });

  const connected = await checkMcp(backendA.url, tokenA, server);
  const connectedTools = Array.isArray(connected.data.tools) ? connected.data.tools : [];
  verify("A", "MCP grant connects without browser credential", connected.status === 200 && connected.data.credentialStored === true && connectedTools.some((tool) => tool && typeof tool === "object" && (tool as JsonRecord).name === "blackbox_echo") && !publicResponseHasProviderCredential(connected.data), "HTTP 200 with blackbox_echo and no credential", `${connected.status}:${connectedTools.length}`);

  await providerControl(provider.url, controlSecret, { refreshDelayMs: 600 }, "A");
  await Bun.sleep(4_200);
  const beforeConcurrent = await providerStats(provider.url, controlSecret);
  const concurrent = await Promise.all([
    checkMcp(backendA.url, tokenA, server, 30_000),
    checkMcp(backendA.url, tokenA, server, 30_000),
  ]);
  const afterConcurrent = await providerStats(provider.url, controlSecret);
  verify("A", "concurrent expired-grant refresh is single-flight", concurrent.every((item) => item.status === 200) && afterConcurrent.stats.refreshes - beforeConcurrent.stats.refreshes === 1, "two checks, one provider refresh", `statuses=${concurrent.map((item) => item.status).join(",")}; refreshes=${afterConcurrent.stats.refreshes - beforeConcurrent.stats.refreshes}`);

  await providerControl(provider.url, controlSecret, { refreshDelayMs: 0, accessTtlSeconds: 120 }, "A");
  const prepared401 = await checkMcp(backendA.url, tokenA, server);
  verify("A", "grant prepared for deterministic 401 repair", prepared401.status === 200, "HTTP 200", prepared401.status);
  await providerControl(provider.url, controlSecret, { mcp401Once: true }, "A");
  const before401 = await providerStats(provider.url, controlSecret);
  const repaired401 = await checkMcp(backendA.url, tokenA, server);
  const after401 = await providerStats(provider.url, controlSecret);
  verify("A", "unexpected MCP 401 refreshes and replays once", repaired401.status === 200 && after401.stats.refreshes - before401.stats.refreshes === 1, "HTTP 200 and one refresh", `${repaired401.status}; refreshes=${after401.stats.refreshes - before401.stats.refreshes}`);

  await providerControl(provider.url, controlSecret, { accessTtlSeconds: 1, mcp401Once: true }, "A");
  const prepared503 = await checkMcp(backendA.url, tokenA, server);
  verify("A", "short-lived grant prepared for transient refresh", prepared503.status === 200, "HTTP 200", prepared503.status);
  await providerControl(provider.url, controlSecret, { refresh503Once: true }, "A");
  await Bun.sleep(1_200);
  const before503 = await providerStats(provider.url, controlSecret);
  const recovered503 = await checkMcp(backendA.url, tokenA, server, 35_000);
  const after503 = await providerStats(provider.url, controlSecret);
  verify("A", "one-shot refresh 503 keeps the grant and recovers", recovered503.status === 200 && after503.stats.refreshes - before503.stats.refreshes === 2, "HTTP 200 after transient failure + retry", `${recovered503.status}; refreshes=${after503.stats.refreshes - before503.stats.refreshes}`);

  await providerControl(provider.url, controlSecret, { invalidGrant: true }, "A");
  await Bun.sleep(1_200);
  const beforeInvalid = await providerStats(provider.url, controlSecret);
  const invalid = await checkMcp(backendA.url, tokenA, server);
  const afterInvalid = await providerStats(provider.url, controlSecret);
  verify("A", "invalid_grant becomes durable reauth_required", invalid.status === 401 && invalid.data.error === "reauth_required" && afterInvalid.stats.refreshes - beforeInvalid.stats.refreshes === 1, "HTTP 401 reauth_required after one refresh", `${invalid.status}:${String(invalid.data.error ?? "")}; refreshes=${afterInvalid.stats.refreshes - beforeInvalid.stats.refreshes}`);

  await providerControl(provider.url, controlSecret, { invalidGrant: false }, "A");
  const blockedBefore = await providerStats(provider.url, controlSecret);
  const stillBlocked = await checkMcp(backendA.url, tokenA, server);
  const blockedAfter = await providerStats(provider.url, controlSecret);
  verify("A", "permanent OAuth failure is not retried in the background", stillBlocked.status === 401 && stillBlocked.data.error === "reauth_required" && blockedAfter.stats.refreshes === blockedBefore.stats.refreshes, "HTTP 401 with no provider retry", `${stillBlocked.status}; refreshes=${blockedAfter.stats.refreshes - blockedBefore.stats.refreshes}`);

  await providerControl(provider.url, controlSecret, { accessTtlSeconds: 120 }, "A");
  const registrationBeforeReauth = (await providerStats(provider.url, controlSecret)).stats.registrations;
  await oauthAuthorize({
    backendUrl: backendA.url,
    providerUrl: provider.url,
    controlSecret,
    token: tokenA,
    otherToken: tokenOther,
    server,
    phase: "A",
    assertGuards: false,
  });
  const registrationAfterReauth = (await providerStats(provider.url, controlSecret)).stats.registrations;
  verify("A", "dynamic client registration is reused", registrationAfterReauth === registrationBeforeReauth, "registration counter unchanged", registrationAfterReauth - registrationBeforeReauth);

  const runOneId = `run-once-${runTag}`;
  const runOneConversation = `run-chat-${runTag}`;
  const runOneMarker = `RUN_ONCE_${runTag}`;
  const runOneBody = runBody({
    runId: runOneId,
    conversationId: runOneConversation,
    assistantMessageId: `assistant-once-${runTag}`,
    serverId: String(server.id),
    marker: runOneMarker,
  });
  const statsBeforeRun = await providerStats(provider.url, controlSecret);
  const started = await backendRequest<JsonRecord>(backendA.url, tokenA, "/runs/start", {
    method: "POST",
    body: JSON.stringify(runOneBody),
  });
  verify("A", "durable run accepted", started.status === 200 && started.data.status === "running", "HTTP 200 running", `${started.status}:${String(started.data.status ?? "")}`);
  const finished = await waitRunTerminal(backendA.url, tokenA, runOneId);
  const statsAfterRun = await providerStats(provider.url, controlSecret);
  verify("A", "deterministic run invoked MCP exactly once", finished.status === "done" && statsAfterRun.stats.toolCalls - statsBeforeRun.stats.toolCalls === 1 && JSON.stringify(finished.result).includes("BLACKBOX_RUN_COMPLETE"), "done, one tool call, final marker", `${String(finished.status)}; toolCalls=${statsAfterRun.stats.toolCalls - statsBeforeRun.stats.toolCalls}`);

  const replay = await backendRequest<JsonRecord>(backendA.url, tokenA, "/runs/start", {
    method: "POST",
    body: JSON.stringify(runOneBody),
  });
  const statsAfterReplay = await providerStats(provider.url, controlSecret);
  verify("A", "same runId replays its durable receipt", replay.status === 200 && replay.data.replayed === true && statsAfterReplay.stats.toolCalls === statsAfterRun.stats.toolCalls, "replayed true and no new tool call", `${replay.status}:${String(replay.data.replayed ?? "")}; toolCalls=${statsAfterReplay.stats.toolCalls - statsAfterRun.stats.toolCalls}`);

  const conflictingBody = { ...runOneBody, title: "conflicting request" };
  const conflict = await backendRequest<JsonRecord>(backendA.url, tokenA, "/runs/start", {
    method: "POST",
    body: JSON.stringify(conflictingBody),
  });
  verify("A", "same runId with different input is rejected", conflict.status === 409 && conflict.data.error === "idempotency_conflict", "HTTP 409 idempotency_conflict", `${conflict.status}:${String(conflict.data.error ?? "")}`);

  if (idleMs > 0) {
    console.log(`Waiting ${idleMs}ms with no account traffic for real idle eviction/rehydration…`);
    await Bun.sleep(idleMs);
  }
  const afterIdleRuns = await activeRuns(backendA.url, tokenA);
  const afterIdleCheck = await checkMcp(backendA.url, tokenA, server);
  verify("idle", "account reconnects after an idle lifecycle gap", afterIdleRuns.some((item) => item.runId === runOneId && item.status === "done") && afterIdleCheck.status === 200, "run and OAuth grant restored", `idleMs=${idleMs}; run=${String(afterIdleRuns.find((item) => item.runId === runOneId)?.status ?? "missing")}; mcp=${afterIdleCheck.status}`);
  const accountVersionA = await backendRequest<JsonRecord>(backendA.url, tokenA, "/__staging/account-version");
  const accountInstanceA = typeof accountVersionA.data.instanceId === "string" ? accountVersionA.data.instanceId : "";
  verify("A→B", "account Durable Object reports version A", accountVersionA.status === 200 && accountVersionA.data.version === backendVarsA.STAGING_VERSION && Boolean(accountInstanceA), backendVarsA.STAGING_VERSION, accountVersionA.data.version ?? accountVersionA.status);

  await providerControl(provider.url, controlSecret, {
    accessTtlSeconds: 3,
    mcp401Once: true,
    refreshResponseDelayMs: 0,
    gatewayFinalDelayMs: 0,
    holdRefreshResponse: false,
    holdGatewayFinal: true,
  }, "A→B");
  const shortGrant = await checkMcp(backendA.url, tokenA, server, 30_000);
  verify("A→B", "short-lived pre-deploy grant prepared", shortGrant.status === 200, "HTTP 200", shortGrant.status);
  await providerControl(provider.url, controlSecret, {
    refreshResponseDelayMs: 0,
    idempotencyReplayDelayMs: 0,
    holdRefreshResponse: true,
  }, "A→B");

  const deployRunId = `run-deploy-${runTag}`;
  const deployConversation = `deploy-chat-${runTag}`;
  const deployMarker = `DEPLOY_RUN_${runTag}`;
  const deployRunBody = runBody({
    runId: deployRunId,
    conversationId: deployConversation,
    assistantMessageId: `assistant-deploy-${runTag}`,
    serverId: String(server.id),
    marker: deployMarker,
  });
  const beforeDeployRun = await providerStats(provider.url, controlSecret);
  const deployRunStart = await backendRequest<JsonRecord>(backendA.url, tokenA, "/runs/start", {
    method: "POST",
    body: JSON.stringify(deployRunBody),
  });
  verify("A→B", "deploy-gap run accepted on version A", deployRunStart.status === 200, "HTTP 200", deployRunStart.status);
  const afterTool = await waitFor(
    () => providerStats(provider.url, controlSecret),
    (snapshot) => snapshot.stats.toolCalls >= beforeDeployRun.stats.toolCalls + 1 && snapshot.stats.gatewayCalls >= beforeDeployRun.stats.gatewayCalls + 2,
    20_000,
    "deploy-gap tool execution",
  );
  verify("A→B", "dangerous tool completed before deployment", afterTool.stats.toolCalls - beforeDeployRun.stats.toolCalls === 1, "exactly one tool call", afterTool.stats.toolCalls - beforeDeployRun.stats.toolCalls);
  // The access token already carries the three-second expiry. Extending the
  // provider now makes only the in-flight rotated successor long-lived.
  await providerControl(provider.url, controlSecret, { accessTtlSeconds: 120 }, "A→B");

  const liveStream = await fetch(new URL(`/runs/stream?conversationId=${encodeURIComponent(deployConversation)}`, backendA.url), {
    headers: { Authorization: `Bearer ${tokenA}` },
    signal: AbortSignal.timeout(10_000),
  });
  const liveReader = liveStream.body?.getReader();
  const liveChunk = await liveReader?.read();
  verify("A→B", "live run stream was reachable before deployment", liveStream.status === 200 && Boolean(liveChunk?.value?.length), "HTTP 200 with SSE bytes", `${liveStream.status}:${liveChunk?.value?.length ?? 0}`);
  await liveReader?.cancel().catch(() => undefined);

  await Bun.sleep(3_300);
  const beforeGapRefresh = await providerStats(provider.url, controlSecret);
  const refreshAbort = new AbortController();
  let pendingRefreshSettled = false;
  const pendingRefresh = checkMcp(backendA.url, tokenA, server, 75_000, refreshAbort.signal)
    .catch(() => null)
    .finally(() => {
      pendingRefreshSettled = true;
    });
  const rotatedButUnacknowledged = await waitFor(
    () => providerStats(provider.url, controlSecret),
    (snapshot) => snapshot.stats.refreshes >= beforeGapRefresh.stats.refreshes + 1 && snapshot.stats.generation >= beforeGapRefresh.stats.generation + 1,
    15_000,
    "provider rotation before delayed response",
  );
  verify("A→B", "provider rotated while backend response was latched", rotatedButUnacknowledged.stats.refreshes - beforeGapRefresh.stats.refreshes === 1, "one committed provider refresh", rotatedButUnacknowledged.stats.refreshes - beforeGapRefresh.stats.refreshes);
  const beforeDeployActive = await activeRuns(backendA.url, tokenA);
  verify(
    "A→B",
    "refresh and run are both still in flight before deployment",
    !pendingRefreshSettled && beforeDeployActive.some((item) => item.runId === deployRunId && item.status === "running"),
    "unsettled refresh and running receipt",
    `refreshSettled=${pendingRefreshSettled}; run=${String(beforeDeployActive.find((item) => item.runId === deployRunId)?.status ?? "missing")}`,
  );

  console.log("Deploying backend version B while run finalization and refresh response are latched…");
  const backendVarsB = { ...backendVarsA, STAGING_VERSION: `B-${runTag}` };
  const backendB = await deploy(BACKEND_CONFIG, backendVarsB, backendWorkerName, backendA.url);
  const versionB = await fetchJson<JsonRecord>(new URL("/__staging/version", backendB.url).toString());
  verify("A→B", "version marker changed from A to B", versionB.status === 200 && versionB.data.version === backendVarsB.STAGING_VERSION && versionB.data.version !== versionA.data.version, backendVarsB.STAGING_VERSION, versionB.data.version ?? versionB.status);
  const accountVersionB = await waitFor(
    () => backendRequest<JsonRecord>(backendB.url, tokenA, "/__staging/account-version"),
    (result) => result.status === 200 && result.data.version === backendVarsB.STAGING_VERSION,
    70_000,
    "version B account Durable Object",
  );
  verify(
    "A→B",
    "account Durable Object was replaced by version B",
    typeof accountVersionB.data.instanceId === "string" && accountVersionB.data.instanceId !== accountInstanceA,
    "version B with a new instance id",
    `${String(accountVersionB.data.version ?? "")}:${String(accountVersionB.data.instanceId ?? "") !== accountInstanceA ? "new-instance" : "same-instance"}`,
  );
  verify(
    "A→B",
    "latched version-A refresh did not settle before version B owned the account",
    !pendingRefreshSettled,
    "pending refresh still unsettled",
    `refreshSettled=${pendingRefreshSettled}`,
  );
  await providerControl(provider.url, controlSecret, {
    refreshResponseDelayMs: 0,
    idempotencyReplayDelayMs: 0,
    holdRefreshResponse: false,
    holdGatewayFinal: false,
  }, "B");

  const recoveredGrant = await checkMcp(backendB.url, tokenA, server, 35_000);
  refreshAbort.abort();
  await Promise.race([pendingRefresh, Bun.sleep(1_000)]).catch(() => undefined);
  const afterGapRefresh = await providerStats(provider.url, controlSecret);
  verify("B", "rotating refresh recovered across deploy without duplicate redemption", recoveredGrant.status === 200 && afterGapRefresh.stats.refreshes === rotatedButUnacknowledged.stats.refreshes, "HTTP 200 and refresh counter unchanged", `${recoveredGrant.status}; extraRefreshes=${afterGapRefresh.stats.refreshes - rotatedButUnacknowledged.stats.refreshes}`);

  const replayAfterDeploy = await backendRequest<JsonRecord>(backendB.url, tokenA, "/runs/start", {
    method: "POST",
    body: JSON.stringify(deployRunBody),
  });
  verify("B", "deploy-gap run receipt survives and replays", replayAfterDeploy.status === 200 && replayAfterDeploy.data.replayed === true, "HTTP 200 replayed true", `${replayAfterDeploy.status}:${String(replayAfterDeploy.data.replayed ?? "")}`);
  const deployTerminal = await waitRunTerminal(backendB.url, tokenA, deployRunId, 70_000);
  const afterDeployTerminalStats = await providerStats(provider.url, controlSecret);
  verify("B", "deploy-gap run settles as interrupted without duplicate tool execution", deployTerminal.status === "interrupted" && afterDeployTerminalStats.stats.toolCalls - beforeDeployRun.stats.toolCalls === 1, "interrupted; one tool call", `${String(deployTerminal.status)}; toolCalls=${afterDeployTerminalStats.stats.toolCalls - beforeDeployRun.stats.toolCalls}`);

  const terminalStream = await fetch(new URL(`/runs/stream?conversationId=${encodeURIComponent(deployConversation)}`, backendB.url), {
    headers: { Authorization: `Bearer ${tokenA}` },
    signal: AbortSignal.timeout(20_000),
  });
  const terminalText = await terminalStream.text();
  verify("B", "frontend-compatible SSE reconnect returns terminal event", terminalStream.status === 200 && terminalText.includes('"t":"done"') && terminalText.includes(`"status":"${String(deployTerminal.status)}"`), "SSE snapshot + terminal event", `${terminalStream.status}; bytes=${terminalText.length}`);

  await providerControl(provider.url, controlSecret, {
    accessTtlSeconds: 120,
    refreshResponseDelayMs: 0,
    idempotencyReplayDelayMs: 0,
    gatewayFinalDelayMs: 0,
    holdRefreshResponse: false,
    holdGatewayFinal: false,
    mcp401Once: true,
  }, "B");
  const longGrant = await checkMcp(backendB.url, tokenA, server, 30_000);
  verify("B", "OAuth grant remains usable on version B", longGrant.status === 200, "HTTP 200", longGrant.status);

  const aliasPull = await backendRequest<JsonRecord>(backendB.url, tokenAlias, "/chats/sync", {
    method: "POST",
    body: JSON.stringify({
      have: [{ id: deletedChatId, updatedAt: now + 2 }],
      push: [],
      delete: [],
      profile: { updatedAt: 0 },
    }),
  });
  const pulled = Array.isArray(aliasPull.data.pull) ? aliasPull.data.pull as JsonRecord[] : [];
  const tombstones = Array.isArray(aliasPull.data.tombstones) ? aliasPull.data.tombstones as JsonRecord[] : [];
  const pulledPayloads = pulled.map((item) => String(item.payload ?? ""));
  verify("B", "same subject with changed email reaches original shard", aliasPull.status === 200 && pulledPayloads.some((payload) => payload.includes(chatMarker)) && pulledPayloads.some((payload) => payload.includes(runOneMarker)) && typeof aliasPull.data.profile === "object", "chat history, run history, and profile restored", `${aliasPull.status}; pull=${pulled.length}`);
  verify("B", "tombstone survives deploy", tombstones.some((item) => item.id === deletedChatId), "deleted chat tombstone present", tombstones.length);
  verify("B", "browser-facing sync contains no OAuth grant", !publicResponseHasProviderCredential(aliasPull.data) && !JSON.stringify(aliasPull.data).includes("mcpOAuth") && !JSON.stringify(aliasPull.data).includes(redactionSentinel), "no provider credential, canary, or mcpOAuth", aliasPull.status);

  const isolated = await backendRequest<JsonRecord>(backendB.url, tokenOther, "/chats/sync", {
    method: "POST",
    body: JSON.stringify({ have: [], push: [], delete: [], profile: { updatedAt: 0 } }),
  });
  verify("B", "different subject cannot read account history", isolated.status === 200 && Array.isArray(isolated.data.pull) && isolated.data.pull.length === 0 && isolated.data.profile === undefined, "empty pull and no profile", `${isolated.status}; pull=${Array.isArray(isolated.data.pull) ? isolated.data.pull.length : "invalid"}`);

  if (!skipBrowser) {
    const browserPort = 4300 + Math.floor(Math.random() * 500);
    const browserUrl = `http://127.0.0.1:${browserPort}`;
    const vite = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(browserPort)], {
      cwd: `${ROOT}/web`,
      env: safeChildEnv({ EXPO_PUBLIC_RORK_FUNCTIONS_URL: backendB.url }),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitFor(
        async () => fetch(browserUrl, { signal: AbortSignal.timeout(1_000) }).then((response) => response.ok).catch(() => false),
        Boolean,
        20_000,
        "Vite browser acceptance server",
      );
      const child = Bun.spawn(["bun", "e2e/staging-persistence.ts"], {
        cwd: `${ROOT}/web`,
        env: safeChildEnv({
          STAGING_WEB_URL: browserUrl,
          STAGING_BACKEND_URL: backendB.url,
          STAGING_ACCESS_TOKEN: tokenAlias,
          STAGING_CHAT_MARKER: chatMarker,
          STAGING_RUN_MARKER: runOneMarker,
          STAGING_REDACTION_SENTINEL: redactionSentinel,
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const line = stdout.split("\n").findLast((item) => item.startsWith("STAGING_BROWSER_RESULT=")) ?? "";
      const browserResult = JSON.parse(line.slice("STAGING_BROWSER_RESULT=".length) || "{}") as JsonRecord;
      verify(
        "browser",
        "real frontend hydrates and performs a network reconnect after reload",
        exitCode === 0 &&
          browserResult.hydrated === true &&
          browserResult.reloaded === true &&
          typeof browserResult.syncResponses === "number" &&
          browserResult.syncResponses >= 2,
        "hydrated, reloaded, and two public sync responses",
        exitCode === 0 ? browserResult : `exit ${exitCode}: ${stderr.slice(0, 160)}`,
      );
      verify(
        "browser",
        "real frontend and sync responses contain no provider credential",
        browserResult.oauthCredentialKeys === 0 &&
          browserResult.oauthCredentialStores === 0 &&
          browserResult.responseCredentialLeak === false &&
          browserResult.storageCanaryLeak === false,
        "zero credential keys/stores and clean responses",
        browserResult,
      );
    } finally {
      vite.kill();
      await vite.exited.catch(() => undefined);
    }
  } else {
    const skipped: EvidenceRow = {
      phase: "browser",
      test: "real frontend reconnect",
      expected: "real Chromium against public staging",
      actual: "SKIPPED by STAGING_SKIP_BROWSER=1",
      passed: false,
    };
    evidence.push(skipped);
    console.log(`SKIP [browser] ${skipped.test} — ${skipped.actual}`);
  }

  const finalStats = await providerStats(provider.url, controlSecret);
  verify("B", "deterministic provider observed no protocol violation", finalStats.stats.violations === 0, "zero violations", finalStats.stats.violations);
  const report: JsonRecord = {
    generatedAt: new Date().toISOString(),
    runTag,
    passed: evidence.every((row) => row.passed),
    backend: {
      name: backendWorkerName,
      url: backendB.url,
      versionA: backendVarsA.STAGING_VERSION,
      versionAId: backendA.versionId,
      versionB: backendVarsB.STAGING_VERSION,
      versionBId: backendB.versionId,
    },
    provider: {
      name: providerWorkerName,
      url: provider.url,
      versionId: provider.versionId,
      counters: finalStats.stats,
      safeEventsObserved: [
        `oauth_registrations:${finalStats.stats.registrations}`,
        `oauth_authorizations:${finalStats.stats.authorizations}`,
        `oauth_code_exchanges:${finalStats.stats.codeExchanges}`,
        `oauth_refreshes:${finalStats.stats.refreshes}`,
        `mcp_tool_calls:${finalStats.stats.toolCalls}`,
        `gateway_calls:${finalStats.stats.gatewayCalls}`,
        `protocol_violations:${finalStats.stats.violations}`,
      ],
    },
    evidence,
    unverified: [
      "Cloudflare does not expose a deterministic public assertion that an idle Durable Object was physically evicted; the idle test proves real post-gap rehydration behavior.",
      "Authentic pre-rollout orphan ownership cannot be synthesized through public staging APIs; production recovery intentionally requires the operator bootstrap endpoint plus the immutable subject id.",
      "Worker tail events are not embedded in this report; only redacted public outcomes and durable provider counters are recorded.",
      ...(skipBrowser ? ["Real Chromium frontend reconnect was explicitly skipped by STAGING_SKIP_BROWSER=1."] : []),
    ],
  };
  await writeEvidence(report);
  console.log("\nSAFE_EVIDENCE_REPORT=");
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== true) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const report = {
    generatedAt: new Date().toISOString(),
    failed: true,
    error: error instanceof Error ? error.message.slice(0, 500) : "unknown acceptance failure",
    evidence,
  };
  await writeEvidence(report).catch(() => undefined);
  console.error(`Acceptance failed: ${report.error}`);
  process.exitCode = 1;
});
