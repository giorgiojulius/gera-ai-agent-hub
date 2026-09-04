// The project's agent roster — admin-owned profiles for any job (support,
// code, research, writing…). Owners/admins get the full editor: role presets,
// model + thinking effort, exact access. Members get read-only profile cards
// with a Copy @handle action — they pick from what admins publish, never edit.
// Access maps to real tool surfaces on the worker — GitHub read-only literally
// has no write tools; tokens live server-side and never come back to the
// client (only set/unset flags). Credentials are one tap where possible:
// GitHub reuses the workspace device-flow sign-in and verifies the account
// via api.github.com (CORS-safe) before anything is saved. MCP is the same
// picker as chat/automations: the admin toggles their connected servers and
// the agent stores refs only — runs resolve them through the admin's account
// (keys and sign-ins stay there, refreshed like cloud automations).
import { useQueryClient } from "@tanstack/react-query";
import {
  AtSign,
  Bot,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  Github,
  Globe,
  KeyRound,
  LifeBuoy,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Slack,
  Trash2,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { GitHubSignInDialog } from "@/components/gera/GitHubSignInDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgent } from "@/hooks/use-agent";
import { useAuth } from "@/hooks/use-auth";
import { cloudMcpReadiness } from "@/lib/automations";
import {
  fetchGitHubViewer,
  githubDeviceClientId,
  githubIdentityLabel,
  type GitHubViewer,
} from "@/lib/github-device";
import { findCatalogEntry, serverIconUrl } from "@/lib/mcp-catalog";
import {
  MODE_MODEL_IDS,
  REASONING_EFFORTS,
  effortLabel,
  modelShortName,
  withEffort,
  type ReasoningEffort,
} from "@/lib/models";
import {
  MAX_AGENT_MCP_SERVERS,
  accessSummary,
  createAgentSlackApp,
  deleteProjectAgent,
  fetchAgentSlackInstallUrl,
  fetchProjectOverview,
  slackEventsUrl,
  saveProjectSlackConfig,
  upsertProjectAgent,
  type AgentMcpServer,
  type AgentMcpWrites,
  type AgentUpsertPayload,
  type GithubAccessLevel,
  type ProjectAgent,
  type ProjectSlackConfig,
} from "@/lib/projects";
import { TID } from "@/lib/testids";
import type { McpServerConfig, McpToolInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

type TokenDraft = { value: string; clear: boolean };

type Draft = {
  id?: string;
  name: string;
  handle: string;
  emoji: string;
  instructions: string;
  modelBase: string;
  modelEffort: "" | ReasoningEffort;
  web: boolean;
  github: GithubAccessLevel;
  intercom: boolean;
  slack: boolean;
  mcp: boolean;
  /** Linked MCP servers — ids + names (+ optional tool allowlists) picked from the admin's connected list. */
  mcpSelection: AgentMcpServer[];
  /** Whose account the saved link resolves through ("" = none yet). */
  mcpOwner: string;
  /** Write policy for the linked servers: "ask" declines write tools (agents run unattended), "auto" runs them. */
  mcpWrites: AgentMcpWrites;
  githubToken: TokenDraft;
  githubFromAccount: boolean;
  intercomToken: TokenDraft;
  slackToken: TokenDraft;
  slackSigningSecret: TokenDraft;
  /** Slack app minted from Gera — mirrors the wire; `team` fills in on install. */
  slackApp: { appId: string; team: string } | null;
  /** Marks the Gera-created Slack app for disconnect on save. */
  slackDisconnect: boolean;
  stored: { github: boolean; intercom: boolean; slack: boolean; slackSigning: boolean };
};

/** Live check of who a GitHub token signs in as — keyed to the exact token. */
type GithubCheck =
  | { state: "idle" }
  | { state: "checking"; token: string }
  | { state: "ok"; token: string; viewer: GitHubViewer }
  | { state: "bad"; token: string; error: string };

const EMPTY_TOKEN: TokenDraft = { value: "", clear: false };

/** Stop polling for the Slack install after this long — the button restarts it. */
const SLACK_INSTALL_POLL_TIMEOUT_MS = 3 * 60_000;

/** "vendor/model:high" → base + effort; bare ids pass through untouched. */
function splitModelId(model: string): { base: string; effort: "" | ReasoningEffort } {
  const idx = model.lastIndexOf(":");
  if (idx > 0) {
    const effort = model.slice(idx + 1);
    if ((REASONING_EFFORTS as readonly string[]).includes(effort)) {
      return { base: model.slice(0, idx), effort: effort as ReasoningEffort };
    }
  }
  return { base: model, effort: "" };
}

/** Chat catalog deduped to base ids — effort is picked separately. */
const CHAT_MODEL_BASES: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of MODE_MODEL_IDS.chat) {
    const base = splitModelId(id).base;
    if (!seen.has(base)) {
      seen.add(base);
      out.push(base);
    }
  }
  return out;
})();

const EFFORT_CHOICES: ReadonlyArray<["" | ReasoningEffort, string]> = [
  ["", "Auto"],
  ...REASONING_EFFORTS.map((effort): ["" | ReasoningEffort, string] => [effort, effortLabel(effort)]),
];

/** Human label for an agent's stored model string. */
function agentModelLabel(model: string): string {
  if (!model) {
    return "Default (Grok 4.6)";
  }
  const { base, effort } = splitModelId(model);
  return effort ? `${modelShortName(base)} · ${effortLabel(effort)}` : modelShortName(base);
}

type AgentPreset = {
  label: string;
  emoji: string;
  name: string;
  instructions: string;
  web: boolean;
  github: GithubAccessLevel;
  intercom: boolean;
  slack: boolean;
};

/** Quick-start roles — agents are for any job, not just support. */
const AGENT_PRESETS: AgentPreset[] = [
  {
    label: "Repo guide",
    emoji: "\u{1F4DA}",
    name: "Repo Guide",
    web: true,
    github: "read",
    intercom: false,
    slack: false,
    instructions:
      "You answer questions about our repository: architecture, where features live, recent changes, PRs and CI. Link the exact files and lines. You are read-only — when someone asks for a change, explain what it would involve instead of attempting it.",
  },
  {
    label: "Support triage",
    emoji: "\u{1F3A7}",
    name: "Support Triage",
    web: true,
    github: "off",
    intercom: true,
    slack: false,
    instructions:
      "You work the customer inbox: find the conversation, summarize the customer's issue and history, and draft a clear, warm reply. Never invent policy — when unsure, say exactly what needs checking and by whom.",
  },
  {
    label: "Release engineer",
    emoji: "\u{1F680}",
    name: "Release Engineer",
    web: true,
    github: "write",
    intercom: false,
    slack: false,
    instructions:
      "You help ship: create branches, commit agreed changes, open PRs and issues — only when the request explicitly asks for a write. Confirm the exact repo and branch first, and end every reply with the list of actions you took.",
  },
  {
    label: "Researcher",
    emoji: "\u{1F52D}",
    name: "Researcher",
    web: true,
    github: "off",
    intercom: false,
    slack: false,
    instructions:
      "You research questions on the live web: compare options, verify claims, check prices and docs. Lead with the answer, then the evidence — every claim that matters gets a source.",
  },
  {
    label: "Writer",
    emoji: "\u270D\uFE0F",
    name: "Writer",
    web: false,
    github: "off",
    intercom: false,
    slack: false,
    instructions:
      "You draft and edit team copy: announcements, docs, replies, release notes. Work from the thread context, keep the team's tone, and offer two variants when the ask is open-ended.",
  },
];

