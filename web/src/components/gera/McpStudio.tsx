import { ChevronDown, LogIn, Plug, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { GitHubSignInDialog } from "@/components/gera/GitHubSignInDialog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgent } from "@/hooks/use-agent";
import {
  catalogIconUrl,
  featuredCatalogEntries,
  findCatalogEntry,
  MCP_AUTH_LABEL,
  MCP_CATALOG,
  MCP_CATEGORY_LABEL,
  serverIconUrl,
  type McpCatalogEntry,
  type McpCategory,
} from "@/lib/mcp-catalog";
import { githubDeviceClientId, githubOrgAccessUrl } from "@/lib/github-device";
import { mcpCatalogConnectTid, mcpServerCardTid } from "@/lib/testids";
import type { McpAuthMode, McpServerConfig } from "@/lib/types";
import { cn } from "@/lib/utils";

const CATEGORIES = Object.keys(MCP_CATEGORY_LABEL) as McpCategory[];

const AUTH_MODES: { value: McpAuthMode; label: string }[] = [
  { value: "auto", label: "Detect automatically" },
  { value: "none", label: "No authentication" },
  { value: "bearer", label: "Bearer token" },
  { value: "headers", label: "Custom HTTP headers" },
  { value: "oauth", label: "OAuth 2.1 (browser sign-in)" },
];

const AUTH_MODE_HINT: Record<McpAuthMode, string> = {
  auto: "Tries a pasted key or stored sign-in when present, otherwise connects openly — the server's real answer decides.",
  none: "No credentials are sent.",
  bearer: "Sent as Authorization: Bearer <token> with every request.",
  headers: "A JSON object of headers, sent with every request.",
  oauth: "A popup opens to authorize. Requires the server to support OAuth discovery and app registration — if it doesn't, you'll see the exact error.",
};
const AVATAR_TONES = [
  "bg-ember/10 text-ember",
  "bg-gold/15 text-gold",
  "bg-sky-600/10 text-sky-700",
  "bg-emerald-600/10 text-emerald-700",
  "bg-violet-600/10 text-violet-700",
  "bg-rose-600/10 text-rose-700",
] as const;

export function McpStudio() {
  const {
    state,
    connectCatalog,
    addCustomMcp,
    removeMcp,
    updateMcp,
    connectMcp,
    toggleMcpTool,
  } = useAgent();
  const [query, setQuery] = useState<string>("");
  const [category, setCategory] = useState<McpCategory | "all">("all");
  const [customOpen, setCustomOpen] = useState<boolean>(false);
  const [customName, setCustomName] = useState<string>("");
  const [customUrl, setCustomUrl] = useState<string>("");
  const [customToken, setCustomToken] = useState<string>("");
  const [customHeaders, setCustomHeaders] = useState<string>("");
  const [customAuth, setCustomAuth] = useState<McpAuthMode>("auto");
  // The expanded server card lives in the address (?server=<id>).
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get("server");
  const setFocusId = useCallback(
    (id: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) {
            next.set("server", id);
          } else {
            next.delete("server");
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const [githubOpen, setGithubOpen] = useState<boolean>(false);
  const githubReady = githubDeviceClientId() !== null;

  const added = state.settings.mcpServers;
  const addedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const server of added) {
      if (server.catalogId) {
        ids.add(server.catalogId);
      }
      ids.add(server.id);
    }
    return ids;
  }, [added]);

  const addedByKey = useMemo(() => {
    const map = new Map<string, McpServerConfig>();
    for (const server of added) {
      if (server.catalogId) {
        map.set(server.catalogId, server);
      }
      map.set(server.id, server);
    }
    return map;
  }, [added]);

  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MCP_CATALOG.filter((entry) => {
      if (category !== "all" && entry.category !== category) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.hint.toLowerCase().includes(q) ||
        entry.url.toLowerCase().includes(q) ||
        MCP_AUTH_LABEL[entry.auth].toLowerCase().includes(q) ||
        MCP_CATEGORY_LABEL[entry.category].toLowerCase().includes(q)
      );
    });
  }, [category, query]);

  const featured = useMemo(() => {
    if (query.trim() || category !== "all") {
      return [];
    }
    return featuredCatalogEntries().filter((entry) => !addedIds.has(entry.id));
  }, [addedIds, category, query]);

  const groupedCatalog = useMemo(() => {
    const featuredIds = new Set(featured.map((entry) => entry.id));
    const byCategory = new Map<McpCategory, McpCatalogEntry[]>();
    for (const entry of filteredCatalog) {
      if (featuredIds.has(entry.id)) {
        continue;
      }
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }
    return CATEGORIES.filter((key) => (byCategory.get(key)?.length ?? 0) > 0).map((key) => ({
      key,
      entries: byCategory.get(key) ?? [],
    }));
  }, [featured, filteredCatalog]);

  const liveCount = added.filter((item) => item.status === "connected").length;

  function handleCatalogConnect(entry: McpCatalogEntry) {
    connectCatalog(entry.id);
    if (entry.auth === "token" && !entry.tokenOptional) {
      setFocusId(entry.id);
    }
  }

  /** Called by the device-flow dialog once GitHub confirms the authorization. */
  const handleGitHubSignedIn = useCallback(() => {
    setGithubOpen(false);
    toast.success("GitHub: signed in", { description: "Verifying the connection…" });
    const existing = addedByKey.get("github");
    if (existing) {
      connectMcp(existing.id);
    } else {
      connectCatalog("github");
    }
    setFocusId("github");
  }, [addedByKey, connectCatalog, connectMcp, setFocusId]);

  function handleCustomConnect() {
    if (!customUrl.trim()) {
      return;
    }
    if (customAuth === "headers") {
      try {
        const parsed = JSON.parse(customHeaders || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
      } catch {
        toast.error("Headers must be a JSON object", {
          description: 'Example: {"X-Api-Key":"secret"}',
        });
        return;
      }
    }
    addCustomMcp({
      name: customName,
      url: customUrl,
      token: customToken,
      headersJson: customHeaders,
      authMode: customAuth,
    });
    setCustomName("");
    setCustomUrl("");
    setCustomToken("");
    setCustomHeaders("");
    setCustomAuth("auto");
    setCustomOpen(false);
  }

  return (
    <section>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Every connector is verified and executed by Gera's server. OAuth grants, API keys, refreshes and
        MCP sessions stay in your account shard; this browser receives only connection status and tool metadata.
        Open servers connect instantly, Sign-in servers authorize through a popup, and API-key servers take a
        pasted key that is sent directly to the server vault.
      </p>

      <div className="mt-4">
        <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Your tools · {liveCount} connected
        </p>
        {added.length === 0 ? (
          <p className="mt-2 rounded-2xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            Nothing connected yet. Choose a server below.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {added.map((server) => (
              <ConnectedCard
                key={server.id}
                server={server}
                expanded={focusId === server.id || server.status === "error"}
                onToggleExpand={() => setFocusId(focusId === server.id ? null : server.id)}
                onRemove={() => removeMcp(server.id)}
                onUpdate={(patch) => updateMcp(server.id, patch)}
                onConnect={() => connectMcp(server.id)}
                onToggleTool={(name) => toggleMcpTool(server.id, name)}
                onDeviceSignIn={
                  findCatalogEntry(server.catalogId ?? server.id)?.deviceFlow && githubReady
                    ? () => setGithubOpen(true)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-6">
        <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Add a tool · {MCP_CATALOG.length} in catalog
        </p>
        <div className="mt-2 flex items-center gap-2 rounded-full border border-border/70 bg-card px-3">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search GitHub, Linear, Notion…"
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <FilterChip active={category === "all"} label="All" onClick={() => setCategory("all")} />
          {CATEGORIES.map((item) => (
            <FilterChip
              key={item}
              active={category === item}
              label={MCP_CATEGORY_LABEL[item]}
              onClick={() => setCategory(item)}
            />
          ))}
        </div>

        {/* Custom server entry stays pinned above the catalog — visible in any search/filter. */}
        <div className="mt-3 rounded-2xl border border-border/70 bg-card">
          <button
            type="button"
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
            onClick={() => setCustomOpen((open) => !open)}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground">
              <Plus className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm">Custom MCP</span>
              <span className="block text-[11px] text-muted-foreground">Paste any Streamable HTTP URL</span>
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                customOpen && "rotate-180",
              )}
            />
          </button>
          {customOpen ? (
            <div className="space-y-2.5 border-t border-border/70 px-3 py-3">
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">Name (optional)</label>
                <Input
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                  placeholder="Defaults to the server's host"
                  className="h-8 border-border bg-white text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">HTTPS endpoint</label>
                <Input
                  value={customUrl}
                  onChange={(event) => setCustomUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                  className="h-8 border-border bg-white text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">Authentication</label>
                <Select
                  value={customAuth}
                  onValueChange={(value) => setCustomAuth(value as McpAuthMode)}
                >
                  <SelectTrigger className="h-8 border-border bg-white text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTH_MODES.map((mode) => (
                      <SelectItem key={mode.value} value={mode.value} className="text-xs">
                        {mode.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  {AUTH_MODE_HINT[customAuth]}
                </p>
              </div>
              {customAuth === "auto" || customAuth === "bearer" ? (
                <Input
                  type="password"
                  autoComplete="off"
                  value={customToken}
                  onChange={(event) => setCustomToken(event.target.value)}
                  placeholder={customAuth === "auto" ? "Bearer token (optional)" : "Bearer token"}
                  className="h-8 border-border bg-white text-xs"
                />
              ) : null}
              {customAuth === "headers" ? (
                <Textarea
                  value={customHeaders}
                  onChange={(event) => setCustomHeaders(event.target.value)}
                  placeholder='{"X-Api-Key":"secret"}'
                  className="min-h-[64px] border-border bg-white font-mono text-xs"
                />
              ) : null}
              <Button
                size="sm"
                className="h-8 gap-1 rounded-full"
                disabled={!customUrl.trim() || (customAuth === "bearer" && !customToken.trim())}
                onClick={handleCustomConnect}
              >
                {customAuth === "oauth" ? <LogIn className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                {customAuth === "oauth" ? "Sign in & connect" : "Connect"}
              </Button>
            </div>
          ) : null}
        </div>

        {featured.length > 0 ? (
          <CatalogGroup title={`Popular · ${featured.length}`}>
            {featured.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                addedServer={addedByKey.get(entry.id)}
                onConnect={() => handleCatalogConnect(entry)}
                onDeviceSignIn={entry.deviceFlow && githubReady ? () => setGithubOpen(true) : undefined}
              />
            ))}
          </CatalogGroup>
        ) : null}

        {groupedCatalog.length === 0 && featured.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No servers match.
          </p>
        ) : null}

        {groupedCatalog.map((group) => (
          <CatalogGroup key={group.key} title={`${MCP_CATEGORY_LABEL[group.key]} · ${group.entries.length}`}>
            {group.entries.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                addedServer={addedByKey.get(entry.id)}
                onConnect={() => handleCatalogConnect(entry)}
                onDeviceSignIn={entry.deviceFlow && githubReady ? () => setGithubOpen(true) : undefined}
              />
            ))}
          </CatalogGroup>
        ))}
      </div>

      <GitHubSignInDialog open={githubOpen} onOpenChange={setGithubOpen} onSignedIn={handleGitHubSignedIn} />
    </section>
  );
}

