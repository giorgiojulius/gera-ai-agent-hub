import { connectCloudMcp, listCloudMcpTools, cloudServerRedactions, redactCloudMcpText, type CloudMcpServer, type CloudMcpSession, type CloudMcpTool, type CloudMcpConnection } from "./mcp-cloud";
import { createCredentialLease, stripCloudMcpCredentials, type CredentialLease } from "./mcp-credentials";
import { openMcpNotificationStream, sessionWireInfo, type McpNotificationStream, type McpWireInfo, type McpServerRequest, type McpServerRequestReply } from "./mcp-protocol";
import { DEFERRED_SCHEMA_CHARS, DEFERRED_TOOLS_PER_SERVER, type McpCatalogEntry } from "./mcp-catalog";
import { normalizeCatalogWire } from "./mcp-catalog-wire";
import { McpSignInRequiredError } from "./mcp-protocol-shared";
import type { ResolveMcpToolsetOptions, McpToolsetJournalEntry } from "./mcp-toolset";

/** Run-local state; credentials remain private behind the lease. */
export type McpServerState = {
  server: CloudMcpServer; lease: CredentialLease; catalog: CloudMcpTool[] | null; session: CloudMcpSession | null;
  connecting: Promise<void> | null; pending: boolean; failure: string | null; leftOut: boolean; stale: boolean;
  stream: McpNotificationStream | null; stepUp: { scopes: string[]; code: string } | null;
  promptCount?: number; resourceCount?: number; wireHint?: McpWireInfo; authFailure?: boolean;
};
type ConnectionContext = {
  options: ResolveMcpToolsetOptions; states: McpServerState[]; now: () => number; connectBudgetMs: number; catalogBudgetChars: number;
  repairGrant: (server: CloudMcpServer) => Promise<boolean>;
  parkForStepUp: (state: McpServerState, error: unknown) => Promise<string | null>;
  serverRequestHandler: (state: McpServerState) => (request: McpServerRequest) => Promise<McpServerRequestReply>;
  note: (entry: McpToolsetJournalEntry) => void;
};
/** Addressed single-flight operations, bounded from before credential acquisition until catalog publication. */
export function createMcpConnections(ctx: ConnectionContext) {
  const { options, states, now, connectBudgetMs, catalogBudgetChars, repairGrant, parkForStepUp, serverRequestHandler, note } = ctx;
  const lifetime = new AbortController();
  const operations = new Map<McpServerState, AbortController>();
  const admitted = new Map<McpServerState, number>();
  const ensureOpen = (signal: AbortSignal): void => { lifetime.signal.throwIfAborted(); signal.throwIfAborted(); };
  const notificationHandler = (state: McpServerState) => (notification: { method: string }): void => {
    if (lifetime.signal.aborted) return;
    if (/^notifications\/(tools|prompts|resources)\/list_changed$/.test(notification.method)) {
      options.catalog?.invalidate(state.server.id);
      state.stale = true;
    }
  };
  const admit = (state: McpServerState, tools: CloudMcpTool[]): boolean => {
    const chars = JSON.stringify(tools).length;
    if (chars > DEFERRED_SCHEMA_CHARS) {
      state.failure = `publishes ${tools.length} tools whose schemas exceed ${Math.round(DEFERRED_SCHEMA_CHARS / 1_000_000)} MB — too large to search`;
    } else {
      const total = [...admitted.entries()].reduce((sum, [other, size]) => sum + (other === state ? 0 : size), 0);
      if (total + chars <= catalogBudgetChars) { admitted.set(state, chars); return true; }
      state.leftOut = true;
      state.failure = `left out of this run: its ${tools.length} tools would push the run's combined tool catalogs past ${Math.round(catalogBudgetChars / 1_000_000)} MB (${(total / 1_000_000).toFixed(1)} MB already admitted). Disable it or trim other servers' tools to bring it back.`;
    }
    admitted.delete(state);
    state.catalog = null; state.session = null; state.stream?.close(); state.stream = null;
    return false;
  };
  const publish = async (state: McpServerState, connection: Pick<CloudMcpConnection, "tools"> & Partial<CloudMcpConnection>, signal: AbortSignal): Promise<void> => {
    ensureOpen(signal);
    if (!admit(state, connection.tools)) return;
    const session = connection.session ?? state.session;
    const wire = normalizeCatalogWire(connection.wire ?? (session ? sessionWireInfo(session) : state.wireHint));
    const entry: McpCatalogEntry = {
      serverId: state.server.id, serverName: state.server.name, tools: connection.tools, fetchedAt: now(),
      ...(wire ? { wire } : {}),
      ...(options.inventory && connection.prompts ? { prompts: connection.prompts, resources: connection.resources ?? [], resourceTemplates: connection.resourceTemplates ?? [], capabilities: session?.capabilities ?? {} } : {}),
    };
    // Remote owner persistence is awaited, not a detached write after run settlement.
    if (options.persistCatalog) await options.persistCatalog(entry, signal);
    ensureOpen(signal);
    options.catalog?.write(entry);
    state.catalog = connection.tools; state.session = session ?? null; state.wireHint = wire;
    state.failure = null; state.stale = false;
    if (options.inventory && connection.prompts) { state.promptCount = connection.prompts.length; state.resourceCount = connection.resources?.length ?? 0; }
  };
  const bounded = (state: McpServerState, task: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (state.pending && state.connecting) return state.connecting;
    if (lifetime.signal.aborted || state.failure || state.leftOut) return Promise.resolve();
    const operation = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, operation.signal]);
    operations.set(state, operation);
    state.pending = true;
    const timer = options.uncapped ? null : setTimeout(() => operation.abort(new Error(`did not connect within the ${connectBudgetMs / 1_000} s connection budget`)), connectBudgetMs);
    const aborted = new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    state.connecting = Promise.race([Promise.resolve().then(() => { ensureOpen(signal); return task(signal); }), aborted])
      .catch((error: unknown) => {
        if (error instanceof McpSignInRequiredError) state.authFailure = true;
        if (!lifetime.signal.aborted) state.failure = redactCloudMcpText(error instanceof Error ? error.message : "connect failed", cloudServerRedactions(state.server));
      })
      .finally(() => {
        if (timer !== null) clearTimeout(timer);
        operations.delete(state);
        state.pending = false;
        // Do not revive a timed-out refresh: its pending lease still owns this session.
        if (state.session && !signal.aborted && !state.failure) state.session.signal = lifetime.signal;
      });
    return state.connecting;
  };
  const connect = (state: McpServerState): Promise<void> => {
    if (state.session && !state.stale && !state.pending) return Promise.resolve();
    return bounded(state, async (signal) => {
      const connectRaw = (): Promise<CloudMcpConnection> => {
        ensureOpen(signal);
        return connectCloudMcp(state.server, {
          maxTools: DEFERRED_TOOLS_PER_SERVER, includeDisabled: true, inventory: options.inventory === true,
          signal, logLevel: options.logLevel, lease: () => state.lease.get(), ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(state.wireHint && !options.uncapped ? { wireHint: state.wireHint } : {}),
          onServerRequest: serverRequestHandler(state), onNotification: notificationHandler(state),
        });
      };
      let connection: CloudMcpConnection;
      try { connection = await connectRaw(); }
      catch (error) {
        ensureOpen(signal);
        const message = error instanceof Error ? error.message : "connect failed";
        if (!/auth rejected/i.test(message)) throw error;
        const stepUp = await parkForStepUp(state, error);
        ensureOpen(signal);
        if (stepUp) throw new Error(stepUp);
        if (options.reconnect && !options.credentials) {
          const fresh = await options.reconnect(state.server.id);
          ensureOpen(signal);
          if (!fresh) throw error;
          state.lease = createCredentialLease(fresh, { repairGrant }); state.server = stripCloudMcpCredentials(fresh);
        } else if (!await state.lease.repair()) { throw error; }
        ensureOpen(signal);
        connection = await connectRaw();
      }
      ensureOpen(signal);
      await publish(state, connection, signal);
      if (state.failure) return;
      // A subscription starts only after this server has actually been requested.
      const caps = connection.session.capabilities;
      let stream: McpNotificationStream | null = null;
      if (options.notificationStreams !== false && (caps?.tools?.listChanged || caps?.prompts?.listChanged || caps?.resources?.listChanged)) {
        stream = await openMcpNotificationStream(connection.session, { connectTimeoutMs: 5_000 });
      }
      if (signal.aborted) { stream?.close(); ensureOpen(signal); }
      state.stream?.close(); state.stream = stream;
    });
  };
  const refreshIfStale = (state: McpServerState): Promise<void> => {
    if (!state.stale || state.failure) return Promise.resolve();
    if (!state.session) return connect(state);
    return bounded(state, async (signal) => {
      const session = state.session;
      if (!session) return;
      session.signal = signal;
      const tools = await listCloudMcpTools(session, state.server, { maxTools: DEFERRED_TOOLS_PER_SERVER, includeDisabled: true });
      await publish(state, { tools, session }, signal);
      ensureOpen(signal);
      note({ kind: "catalog_refreshed", serverId: state.server.id, serverName: state.server.name, detail: `${tools.length} tools after list_changed` });
    });
  };
  const connectMissing = async (predicate: (state: McpServerState) => boolean): Promise<void> => {
    await Promise.all(states.filter((state) => !state.failure && predicate(state)).map((state) => connect(state)));
  };
  const awaitLate = async (state: McpServerState): Promise<void> => { if (state.pending && state.connecting) await state.connecting; };
  const enforceCatalogBudget = (): void => {
    for (const state of states) if (!state.failure && state.catalog !== null) admit(state, state.catalog);
  };
  const close = (): void => {
    lifetime.abort(new Error("MCP run closed"));
    for (const controller of operations.values()) controller.abort(lifetime.signal.reason);
    for (const state of states) { state.stream?.close(); state.stream = null; }
  };
  return { connect, refreshIfStale, connectMissing, awaitLate, enforceCatalogBudget, close, isClosed: () => lifetime.signal.aborted };
}