function draftFrom(agent: ProjectAgent | null): Draft {
  const parsed = splitModelId(agent?.model ?? "");
  return {
    id: agent?.id,
    name: agent?.name ?? "",
    handle: agent?.handle ?? "",
    emoji: agent?.emoji ?? "",
    instructions: agent?.instructions ?? "",
    modelBase: parsed.base,
    modelEffort: parsed.effort,
    web: agent?.access.web ?? true,
    github: agent?.access.github ?? "off",
    intercom: agent?.access.intercom ?? false,
    slack: agent?.access.slack ?? false,
    mcp: agent?.access.mcp ?? false,
    mcpSelection: (agent?.mcpServers ?? []).map((server) => ({
      id: server.id,
      name: server.name,
      ...(server.tools ? { tools: [...server.tools] } : {}),
    })),
    mcpOwner: agent?.mcpOwner ?? "",
    mcpWrites: agent?.mcpWrites === "ask" ? "ask" : "auto",
    githubToken: { ...EMPTY_TOKEN },
    githubFromAccount: false,
    intercomToken: { ...EMPTY_TOKEN },
    slackToken: { ...EMPTY_TOKEN },
    slackSigningSecret: { ...EMPTY_TOKEN },
    slackApp: agent?.slackApp ?? null,
    slackDisconnect: false,
    stored: {
      github: agent?.secretsSet.github ?? false,
      intercom: agent?.secretsSet.intercom ?? false,
      slack: agent?.secretsSet.slack ?? false,
      slackSigning: agent?.secretsSet.slackSigning ?? false,
    },
  };
}

function normalizeGithubToken(value: string): string {
  return value.trim().replace(/^Bearer\s+/i, "");
}

function githubTokenPatch(draft: TokenDraft): string | null {
  if (draft.clear) {
    return null;
  }
  return normalizeGithubToken(draft.value);
}

function tokenPatch(draft: TokenDraft): string | null {
  if (draft.clear) {
    return null;
  }
  const value = draft.value.trim();
  return value.length > 0 ? value : "";
}