/** Brand favicon with an honest fallback: colored initials when the icon can't load. */
function McpAvatar({
  seed,
  name,
  iconUrl,
  className,
}: {
  seed: string;
  name: string;
  iconUrl: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState<boolean>(false);
  if (!iconUrl || failed) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center font-semibold",
          AVATAR_TONES[hashTone(seed)],
          className,
        )}
      >
        {initials(name)}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border border-border/60 bg-white",
        className,
      )}
    >
      <img
        src={iconUrl}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-[60%] w-[60%] object-contain"
      />
    </span>
  );
}

function CatalogGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-2 px-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/** Honest catalog badge: reflects the added server's real, probed state — never a bare "Added". */
function catalogStatusLabel(server: McpServerConfig, entry: McpCatalogEntry): string {
  if (server.status === "connected") {
    return `✓ ${server.tools.length} tools`;
  }
  if (server.status === "connecting") {
    return "Connecting…";
  }
  if (server.status === "error") {
    return "Failed — see Your tools";
  }
  if (entry.auth === "token" && !(server.token ?? "").trim()) {
    return entry.deviceFlow ? "Sign-in or key needed" : "Key needed";
  }
  if (entry.auth === "oauth") {
    return "Sign-in needed";
  }
  return "Added — not verified";
}

function CatalogRow({
  entry,
  addedServer,
  onConnect,
  onDeviceSignIn,
}: {
  entry: McpCatalogEntry;
  addedServer?: McpServerConfig;
  onConnect: () => void;
  onDeviceSignIn?: () => void;
}) {
  // Blocked reasons expand on tap — phones have no hover for the title.
  const [blockedOpen, setBlockedOpen] = useState<boolean>(false);
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card px-3 py-2.5">
      <McpAvatar
        seed={entry.id}
        name={entry.name}
        iconUrl={catalogIconUrl(entry)}
        className="h-9 w-9 rounded-xl text-xs"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm">{entry.name}</span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
              entry.blocked ? "bg-amber-500/15 text-amber-700" : "bg-foreground/5 text-muted-foreground",
            )}
          >
            {entry.blocked ? "Server-side" : onDeviceSignIn ? "Sign in · key" : MCP_AUTH_LABEL[entry.auth]}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{entry.hint}</span>
        {entry.blocked ? (
          // Clamped to two lines so the catalog keeps its rhythm — tapping
          // expands the full reason (phones have no hover); title covers mice.
          <button
            type="button"
            onClick={() => setBlockedOpen((prev) => !prev)}
            aria-expanded={blockedOpen}
            title={entry.blocked}
            className={cn(
              "mt-1 block w-full text-left text-[10px] leading-snug text-amber-700/90",
              !blockedOpen && "line-clamp-2",
            )}
          >
            {entry.blocked}
          </button>
        ) : null}
      </span>
      {addedServer ? (
        <span
          className={cn(
            "shrink-0 text-[11px]",
            addedServer.status === "connected"
              ? "text-emerald-700"
              : addedServer.status === "error"
                ? "text-destructive"
                : addedServer.status === "connecting"
                  ? "text-muted-foreground"
                  : "text-amber-700",
          )}
        >
          {catalogStatusLabel(addedServer, entry)}
        </span>
      ) : entry.blocked ? (
        entry.docsUrl ? (
          <a
            href={entry.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-full border border-border px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Docs
          </a>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">No browser access</span>
        )
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1 rounded-full border-border"
          data-testid={mcpCatalogConnectTid(entry.id)}
          onClick={onDeviceSignIn ?? onConnect}
        >
          {entry.auth === "oauth" || onDeviceSignIn ? (
            <LogIn className="h-3.5 w-3.5" />
          ) : (
            <Plug className="h-3.5 w-3.5" />
          )}
          {entry.auth === "oauth" || onDeviceSignIn ? "Sign in" : "Connect"}
        </Button>
      )}
    </div>
  );
}

function ConnectedCard({
  server,
  expanded,
  onToggleExpand,
  onRemove,
  onUpdate,
  onConnect,
  onToggleTool,
  onDeviceSignIn,
}: {
  server: McpServerConfig;
  expanded: boolean;
  onToggleExpand: () => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<McpServerConfig>) => void;
  onConnect: () => void;
  onToggleTool: (name: string) => void;
  onDeviceSignIn?: () => void;
}) {
  const entry = findCatalogEntry(server.catalogId ?? server.id);
  const authMode: McpAuthMode = server.authMode ?? "auto";
  const isOAuth = entry?.auth === "oauth" || (!entry && authMode === "oauth");
  const signedIn = (isOAuth || Boolean(entry?.deviceFlow)) && server.status === "connected";
  const showSignIn =
    (isOAuth || Boolean(onDeviceSignIn)) && !signedIn && !(server.token ?? "").trim();
  const needsKey = entry ? entry.auth === "token" : authMode === "auto" || authMode === "bearer";
  const blockedReason = entry?.blocked;
  const statusLabel =
    server.status === "connected"
      ? `${server.tools.length} tools${server.identity ? ` · ${server.identity}` : ""}`
      : server.status === "connecting"
        ? isOAuth && !signedIn
          ? "Waiting for sign-in…"
          : "Connecting…"
        : server.error ??
          (blockedReason
            ? "Blocked by the provider — open for details"
            : signedIn
              ? "Signed in — press Connect to verify"
              : "Not connected — not verified");

  return (
    <div data-testid={mcpServerCardTid(server.id)} className="rounded-2xl border border-border/70 bg-card p-3">
      <div className="flex items-center gap-2">
        <McpAvatar
          seed={server.id}
          name={server.name}
          iconUrl={serverIconUrl(server)}
          className="h-8 w-8 rounded-lg text-[11px]"
        />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onToggleExpand}>
          <span className="block truncate text-sm">{server.name}</span>
          <span
            className={cn(
              "block truncate text-[11px]",
              server.status === "connected"
                ? "text-emerald-700"
                : server.status === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
          >
            {statusLabel}
          </span>
        </button>
        <Switch checked={server.enabled} onCheckedChange={(checked) => onUpdate({ enabled: checked })} />
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 rounded-full border-border"
          onClick={() => {
            if (showSignIn && onDeviceSignIn) {
              onDeviceSignIn();
            } else {
              onConnect();
            }
          }}
          // While waiting for a popup sign-in the button stays live — if the
          // window got lost (closed, buried, browser severed it) a new click
          // restarts the flow; the superseded attempt can't clobber it.
          disabled={
            !server.url.trim() ||
            (server.status === "connecting" && !showSignIn) ||
            Boolean(blockedReason)
          }
        >
          {showSignIn ? <LogIn className="h-3.5 w-3.5" /> : <Plug className="h-3.5 w-3.5" />}
          {server.status === "connecting"
            ? showSignIn
              ? "Sign in again"
              : "…"
            : server.status === "connected"
              ? "Re-check"
              : showSignIn
                ? "Sign in"
                : "Connect"}
        </Button>
        <button type="button" aria-label="Remove MCP" onClick={onRemove}>
          <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
        </button>
      </div>
      {expanded ? (
        <div className="mt-3 space-y-2">
          {blockedReason ? (
            <p className="text-[11px] leading-relaxed text-amber-700/90">{blockedReason}</p>
          ) : null}
          {server.status === "connected" ? (
            <p className="text-[11px] leading-relaxed text-emerald-700">
              Verified {verifiedTime(server.verifiedAt)} — handshake and tool listing succeeded
              {server.identity ? ` · ${server.identity}` : ""}.
            </p>
          ) : null}
          {entry ? (
            <p className="text-[11px] text-muted-foreground">
              {entry.hint}
              {isOAuth ? " · authorizes via a browser popup" : ""}
              {entry.docsUrl ? (
                <>
                  {" · "}
                  <a
                    href={entry.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ember underline-offset-2 hover:underline"
                  >
                    Setup guide
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {!entry ? (
            <>
              <Input
                value={server.name}
                onChange={(event) => onUpdate({ name: event.target.value })}
                className="h-8 border-border bg-white text-sm"
              />
              <Input
                value={server.url}
                onChange={(event) => onUpdate({ url: event.target.value })}
                placeholder="https://your-mcp-server/mcp"
                className="h-8 border-border bg-white text-xs"
              />
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[11px] text-muted-foreground">Auth</span>
                <Select
                  value={authMode}
                  onValueChange={(value) => onUpdate({ authMode: value as McpAuthMode })}
                >
                  <SelectTrigger className="h-8 flex-1 border-border bg-white text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTH_MODES.map((mode) => (
                      <SelectItem key={mode.value} value={mode.value} className="text-xs">
                        {mode.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {authMode === "auto" || authMode === "headers" ? (
                <Textarea
                  value={server.headersJson}
                  onChange={(event) => onUpdate({ headersJson: event.target.value })}
                  placeholder='Optional headers JSON, e.g. {"Authorization":"Bearer …"}'
                  className="min-h-[64px] border-border bg-white font-mono text-xs"
                />
              ) : null}
            </>
          ) : null}
          {entry?.deviceFlow ? (
            <>
              {onDeviceSignIn ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 rounded-full border-border"
                  onClick={onDeviceSignIn}
                >
                  <LogIn className="h-3.5 w-3.5" />
                  {signedIn ? "Sign in again" : "Sign in with GitHub"}
                </Button>
              ) : (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Browser sign-in needs a one-time setup: the workspace admin registers a GitHub OAuth app
                  (with Device Flow enabled) and adds its client ID. Until then, paste a personal access
                  token below.
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Connect verifies whose token this is — the card then shows @login and whether private
                repos are reachable. The device flow signs in whichever account is logged into github.com
                in that browser. Org-owned private repos stay hidden until the organization grants this
                OAuth app access
                {githubOrgAccessUrl() ? (
                  <>
                    {" — "}
                    <a
                      href={githubOrgAccessUrl() ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="text-ember underline-offset-2 hover:underline"
                    >
                      review org access
                    </a>
                  </>
                ) : null}
                .
              </p>
            </>
          ) : null}
          {needsKey ? (
            <Input
              type="password"
              autoComplete="off"
              value={server.token ?? ""}
              onChange={(event) => onUpdate({ token: event.target.value })}
              placeholder={entry?.tokenPlaceholder ?? "Bearer token"}
              className="h-8 border-border bg-white text-xs"
            />
          ) : null}
          {server.tools.length > 0 ? (
            <div className="space-y-1">
              {server.tools.map((tool) => (
                <label key={tool.name} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{tool.name}</span>
                  <Switch checked={!server.disabledTools.includes(tool.name)} onCheckedChange={() => onToggleTool(tool.name)} />
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function verifiedTime(ts?: number): string {
  if (!ts) {
    return "recently";
  }
  return new Date(ts).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-[11px] tracking-wide",
        active ? "bg-ember/10 text-ember" : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10",
      )}
    >
      {label}
    </button>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "M";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function hashTone(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % AVATAR_TONES.length;
  }
  return hash;
}