export function AgentsPanel({
  projectId,
  agents,
  canManage,
  slackConfig,
}: {
  projectId: string;
  agents: ProjectAgent[];
  canManage: boolean;
  slackConfig: ProjectSlackConfig | null;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<ProjectAgent | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [githubSignInOpen, setGithubSignInOpen] = useState<boolean>(false);
  const [githubCheck, setGithubCheck] = useState<GithubCheck>({ state: "idle" });
  const [githubPasteOpen, setGithubPasteOpen] = useState<boolean>(false);
  const [slackConfigToken, setSlackConfigToken] = useState<string>("");
  const [slackCreating, setSlackCreating] = useState<boolean>(false);
  const [slackInstall, setSlackInstall] = useState<{ url: string; waiting: boolean } | null>(null);
  const [slackManualOpen, setSlackManualOpen] = useState<boolean>(false);
  const [slackManagerBusy, setSlackManagerBusy] = useState<boolean>(false);

  const githubDeviceReady = githubDeviceClientId() !== null;

  /** Opens the editor with fresh per-dialog credential state. */
  const openEditor = (agent: ProjectAgent | null) => {
    setDraft(draftFrom(agent));
    setGithubCheck({ state: "idle" });
    setGithubPasteOpen(false);
    setSlackConfigToken("");
    setSlackCreating(false);
    setSlackInstall(null);
    // Agents that were wired by hand keep the familiar paste fields open.
    setSlackManualOpen(
      Boolean(agent && !agent.slackApp && (agent.secretsSet.slack || agent.secretsSet.slackSigning)),
    );
  };

  const copyHandle = async (handle: string) => {
    try {
      await navigator.clipboard.writeText(`@${handle}`);
      toast.success(`Copied @${handle} — paste it in any channel`);
    } catch {
      toast.error(`Could not copy — type @${handle} manually`);
    }
  };

  /** Asks api.github.com who the token belongs to — runs in the browser, token never leaves it. */
  const verifyGithub = (token: string) => {
    const normalized = normalizeGithubToken(token);
    if (!normalized) {
      setGithubCheck({ state: "bad", token: "", error: "Paste a GitHub token first." });
      return;
    }
    setGithubCheck({ state: "checking", token: normalized });
    void (async () => {
      try {
        const viewer = await fetchGitHubViewer(`Bearer ${normalized}`);
        setGithubCheck({ state: "ok", token: normalized, viewer });
      } catch (error) {
        setGithubCheck({
          state: "bad",
          token: normalized,
          error: error instanceof Error ? error.message : "Could not verify the token.",
        });
      }
    })();
  };

  const adoptGithubToken = (token: string) => {
    const normalized = normalizeGithubToken(token);
    setDraft((prev) =>
      prev
        ? { ...prev, githubToken: { value: normalized, clear: false }, githubFromAccount: false }
        : prev,
    );
    setGithubPasteOpen(false);
    verifyGithub(normalized);
  };

  /** Device-flow finished — link the project to the account shard, never copy a token. */
  const handleGithubSignedIn = () => {
    setGithubSignInOpen(false);
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            githubFromAccount: true,
            githubToken: { value: "", clear: false },
          }
        : prev,
    );
    setGithubCheck({ state: "checking", token: "gera-account:github" });
    void fetchGitHubViewer("gera-account:github")
      .then((viewer) => {
        setGithubCheck({ state: "ok", token: "gera-account:github", viewer });
        toast.success("GitHub connected through your account — no token was copied.");
      })
      .catch((error) => {
        setGithubCheck({
          state: "bad",
          token: "gera-account:github",
          error: error instanceof Error ? error.message : "Could not verify GitHub.",
        });
      });
  };

  /** One tap starts the account-owned device flow. */
  const fillFromMyGithub = () => {
    setGithubSignInOpen(true);
  };

  const copyEventsUrl = async (eventsUrl: string) => {
    try {
      await navigator.clipboard.writeText(eventsUrl);
      toast.success("Events URL copied — paste it into Slack's Event Subscriptions");
    } catch {
      toast.error("Could not copy the URL");
    }
  };

  /** Wizard step 1 — connect the app manager if needed, then mint the Slack app. */
  const createSlackBot = async () => {
    if (!draft?.id || slackCreating) {
      return;
    }
    const token = slackConfigToken.trim();
    if (!slackConfig && !token) {
      toast.error("Paste the refresh token from api.slack.com/apps first");
      return;
    }
    const agentId = draft.id;
    setSlackCreating(true);
    try {
      if (token) {
        // One paste connects the project-level manager; the server rotates it from now on.
        await saveProjectSlackConfig(projectId, token);
      }
      const result = await createAgentSlackApp(projectId, agentId);
      setSlackConfigToken("");
      setSlackManualOpen(false);
      setDraft((prev) =>
        prev && prev.id === agentId && result.agent
          ? {
              ...prev,
              slackApp: result.agent.slackApp ?? null,
              slackDisconnect: false,
              stored: {
                ...prev.stored,
                slack: result.agent.secretsSet.slack,
                slackSigning: result.agent.secretsSet.slackSigning,
              },
            }
          : prev,
      );
      if (result.warning) {
        toast.warning(result.warning);
      } else {
        toast.success("Slack app created — now install it to your workspace");
      }
      if (result.installUrl) {
        setSlackInstall({ url: result.installUrl, waiting: false });
      }
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the Slack app");
      // A dead stored connection is dropped server-side — refresh the status.
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    } finally {
      setSlackCreating(false);
    }
  };

  /** Forgets the stored app-manager connection; created apps and bots stay. */
  const disconnectSlackManager = async () => {
    if (slackManagerBusy) {
      return;
    }
    setSlackManagerBusy(true);
    try {
      await saveProjectSlackConfig(projectId, null);
      toast.success("Slack app manager disconnected");
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect");
    } finally {
      setSlackManagerBusy(false);
    }
  };

  /** Wizard step 2 — open Slack's install page; the callback stores the bot token. */
  const openSlackInstall = async () => {
    if (!draft?.id) {
      return;
    }
    try {
      const installUrl = slackInstall?.url ?? (await fetchAgentSlackInstallUrl(projectId, draft.id));
      window.open(installUrl, "_blank", "noopener");
      setSlackInstall({ url: installUrl, waiting: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not get the install link");
    }
  };

  const editingAgentId = draft?.id ?? null;
  const installWaiting = slackInstall?.waiting === true;

  // While the Slack install tab is open, watch the agent until the bot token
  // lands server-side — the editor flips to "installed" without a manual save.
  useEffect(() => {
    if (!installWaiting || !editingAgentId) {
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const overview = await fetchProjectOverview(projectId);
          const fresh = overview.agents.find((agent) => agent.id === editingAgentId);
          if (fresh?.secretsSet.slack) {
            window.clearInterval(timer);
            setSlackInstall(null);
            setDraft((prev) =>
              prev && prev.id === editingAgentId
                ? {
                    ...prev,
                    slack: true,
                    slackApp: fresh.slackApp ?? prev.slackApp,
                    stored: { ...prev.stored, slack: true, slackSigning: fresh.secretsSet.slackSigning },
                  }
                : prev,
            );
            toast.success(
              `Slack bot installed${fresh.slackApp?.team ? ` to ${fresh.slackApp.team}` : ""} — /invite it to a channel and @mention it`,
            );
            await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
          } else if (Date.now() - startedAt > SLACK_INSTALL_POLL_TIMEOUT_MS) {
            window.clearInterval(timer);
            setSlackInstall((prev) => (prev ? { ...prev, waiting: false } : prev));
          }
        } catch {
          // transient — the next tick retries
        }
      })();
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [installWaiting, editingAgentId, projectId, queryClient]);

  /**
   * Persists the draft. `stay` keeps the editor open and reloads the draft
   * from the saved row — the Slack setup needs the agent's id (minted on
   * first save), so the amber note saves in place instead of sending the
   * admin to hunt for the footer button.
   */
  const save = async (options?: { stay?: boolean }) => {
    if (!draft || saving) {
      return;
    }
    if (draft.name.trim().length === 0) {
      toast.error("Give the agent a name");
      return;
    }
    const githubToken = normalizeGithubToken(draft.githubToken.value);
    const willHaveGithub =
      !draft.githubToken.clear && (Boolean(githubToken) || draft.githubFromAccount || draft.stored.github);
    if (draft.github !== "off" && !willHaveGithub) {
      toast.error("Connect a GitHub credential before enabling GitHub access");
      return;
    }
    if (
      draft.github !== "off" &&
      githubToken &&
      !(githubCheck.state === "ok" && githubCheck.token === githubToken)
    ) {
      toast.error("Verify this GitHub credential before saving the agent");
      return;
    }
    setSaving(true);
    try {
      const payload: AgentUpsertPayload = {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        handle: draft.handle.trim(),
        emoji: draft.emoji.trim(),
        instructions: draft.instructions,
        model: draft.modelBase ? withEffort(draft.modelBase, draft.modelEffort || undefined) : "",
        access: {
          web: draft.web,
          github: draft.github,
          intercom: draft.intercom,
          slack: draft.slack,
          mcp: draft.mcp,
        },
        secrets: {
          githubToken: githubTokenPatch(draft.githubToken),
          ...(draft.githubFromAccount ? { githubFromAccount: true } : {}),
          intercomToken: tokenPatch(draft.intercomToken),
          slackToken: tokenPatch(draft.slackToken),
          slackSigningSecret: tokenPatch(draft.slackSigningSecret),
          ...(draft.slackDisconnect ? { slackApp: null } : {}),
          // Sent only while the switch is on — switched off, the stored
          // link stays put, mirroring how tokens behave.
          ...(draft.mcp ? { mcpSelection: draft.mcpSelection, mcpWrites: draft.mcpWrites } : {}),
        },
      };
      const saved = await upsertProjectAgent(projectId, payload);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      if (options?.stay) {
        setDraft(draftFrom(saved));
        toast.success("Agent saved — Slack setup unlocked below");
      } else {
        toast.success(`Saved — mention @${saved.handle} in any channel`);
        setDraft(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the agent");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id || saving) {
      return;
    }
    if (!window.confirm("Delete this agent? Its channel replies stay in place.")) {
      return;
    }
    setSaving(true);
    try {
      await deleteProjectAgent(projectId, draft.id);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      setDraft(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the agent");
    } finally {
      setSaving(false);
    }
  };

  // Check result only counts while it matches the token currently in the draft.
  const ghCheck =
    draft && githubCheck.state !== "idle" && githubCheck.token === draft.githubToken.value
      ? githubCheck
      : null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl tracking-tight">Agents</h2>
          <p className="mt-1 max-w-lg text-sm leading-relaxed text-muted-foreground">
            {canManage
              ? "The project's admin panel: each agent is a ready-made profile — instructions, model, and exactly the access you grant — for any job: code, support, research, writing. Teammates mention "
              : "Ready-made teammates set up by the project admins — code, support, research, writing, anything. Open a card to see what one can do, then mention "}
            <span className="font-medium text-foreground">@handle</span>
            {canManage
              ? " to use one; only the owner and admins can edit."
              : " in a channel to put it to work."}
          </p>
        </div>
        {canManage ? (
          <Button
            onClick={() => openEditor(null)}
            className="h-9 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90"
          >
            <Plus className="h-4 w-4" />
            New agent
          </Button>
        ) : null}
      </div>

      {agents.length === 0 ? (
        <div className="gera-card mt-5 rounded-3xl p-8 text-center">
          <p className="text-sm font-medium">No agents yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">
            {canManage
              ? "Create agents for any job: a read-only repo guide, a support desk on the Intercom inbox, a live-web researcher, a release engineer that ships PRs. Role presets in the editor get you started."
              : "The project admins haven't published agents yet — ask them for the roles your team needs."}
          </p>
          {canManage ? (
            <Button
              onClick={() => openEditor(null)}
              className="mt-4 h-9 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90"
            >
              <Plus className="h-4 w-4" />
              Create the first agent
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => (canManage ? openEditor(agent) : setViewing(agent))}
              className="gera-card group rounded-3xl p-4 text-left transition-all hover:-translate-y-0.5 hover:border-ember/50"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-ember/10 text-lg">
                  {agent.emoji || <Bot className="h-5 w-5 text-ember" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{agent.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">@{agent.handle}</span>
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {accessSummary(agent).map((chip) => (
                  <span
                    key={chip}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      chip.endsWith("no token") || chip.endsWith("no servers")
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
                        : "border-border/70 bg-foreground/[0.03] text-muted-foreground",
                    )}
                  >
                    {chip}
                  </span>
                ))}
                {agent.model ? (
                  <span className="rounded-full border border-border/70 bg-foreground/[0.03] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {agentModelLabel(agent.model)}
                  </span>
                ) : null}
              </div>
              {agent.instructions ? (
                <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {agent.instructions}
                </p>
              ) : null}
              <span className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-2.5 text-xs font-semibold text-ember">
                {canManage ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {canManage ? "Configure agent" : "View profile"}
                <ChevronRight className="ml-auto h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
          ))}
        </div>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => (!open ? setDraft(null) : undefined)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto rounded-3xl sm:max-w-2xl [&>*]:min-w-0">
          {draft ? (
            <>
              <DialogHeader>
                <DialogTitle>{draft.id ? "Edit agent" : "New agent"}</DialogTitle>
                <DialogDescription>
                  Members can mention and use this agent — only admins edit it. Access is enforced
                  server-side; tokens stay on the server and never reach members.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                {!draft.id ? (
                  <div>
                    <FieldLabel>Start from a role</FieldLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {AGENT_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              name: preset.name,
                              emoji: preset.emoji,
                              instructions: preset.instructions,
                              web: preset.web,
                              github: preset.github,
                              intercom: preset.intercom,
                              slack: preset.slack,
                            })
                          }
                          className="flex items-center gap-1.5 rounded-full border border-border/70 bg-foreground/[0.03] px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-ember/40 hover:text-foreground"
                        >
                          <span aria-hidden>{preset.emoji}</span>
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="grid grid-cols-[1fr_72px] gap-2">
                  <div>
                    <FieldLabel>Name</FieldLabel>
                    <Input
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                      placeholder="Repo Guide"
                      maxLength={40}
                      className="h-10 rounded-xl"
                    />
                  </div>
                  <div>
                    <FieldLabel>Emoji</FieldLabel>
                    <Input
                      value={draft.emoji}
                      onChange={(event) => setDraft({ ...draft, emoji: event.target.value })}
                      placeholder="📚"
                      maxLength={4}
                      className="h-10 rounded-xl text-center"
                    />
                  </div>
                </div>
                <div>
                  <FieldLabel>Handle — teammates mention @handle</FieldLabel>
                  <Input
                    value={draft.handle}
                    onChange={(event) => setDraft({ ...draft, handle: event.target.value })}
                    placeholder="auto from the name"
                    maxLength={24}
                    className="h-10 rounded-xl"
                  />
                </div>
                <div>
                  <FieldLabel>Instructions — who this agent is</FieldLabel>
                  <Textarea
                    value={draft.instructions}
                    onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                    placeholder="Who this agent is and how it answers — e.g. 'You answer questions about our repository: architecture, where features live, recent changes. Link the exact files.'"
                    rows={4}
                    maxLength={4_000}
                    className="rounded-xl text-sm"
                  />
                </div>
                <div>
                  <FieldLabel>Model — the brain this agent runs on</FieldLabel>
                  <select
                    value={draft.modelBase}
                    onChange={(event) =>
                      setDraft({ ...draft, modelBase: event.target.value, modelEffort: "" })
                    }
                    className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-foreground/25"
                  >
                    <option value="">Default (Grok 4.6)</option>
                    {CHAT_MODEL_BASES.map((id) => (
                      <option key={id} value={id}>
                        {modelShortName(id)}
                      </option>
                    ))}
                  </select>
                  {draft.modelBase ? (
                    <div className="mt-2">
                      <FieldLabel>Thinking effort</FieldLabel>
                      <div className="flex items-center gap-1 rounded-full border border-border/70 bg-foreground/[0.04] p-0.5">
                        {EFFORT_CHOICES.map(([effort, label]) => (
                          <button
                            key={label}
                            type="button"
                            onClick={() => setDraft({ ...draft, modelEffort: effort })}
                            className={cn(
                              "flex-1 rounded-full px-2 py-1.5 text-xs font-medium transition-colors",
                              draft.modelEffort === effort
                                ? "bg-white text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="overflow-hidden rounded-2xl border border-border/70">
                  <div className="border-b border-border/60 bg-foreground/[0.03] px-4 py-3">
                    <p className="text-sm font-semibold">Access</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      The agent gets exactly these tools — enforced on the server, nothing more.
                    </p>
                  </div>
                  <div className="divide-y divide-border/60">
                    <AccessRow
                      icon={Globe}
                      iconClassName="bg-sky-500/10 text-sky-600"
                      title="Web"
                      description="Live search and page reading, with citations."
                      checked={draft.web}
                      onCheckedChange={(checked) => setDraft({ ...draft, web: checked })}
                    />

                    <AccessRow
                      icon={Github}
                      iconClassName="bg-foreground/[0.07] text-foreground"
                      title="GitHub"
                      description="Repos, PRs, issues and CI — as a connected account."
                      checked={draft.github !== "off"}
                      onCheckedChange={(checked) =>
                        setDraft({ ...draft, github: checked ? "read" : "off" })
                      }
                    >
                      {draft.github !== "off" ? (
                        <div className="space-y-2.5">
                          <div className="grid grid-cols-2 gap-1.5">
                            <LevelOption
                              selected={draft.github === "read"}
                              title="Read-only"
                              description="Browses code, PRs, issues, CI logs. Physically can't change anything."
                              onSelect={() => setDraft({ ...draft, github: "read" })}
                            />
                            <LevelOption
                              selected={draft.github === "write"}
                              title="Read & write"
                              description="Also commits, branches, opens PRs and issues."
                              onSelect={() => setDraft({ ...draft, github: "write" })}
                            />
                          </div>

                          <div className="rounded-xl border border-border/60 bg-background/70 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="flex items-center gap-1.5 text-xs font-semibold">
                                <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                                GitHub account
                              </p>
                              <a
                                href="https://github.com/settings/tokens"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                              >
                                Tokens on GitHub
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>

                            {draft.githubToken.clear ? (
                              <p className="mt-2 text-xs text-muted-foreground">
                                Token will be removed on save.{" "}
                                <button
                                  type="button"
                                  className="font-medium text-foreground underline underline-offset-2"
                                  onClick={() =>
                                    setDraft({ ...draft, githubToken: { value: "", clear: false } })
                                  }
                                >
                                  Undo
                                </button>
                              </p>
                            ) : (
                              <div className="mt-2 space-y-2">
                                {!draft.githubToken.value && draft.stored.github ? (
                                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-emerald-700">
                                    <Check className="h-3.5 w-3.5" />
                                    Token saved server-side.
                                    <button
                                      type="button"
                                      className="font-medium text-destructive underline underline-offset-2"
                                      onClick={() =>
                                        setDraft({
                                          ...draft,
                                          githubToken: { value: "", clear: true },
                                          githubFromAccount: false,
                                        })
                                      }
                                    >
                                      Remove
                                    </button>
                                  </p>
                                ) : null}
                                {!draft.githubToken.value && githubDeviceReady ? (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                      type="button"
                                      onClick={fillFromMyGithub}
                                      className="h-8 gap-1.5 rounded-full px-3 text-xs"
                                    >
                                      <Github className="h-3.5 w-3.5" />
                                      {draft.githubFromAccount
                                        ? "Replace GitHub account"
                                        : "Sign in with GitHub"}
                                    </Button>
                                    {!githubPasteOpen ? (
                                      <button
                                        type="button"
                                        className="text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                        onClick={() => setGithubPasteOpen(true)}
                                      >
                                        Paste a token instead
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                                {githubPasteOpen ||
                                draft.githubToken.value ||
                                !githubDeviceReady ? (
                                  <Input
                                    type="password"
                                    autoComplete="off"
                                    autoFocus={githubPasteOpen && !draft.githubToken.value}
                                    value={draft.githubToken.value}
                                    onChange={(event) =>
                                      setDraft({
                                        ...draft,
                                        githubToken: { value: event.target.value, clear: false },
                                        githubFromAccount: false,
                                      })
                                    }
                                    placeholder="ghp_… or github_pat_… (fine-grained, repo scope)"
                                    className="h-9 rounded-lg font-mono text-xs"
                                  />
                                ) : null}
                                {draft.githubToken.value ? (
                                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                    {ghCheck?.state === "checking" ? (
                                      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Checking the account…
                                      </span>
                                    ) : ghCheck?.state === "ok" ? (
                                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                                        <Check className="h-3.5 w-3.5" />
                                        Acts as {githubIdentityLabel(ghCheck.viewer)}
                                      </span>
                                    ) : ghCheck?.state === "bad" ? (
                                      <span className="text-[11px] font-medium text-destructive">
                                        {ghCheck.error}
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        className="text-[11px] font-medium text-foreground underline underline-offset-2"
                                        onClick={() => verifyGithub(draft.githubToken.value)}
                                      >
                                        Check the account
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className="text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                      onClick={() => {
                                        setDraft({ ...draft, githubToken: { value: "", clear: false } });
                                        setGithubPasteOpen(false);
                                      }}
                                    >
                                      Clear
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            )}

                            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                              The agent acts on GitHub as this account. Stored server-side — members
                              never see it; without a credential the agent honestly says so.
                            </p>
                          </div>
                        </div>
                      ) : null}
                    </AccessRow>

                    <AccessRow
                      icon={LifeBuoy}
                      iconClassName="bg-blue-500/10 text-blue-600"
                      title="Intercom"
                      description="Reads and replies in the team's Intercom inbox."
                      checked={draft.intercom}
                      onCheckedChange={(checked) => setDraft({ ...draft, intercom: checked })}
                    >
                      {draft.intercom ? (
                        <TokenField
                          label="Access token"
                          placeholder="Access token from your Intercom app"
                          stored={draft.stored.intercom}
                          draft={draft.intercomToken}
                          onChange={(token) => setDraft({ ...draft, intercomToken: token })}
                          helpUrl="https://app.intercom.com/a/apps/_/developer-hub"
                          helpLabel="Developer Hub"
                          note="Developer Hub → your app → Authentication → copy the Access token. Replies go out as the admin who owns it."
                        />
                      ) : null}
                    </AccessRow>

                    <AccessRow
                      icon={Slack}
                      iconClassName="bg-purple-500/10 text-purple-700"
                      title="Slack"
                      description="Reads and posts in your Slack workspace."
                      checked={draft.slack}
                      onCheckedChange={(checked) => setDraft({ ...draft, slack: checked })}
                    >
                      {draft.slack ? (
                        <div className="space-y-2.5">
                          {draft.slackDisconnect ? (
                            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-700">
                              The Slack app will be disconnected on save — Gera forgets its signing
                              secret and bot token (the app itself stays at api.slack.com/apps).{" "}
                              <button
                                type="button"
                                className="font-medium text-foreground underline underline-offset-2"
                                onClick={() => setDraft({ ...draft, slackDisconnect: false })}
                              >
                                Undo
                              </button>
                            </p>
                          ) : draft.slackApp ? (
                            <div className="rounded-xl border border-border/60 bg-background/70 p-3">
                              <div className="flex items-center justify-between gap-2">
                                <p className="flex items-center gap-1.5 text-xs font-semibold">
                                  <Wand2 className="h-3.5 w-3.5 text-muted-foreground" />
                                  Slack app created from Gera
                                </p>
                                <a
                                  href={`https://api.slack.com/apps/${draft.slackApp.appId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                >
                                  {draft.slackApp.appId}
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </div>
                              {draft.stored.slack ? (
                                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-emerald-700">
                                  <Check className="h-3.5 w-3.5" />
                                  Installed to {draft.slackApp.team || "your workspace"} — bot token
                                  stored server-side.
                                </p>
                              ) : (
                                <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-700">
                                  Not installed yet — one click below adds the bot to your workspace.
                                </p>
                              )}
                              <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
                                <Button
                                  type="button"
                                  onClick={() => void openSlackInstall()}
                                  className="h-8 gap-1.5 rounded-full bg-ember px-3 text-xs text-ember-foreground hover:bg-ember/90"
                                >
                                  <Slack className="h-3.5 w-3.5" />
                                  {draft.stored.slack ? "Reinstall" : "Install to Slack"}
                                </Button>
                                <button
                                  type="button"
                                  className="text-[11px] font-medium text-destructive underline underline-offset-2"
                                  onClick={() => setDraft({ ...draft, slackDisconnect: true })}
                                >
                                  Disconnect
                                </button>
                              </div>
                              {slackInstall?.waiting ? (
                                <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  Waiting for the install to finish in the Slack tab — this updates by
                                  itself.
                                </p>
                              ) : null}
                              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                                Scopes, the events endpoint and the signing secret were configured
                                automatically. /invite the bot to a channel and @mention it — replies
                                land in the same thread.
                              </p>
                            </div>
                          ) : (
                            <div className="rounded-xl border border-ember/50 bg-ember/[0.05] p-3">
                              <div className="flex items-center justify-between gap-2">
                                <p className="flex items-center gap-1.5 text-xs font-semibold">
                                  <Wand2 className="h-3.5 w-3.5 text-ember" />
                                  Create the Slack bot from Gera
                                </p>
                                <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                  ~1 minute
                                </span>
                              </div>
                              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                                Gera creates the Slack app itself — name, permissions, events
                                endpoint and signing secret are configured automatically — then one
                                click installs the bot to your workspace.
                              </p>
                              {!draft.id ? (
                                <SaveAgentFirstNote
                                  detail="the bot's endpoint URL is built from that id"
                                  saving={saving}
                                  nameMissing={draft.name.trim().length === 0}
                                  onSave={() => void save({ stay: true })}
                                  className="mt-2"
                                />
                              ) : slackConfig ? (
                                <div className="mt-2 space-y-2">
                                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-emerald-700">
                                    <Check className="h-3.5 w-3.5" />
                                    Slack app management connected
                                    {slackConfig.team ? ` (${slackConfig.team})` : ""} —{" "}
                                    {slackConfig.renews
                                      ? "renews automatically."
                                      : "expires within 12 h; reconnect with the refresh token to keep it alive."}
                                  </p>
                                  <div className="flex flex-wrap items-center gap-2.5">
                                    <Button
                                      type="button"
                                      onClick={() => void createSlackBot()}
                                      disabled={slackCreating}
                                      className="h-9 shrink-0 gap-1.5 rounded-lg bg-ember px-3 text-xs text-ember-foreground hover:bg-ember/90"
                                    >
                                      {slackCreating ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        "Create Slack app"
                                      )}
                                    </Button>
                                    <button
                                      type="button"
                                      className="text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                      onClick={() => void disconnectSlackManager()}
                                      disabled={slackManagerBusy}
                                    >
                                      {slackManagerBusy ? "Disconnecting…" : "Disconnect manager"}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="mt-2 space-y-2">
                                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                                    One-time connect:{" "}
                                    <a
                                      href="https://api.slack.com/apps"
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2"
                                    >
                                      api.slack.com/apps
                                      <ExternalLink className="h-3 w-3" />
                                    </a>{" "}
                                    → “Your App Configuration Tokens” → Generate → copy the{" "}
                                    <span className="font-medium text-foreground">Refresh Token</span>{" "}
                                    (xoxe-1-…). Gera keeps it server-side and renews it
                                    automatically — every agent's bot is one click from then on.
                                  </p>
                                  <div className="flex items-center gap-1.5">
                                    <Input
                                      type="password"
                                      autoComplete="off"
                                      value={slackConfigToken}
                                      onChange={(event) => setSlackConfigToken(event.target.value)}
                                      placeholder="xoxe-1-… refresh token"
                                      className="h-9 rounded-lg font-mono text-xs"
                                    />
                                    <Button
                                      type="button"
                                      onClick={() => void createSlackBot()}
                                      disabled={slackCreating || slackConfigToken.trim().length === 0}
                                      className="h-9 shrink-0 gap-1.5 rounded-lg bg-ember px-3 text-xs text-ember-foreground hover:bg-ember/90"
                                    >
                                      {slackCreating ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        "Connect & create"
                                      )}
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {!draft.slackApp || draft.slackDisconnect ? (
                            <div>
                              <button
                                type="button"
                                onClick={() => setSlackManualOpen(!slackManualOpen)}
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                              >
                                <ChevronRight
                                  className={cn(
                                    "h-3 w-3 transition-transform",
                                    slackManualOpen && "rotate-90",
                                  )}
                                />
                                I already have a Slack app — paste its tokens
                              </button>
                              {slackManualOpen ? (
                                <div className="mt-2 space-y-2.5">
                          <TokenField
                            label="Bot token"
                            placeholder="xoxb-…"
                            stored={draft.stored.slack}
                            draft={draft.slackToken}
                            onChange={(token) => setDraft({ ...draft, slackToken: token })}
                            helpUrl="https://api.slack.com/apps"
                            helpLabel="Slack apps"
                            note="Your app → OAuth & Permissions → Bot User OAuth Token. Posts as the app's bot."
                          />

                          <div className="rounded-xl border border-border/60 bg-background/70 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="flex items-center gap-1.5 text-xs font-semibold">
                                <AtSign className="h-3.5 w-3.5 text-muted-foreground" />
                                Mentionable bot in Slack
                              </p>
                              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                Optional
                              </span>
                            </div>
                            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                              Teammates @mention this agent right in Slack and it replies in the
                              thread — with the same scoped access. Needs the bot token above plus
                              your Slack app's Signing secret.
                            </p>

                            {draft.slackSigningSecret.clear ? (
                              <p className="mt-2 text-xs text-muted-foreground">
                                Signing secret will be removed on save.{" "}
                                <button
                                  type="button"
                                  className="font-medium text-foreground underline underline-offset-2"
                                  onClick={() =>
                                    setDraft({
                                      ...draft,
                                      slackSigningSecret: { value: "", clear: false },
                                    })
                                  }
                                >
                                  Undo
                                </button>
                              </p>
                            ) : (
                              <div className="mt-2 space-y-2">
                                {!draft.slackSigningSecret.value && draft.stored.slackSigning ? (
                                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-emerald-700">
                                    <Check className="h-3.5 w-3.5" />
                                    Signing secret saved server-side.
                                    <button
                                      type="button"
                                      className="font-medium text-destructive underline underline-offset-2"
                                      onClick={() =>
                                        setDraft({
                                          ...draft,
                                          slackSigningSecret: { value: "", clear: true },
                                        })
                                      }
                                    >
                                      Remove
                                    </button>
                                  </p>
                                ) : null}
                                <Input
                                  type="password"
                                  autoComplete="off"
                                  value={draft.slackSigningSecret.value}
                                  onChange={(event) =>
                                    setDraft({
                                      ...draft,
                                      slackSigningSecret: {
                                        value: event.target.value,
                                        clear: false,
                                      },
                                    })
                                  }
                                  placeholder={
                                    draft.stored.slackSigning
                                      ? "Replace signing secret"
                                      : "Signing secret — app's Basic Information page"
                                  }
                                  className="h-9 rounded-lg font-mono text-xs"
                                />
                              </div>
                            )}

                            {draft.id ? (
                              <div className="mt-2.5">
                                <p className="text-[11px] font-medium text-muted-foreground">
                                  Request URL for Event Subscriptions
                                </p>
                                <div className="mt-1 flex items-center gap-1.5">
                                  <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-foreground/[0.03] px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                                    {slackEventsUrl(projectId, draft.id)}
                                  </code>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="h-8 shrink-0 gap-1 rounded-lg px-2.5 text-[11px]"
                                    onClick={() =>
                                      void copyEventsUrl(slackEventsUrl(projectId, draft.id ?? ""))
                                    }
                                  >
                                    <Copy className="h-3 w-3" />
                                    Copy
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <SaveAgentFirstNote
                                detail="the Request URL is built from that id"
                                saving={saving}
                                nameMissing={draft.name.trim().length === 0}
                                onSave={() => void save({ stay: true })}
                                className="mt-2.5"
                              />
                            )}

                            <ol className="mt-2.5 list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
                              <li>
                                Slack app → Basic Information → copy the Signing secret, paste it
                                above and save the agent.
                              </li>
                              <li>
                                Event Subscriptions → enable, paste the Request URL — Slack
                                verifies it instantly.
                              </li>
                              <li>
                                Subscribe to the <code className="font-mono">app_mention</code> bot
                                event; scopes: <code className="font-mono">app_mentions:read</code>{" "}
                                + <code className="font-mono">chat:write</code> (
                                <code className="font-mono">channels:history</code> lets it read
                                the thread).
                              </li>
                              <li>Reinstall the app, /invite the bot to a channel, @mention it.</li>
                            </ol>
                          </div>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </AccessRow>

                    <AccessRow
                      icon={Plug}
                      iconClassName="bg-emerald-500/10 text-emerald-600"
                      title="MCP servers"
                      description="Tools from your connected MCP servers — the same list chat uses."
                      checked={draft.mcp}
                      onCheckedChange={(checked) => setDraft({ ...draft, mcp: checked })}
                    >
                      {draft.mcp ? (
                        <McpServerPicker
                          selection={draft.mcpSelection}
                          savedOwner={draft.mcpOwner}
                          writes={draft.mcpWrites}
                          onChange={(next) => setDraft({ ...draft, mcpSelection: next })}
                          onWritesChange={(next) => setDraft({ ...draft, mcpWrites: next })}
                        />
                      ) : null}
                    </AccessRow>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  {draft.id ? (
                    <Button
                      variant="ghost"
                      onClick={() => void remove()}
                      className="h-9 gap-1.5 rounded-full px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  ) : (
                    <span />
                  )}
                  <div className="flex gap-2">
                    <Button variant="ghost" className="h-9 rounded-full px-4" onClick={() => setDraft(null)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={() => void save()}
                      disabled={saving || draft.name.trim().length === 0}
                      className="h-9 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
                    >
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save agent"}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <GitHubSignInDialog
        open={githubSignInOpen}
        onOpenChange={setGithubSignInOpen}
        onSignedIn={handleGithubSignedIn}
      />

      <Dialog open={viewing !== null} onOpenChange={(open) => (!open ? setViewing(null) : undefined)}>
        <DialogContent className="rounded-3xl sm:max-w-md">
          {viewing ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-ember/10 text-lg">
                    {viewing.emoji || <Bot className="h-5 w-5 text-ember" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{viewing.name}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      @{viewing.handle}
                    </span>
                  </span>
                </DialogTitle>
                <DialogDescription>
                  Set up by the project admins — you can put it to work; only admins can change it.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {accessSummary(viewing).map((chip) => (
                    <span
                      key={chip}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                        chip.endsWith("no token") || chip.endsWith("no servers")
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
                          : "border-border/70 bg-foreground/[0.03] text-muted-foreground",
                      )}
                    >
                      {chip}
                    </span>
                  ))}
                </div>
                <div className="rounded-2xl border border-border/70 px-3.5 py-2.5">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Model
                  </p>
                  <p className="mt-0.5 text-sm font-medium">{agentModelLabel(viewing.model)}</p>
                </div>
                {viewing.instructions ? (
                  <div className="rounded-2xl border border-border/70 px-3.5 py-2.5">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Role instructions
                    </p>
                    <p className="mt-1 max-h-44 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
                      {viewing.instructions}
                    </p>
                  </div>
                ) : null}
                <Button
                  onClick={() => void copyHandle(viewing.handle)}
                  className="h-9 w-full gap-1.5 rounded-full bg-ember text-ember-foreground hover:bg-ember/90"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy @{viewing.handle}
                </Button>
                <p className="text-center text-[11px] text-muted-foreground">
                  Paste it in any channel — the agent replies in the thread.
                </p>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <p className="mb-1.5 text-xs font-medium text-muted-foreground">{children}</p>;
}

/** One integration row: icon tile + name + description + switch, extras below. */
function AccessRow({
  icon: Icon,
  iconClassName,
  title,
  description,
  checked,
  onCheckedChange,
  children,
}: {
  icon: LucideIcon;
  iconClassName: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
            iconClassName,
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs leading-snug text-muted-foreground">{description}</span>
        </span>
        <Switch checked={checked} onCheckedChange={onCheckedChange} />
      </div>
      {children ? <div className="mt-3 sm:pl-12">{children}</div> : null}
    </div>
  );
}

/** GitHub permission level as a tappable card — clearer than a bare pill. */
function LevelOption({
  selected,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "rounded-xl border p-2.5 text-left transition-colors",
        selected
          ? "border-ember/60 bg-ember/[0.07]"
          : "border-border/70 bg-background/40 hover:border-foreground/25",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            selected ? "bg-ember" : "border border-muted-foreground/50",
          )}
        />
        {title}
      </span>
      <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{description}</span>
    </button>
  );
}

/**
 * Amber note for the Slack section while the agent was never saved: the id
 * (minted on first save) is part of the bot's URLs, so the steps that need it
 * stay locked. The inline button saves the draft in place — the editor stays
 * open and the setup continues right here.
 */
function SaveAgentFirstNote({
  detail,
  saving,
  nameMissing,
  onSave,
  className,
}: {
  detail: string;
  saving: boolean;
  nameMissing: boolean;
  onSave: () => void;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2", className)}>
      <p className="text-[11px] font-medium leading-relaxed text-amber-700">
        You're creating this agent right now — it gets its id on first save, and {detail}. Save it
        here to unlock this step; the editor stays open.
      </p>
      <Button
        type="button"
        onClick={onSave}
        disabled={saving || nameMissing}
        className="mt-1.5 h-7 rounded-full bg-amber-600 px-3 text-[11px] font-semibold text-white hover:bg-amber-600/90"
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save agent now"}
      </Button>
      {nameMissing ? (
        <p className="mt-1 text-[11px] text-amber-700/80">Give the agent a name at the top first.</p>
      ) : null}
    </div>
  );
}

/**
 * The same server list chat and automations use — the admin picks which of
 * their connected MCP servers ride with the agent (capped at
 * MAX_AGENT_MCP_SERVERS). Runs resolve the selection through the admin's
 * account server-side (keys and sign-ins stay there, refreshed like cloud
 * automations), so there is nothing to paste.
 */
function McpServerPicker({
  selection,
  savedOwner,
  writes,
  onChange,
  onWritesChange,
}: {
  selection: AgentMcpServer[];
  savedOwner: string;
  writes: AgentMcpWrites;
  onChange: (next: AgentMcpServer[]) => void;
  onWritesChange: (next: AgentMcpWrites) => void;
}) {
  const { state } = useAgent();
  const { user } = useAuth();
  const myEmail = user?.email ?? "";
  /** Servers whose tool allowlist editor is expanded. */
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const setTools = (serverId: string, tools: string[] | undefined) => {
    onChange(
      selection.map((ref) => {
        if (ref.id !== serverId) {
          return ref;
        }
        const next: AgentMcpServer = { id: ref.id, name: ref.name };
        return tools ? { ...next, tools } : next;
      }),
    );
  };
  // Native GitHub/Slack/Intercom connectors have dedicated agent rows above.
  const connected = state.settings.mcpServers.filter(
    (server) => !findCatalogEntry(server.catalogId ?? server.id)?.native,
  );
  const connectedIds = new Set(connected.map((server) => server.id));
  // Saved refs (possibly linked by another admin) whose servers are not in
  // this browser's list — shown removable instead of silently hidden.
  const savedOnly = selection.filter((ref) => !connectedIds.has(ref.id));
  const full = selection.length >= MAX_AGENT_MCP_SERVERS;
  const relinks = savedOwner !== "" && myEmail !== "" && savedOwner !== myEmail;
  const toggle = (ref: AgentMcpServer, checked: boolean) => {
    if (checked) {
      if (!full && !selection.some((entry) => entry.id === ref.id)) {
        onChange([...selection, ref]);
      }
    } else {
      onChange(selection.filter((entry) => entry.id !== ref.id));
    }
  };
  if (connected.length === 0 && savedOnly.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-background/60 px-2.5 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        No connected MCP servers yet — set them up once on the{" "}
        <Link to="/mcp" className="font-medium text-foreground underline underline-offset-2">
          MCP page
        </Link>{" "}
        (the same list your chat uses) and they appear here with per-agent toggles.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {relinks ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-700">
          Linked through {savedOwner}'s account — saving re-links the selection to yours.
        </p>
      ) : null}
      {connected.map((server) => {
        const ref = selection.find((entry) => entry.id === server.id);
        const picked = ref !== undefined;
        const needsAuth = cloudMcpReadiness(server) === "needs-auth";
        const allowlisted = ref?.tools;
        const toolsLabel =
          server.tools.length === 0
            ? "not connected yet"
            : allowlisted
              ? `${allowlisted.length} of ${server.tools.length} tools allowed`
              : `${server.tools.length} tools · all allowed`;
        return (
          <div key={server.id} className="rounded-xl border border-border/70 bg-background/70">
            <label className="flex items-center justify-between gap-3 px-2.5 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <ServerFavicon server={server} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm">{server.name}</span>
                    {needsAuth ? (
                      <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-700">
                        connect first
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">{toolsLabel}</span>
                </span>
              </span>
              <Switch
                checked={picked}
                disabled={!picked && full}
                onCheckedChange={(checked) => toggle({ id: server.id, name: server.name }, checked)}
                aria-label={`Link ${server.name}`}
              />
            </label>
            {picked && server.tools.length > 0 ? (
              <div className="border-t border-border/60 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={() => setOpenTools((prev) => ({ ...prev, [server.id]: !prev[server.id] }))}
                  className="flex w-full items-center gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
                  aria-expanded={openTools[server.id] === true}
                >
                  <ChevronRight
                    className={cn("h-3 w-3 transition-transform", openTools[server.id] ? "rotate-90" : "")}
                  />
                  {allowlisted ? "Tool allowlist" : "Limit tools"}
                </button>
                {openTools[server.id] ? (
                  <McpToolAllowlist
                    tools={server.tools}
                    allowed={allowlisted}
                    onChange={(next) => setTools(server.id, next)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {savedOnly.map((ref) => (
        <label
          key={ref.id}
          className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 px-2.5 py-2"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm">{ref.name}</span>
            <span className="block text-[11px] text-muted-foreground">
              saved link — not among your connected servers
            </span>
          </span>
          <Switch checked onCheckedChange={() => toggle(ref, false)} aria-label={`Unlink ${ref.name}`} />
        </label>
      ))}
      {selection.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-background/70 px-2.5 py-2">
          <span className="min-w-0">
            <span className="block text-sm">Write tools</span>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">
              {writes === "ask"
                ? "Agents run unattended, so tools that change data (anything not marked read-only) are declined with an honest note in the reply; read-only tools run. Decisions land in your Diagnostics."
                : "Every allowed tool runs, including ones that change data."}
            </span>
          </span>
          <div
            role="radiogroup"
            aria-label="Write tools"
            data-testid={TID.agentMcpWrites}
            className="inline-flex shrink-0 rounded-full border border-border bg-background p-0.5"
          >
            {(
              [
                { value: "auto", label: "Auto-run" },
                { value: "ask", label: "Ask before running" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={writes === option.value}
                onClick={() => onWritesChange(option.value)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] transition-colors",
                  writes === option.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {selection.length}/{MAX_AGENT_MCP_SERVERS} linked. Runs resolve these through your account —
        keys and sign-ins stay there (synced and refreshed like cloud automations) and never reach
        members. Missing a server? Add it on the{" "}
        <Link to="/mcp" className="font-medium text-foreground underline underline-offset-2">
          MCP page
        </Link>{" "}
        — GitHub, Slack and Intercom aren't listed here because they have their own rows above.
      </p>
    </div>
  );
}

/**
 * Per-server tool allowlist: every tool the last check listed, with a switch
 * each. "All tools" (no allowlist) is the default; the first uncheck turns the
 * list into an explicit allowlist so tools the server adds later stay out
 * until an admin allows them.
 */
function McpToolAllowlist({
  tools,
  allowed,
  onChange,
}: {
  tools: McpToolInfo[];
  allowed: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const allowedSet = allowed ? new Set(allowed) : null;
  const isAllowed = (name: string) => allowedSet === null || allowedSet.has(name);
  const toggleTool = (name: string, checked: boolean) => {
    const current = allowedSet ? [...allowedSet] : tools.map((tool) => tool.name);
    const next = checked ? [...current.filter((item) => item !== name), name] : current.filter((item) => item !== name);
    // Keep catalog order so the saved list reads like the server's table.
    const ordered = tools.map((tool) => tool.name).filter((item) => next.includes(item));
    onChange(ordered);
  };
  const riskOf = (tool: McpToolInfo): "read" | "write" | "destructive" =>
    tool.annotations?.readOnlyHint === true ? "read" : tool.annotations?.destructiveHint === true ? "destructive" : "write";
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{allowedSet ? `${allowedSet.size} of ${tools.length} allowed` : "All tools allowed"}</span>
        <span className="flex gap-2">
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onChange(undefined)}>
            Allow all
          </button>
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => onChange(tools.filter((tool) => riskOf(tool) === "read").map((tool) => tool.name))}
          >
            Read-only only
          </button>
        </span>
      </div>
      <div className="max-h-56 space-y-0.5 overflow-auto pr-0.5">
        {tools.map((tool) => {
          const risk = riskOf(tool);
          return (
            <label key={tool.name} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 hover:bg-foreground/[0.03]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-[11px]">{tool.name}</span>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-1.5 py-px text-[10px]",
                    risk === "read"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                      : risk === "destructive"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                  )}
                >
                  {risk === "read" ? "read-only" : risk === "destructive" ? "destructive" : "writes"}
                </span>
              </span>
              <Switch
                checked={isAllowed(tool.name)}
                onCheckedChange={(checked) => toggleTool(tool.name, checked)}
                aria-label={`Allow ${tool.name}`}
                className="scale-90"
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Tiny brand favicon for MCP picker rows; falls back to a plug glyph. */
function ServerFavicon({ server }: { server: McpServerConfig }) {
  const [failed, setFailed] = useState<boolean>(false);
  const src = serverIconUrl(server);
  if (!src || failed) {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-foreground/[0.04]">
        <Plug className="h-3 w-3 text-muted-foreground" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-6 w-6 shrink-0 rounded-md border border-border/60 bg-white object-contain p-0.5"
    />
  );
}

/** Paste-a-token credential card with a "where to get it" link and honest state. */
function TokenField({
  label,
  placeholder,
  stored,
  draft,
  onChange,
  helpUrl,
  helpLabel,
  note,
}: {
  label: string;
  placeholder: string;
  stored: boolean;
  draft: TokenDraft;
  onChange: (token: TokenDraft) => void;
  helpUrl: string;
  helpLabel: string;
  note: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          {label}
        </p>
        <a
          href={helpUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {helpLabel}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <Input
        type="password"
        autoComplete="off"
        value={draft.value}
        disabled={draft.clear}
        onChange={(event) => onChange({ ...draft, value: event.target.value })}
        placeholder={stored ? "Token stored — leave blank to keep, type to replace" : placeholder}
        className="mt-2 h-9 rounded-lg text-sm"
      />
      {stored ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {draft.clear ? (
            <>
              Token will be removed on save.
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => onChange({ ...draft, clear: false })}
              >
                Undo
              </button>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                <Check className="h-3.5 w-3.5" />
                Token saved server-side.
              </span>
              <button
                type="button"
                className="font-medium text-destructive underline underline-offset-2"
                onClick={() => onChange({ value: "", clear: true })}
              >
                Remove
              </button>
            </>
          )}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {note} Stored server-side — members never see it; without a token the agent honestly says it
        has no credential.
      </p>
    </div>
  );
}
