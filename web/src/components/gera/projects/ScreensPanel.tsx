// Screens — admin-composed widget desks: one job, one UI. The flagship recipe
// is a support desk: the team's real Intercom inbox in the middle, an AI
// reference agent floating over the desk as a live-chat bubble, and an escalation target that posts
// into a project channel. Admins compose screens; every member works in them.
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2, MonitorDot, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

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
import {
  deleteProjectScreen,
  upsertProjectScreen,
  type ProjectAgent,
  type ProjectChannel,
  type ProjectScreen,
  type ScreenWidgetDraft,
} from "@/lib/projects";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

type Draft = {
  id: string | null;
  name: string;
  emoji: string;
  inboxOn: boolean;
  inboxAgentId: string;
  assistantOn: boolean;
  assistantAgentId: string;
  channelOn: boolean;
  channelId: string;
};

function draftFromScreen(
  screen: ProjectScreen | null,
  agents: ProjectAgent[],
  channels: ProjectChannel[],
): Draft {
  const inbox = screen?.widgets.find((widget) => widget.kind === "intercom-inbox");
  const assistant = screen?.widgets.find((widget) => widget.kind === "agent-chat");
  const channel = screen?.widgets.find((widget) => widget.kind === "channel-post");
  const intercomAgents = agents.filter((agent) => agent.secretsSet.intercom);
  return {
    id: screen?.id ?? null,
    name: screen?.name ?? "",
    emoji: screen?.emoji ?? "🎧",
    inboxOn: Boolean(inbox),
    inboxAgentId: inbox?.agentId ?? intercomAgents[0]?.id ?? "",
    assistantOn: Boolean(assistant),
    assistantAgentId: assistant?.agentId ?? agents[0]?.id ?? "",
    channelOn: Boolean(channel),
    channelId: channel?.channelId ?? channels[0]?.id ?? "",
  };
}

/** Card chips: what each widget is wired to, with honest warnings. */
function widgetChips(
  screen: ProjectScreen,
  agents: ProjectAgent[],
  channels: ProjectChannel[],
): Array<{ label: string; warn: boolean }> {
  return screen.widgets.map((widget) => {
    if (widget.kind === "intercom-inbox") {
      const agent = agents.find((item) => item.id === widget.agentId);
      if (!agent) {
        return { label: "Intercom inbox · agent deleted", warn: true };
      }
      return agent.secretsSet.intercom
        ? { label: `Intercom inbox · @${agent.handle}`, warn: false }
        : { label: `Intercom inbox · @${agent.handle} · no token`, warn: true };
    }
    if (widget.kind === "agent-chat") {
      const agent = agents.find((item) => item.id === widget.agentId);
      return agent
        ? { label: `Assistant · @${agent.handle}`, warn: false }
        : { label: "Assistant · agent deleted", warn: true };
    }
    const channel = channels.find((item) => item.id === widget.channelId);
    return channel
      ? { label: `Post to #${channel.name}`, warn: false }
      : { label: "Post target · channel deleted", warn: true };
  });
}

export function ScreensPanel({
  projectId,
  screens,
  agents,
  channels,
  canManage,
}: {
  projectId: string;
  screens: ProjectScreen[];
  agents: ProjectAgent[];
  channels: ProjectChannel[];
  canManage: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [draft, setDraft] = useState<Draft>(() => draftFromScreen(null, agents, channels));
  const [busy, setBusy] = useState<boolean>(false);

  const intercomAgents = agents.filter((agent) => agent.secretsSet.intercom);

  const openEditor = (screen: ProjectScreen | null) => {
    setDraft(draftFromScreen(screen, agents, channels));
    setEditorOpen(true);
  };

  const save = async () => {
    const name = draft.name.trim();
    if (!name || busy) {
      return;
    }
    const widgets: ScreenWidgetDraft[] = [];
    if (draft.inboxOn && draft.inboxAgentId) {
      widgets.push({ kind: "intercom-inbox", agentId: draft.inboxAgentId });
    }
    if (draft.assistantOn && draft.assistantAgentId) {
      widgets.push({ kind: "agent-chat", agentId: draft.assistantAgentId });
    }
    if (draft.channelOn && draft.channelId) {
      widgets.push({ kind: "channel-post", channelId: draft.channelId });
    }
    if (widgets.length === 0) {
      toast.error("Switch on at least one widget");
      return;
    }
    setBusy(true);
    try {
      const saved = await upsertProjectScreen(projectId, {
        ...(draft.id ? { id: draft.id } : {}),
        name,
        emoji: draft.emoji.trim(),
        widgets,
      });
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      setEditorOpen(false);
      if (!draft.id) {
        navigate(`/projects/${projectId}/screens/${saved.id}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the screen");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.id || busy) {
      return;
    }
    if (!window.confirm("Delete this screen for everyone? Private assistant chats on it are erased.")) {
      return;
    }
    setBusy(true);
    try {
      await deleteProjectScreen(projectId, draft.id);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      setEditorOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the screen");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Screens</h2>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Focused desks composed from widgets — the team's real Intercom inbox with a details
            panel, an AI assistant floating like a live chat, a one-tap post into a channel. Admins
            compose them; everyone works in them.
          </p>
        </div>
        {canManage ? (
          <Button
            data-testid={TID.projectScreenCreate}
            onClick={() => openEditor(null)}
            className="h-9 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New screen
          </Button>
        ) : null}
      </div>

      {screens.length === 0 ? (
        <div className="mt-6 rounded-3xl border border-dashed border-border/80 px-6 py-10 text-center">
          <MonitorDot className="mx-auto h-6 w-6 text-muted-foreground/70" />
          <p className="mt-3 text-sm font-medium">No screens yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">
            {canManage
              ? "Compose the first one — e.g. a support desk: Intercom inbox with a details panel, a repo-savvy assistant floating like a live chat, escalation posting into #general."
              : "Admins haven't composed any screens yet. Once they do, your desks appear here."}
          </p>
        </div>
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {screens.map((screen) => {
            const chips = widgetChips(screen, agents, channels);
            return (
              <div
                key={screen.id}
                data-testid={TID.projectScreenCard}
                className="group relative rounded-3xl border border-border/70 bg-card p-4 shadow-sm transition-colors hover:border-foreground/25"
              >
                <button
                  type="button"
                  onClick={() => navigate(`/projects/${projectId}/screens/${screen.id}`)}
                  className="block w-full text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-foreground/[0.05] text-lg">
                      {screen.emoji || <MonitorDot className="h-5 w-5 text-ember" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{screen.name}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {screen.widgets.length}{" "}
                        {screen.widgets.length === 1 ? "widget" : "widgets"}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {chips.map((chip, index) => (
                      <span
                        key={index}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          chip.warn
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
                            : "border-border/70 bg-foreground/[0.03] text-muted-foreground",
                        )}
                      >
                        {chip.label}
                      </span>
                    ))}
                  </div>
                </button>
                {canManage ? (
                  <button
                    type="button"
                    aria-label={`Edit ${screen.name}`}
                    onClick={() => openEditor(screen)}
                    className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground/0 transition-colors hover:bg-foreground/5 hover:text-foreground group-hover:text-muted-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto rounded-3xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft.id ? "Edit screen" : "New screen"}</DialogTitle>
            <DialogDescription>
              Pick the widgets this desk is made of. Members open the screen and work — only
              admins can change its composition.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={draft.emoji}
                onChange={(event) => setDraft({ ...draft, emoji: event.target.value })}
                maxLength={4}
                aria-label="Emoji"
                className="h-10 w-16 rounded-xl text-center"
              />
              <Input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Screen name — e.g. Support desk"
                maxLength={60}
                className="h-10 flex-1 rounded-xl"
              />
            </div>

            <WidgetBlock
              title="Intercom inbox"
              description="The team's real inbox: open conversations, full threads, replies and internal notes. Uses the Intercom token stored on the agent you pick."
              on={draft.inboxOn}
              onToggle={(next) => setDraft({ ...draft, inboxOn: next })}
              disabled={intercomAgents.length === 0}
              disabledHint="No agent has an Intercom token yet — add one on the Agents tab first."
            >
              <WidgetSelect
                label="Credential from"
                value={draft.inboxAgentId}
                onChange={(value) => setDraft({ ...draft, inboxAgentId: value })}
                options={intercomAgents.map((agent) => ({
                  value: agent.id,
                  label: `${agent.emoji ? `${agent.emoji} ` : ""}@${agent.handle}`,
                }))}
              />
            </WidgetBlock>

            <WidgetBlock
              title="AI assistant"
              description="A project agent floating over the desk like a live-chat bubble — private chat per member. It can read the open conversation and answer with exactly the access it was granted (repo, web…)."
              on={draft.assistantOn}
              onToggle={(next) => setDraft({ ...draft, assistantOn: next })}
              disabled={agents.length === 0}
              disabledHint="No agents in this project yet — create one on the Agents tab first."
            >
              <WidgetSelect
                label="Agent"
                value={draft.assistantAgentId}
                onChange={(value) => setDraft({ ...draft, assistantAgentId: value })}
                options={agents.map((agent) => ({
                  value: agent.id,
                  label: `${agent.emoji ? `${agent.emoji} ` : ""}@${agent.handle} — ${agent.name}`,
                }))}
              />
            </WidgetBlock>

            <WidgetBlock
              title="Post to channel"
              description="Adds a third composer target next to Reply and Note — escalate a case into a project channel without leaving the screen."
              on={draft.channelOn}
              onToggle={(next) => setDraft({ ...draft, channelOn: next })}
              disabled={channels.length === 0}
              disabledHint="No channels in this project yet."
            >
              <WidgetSelect
                label="Channel"
                value={draft.channelId}
                onChange={(value) => setDraft({ ...draft, channelId: value })}
                options={channels.map((channel) => ({
                  value: channel.id,
                  label: `#${channel.name}`,
                }))}
              />
            </WidgetBlock>
          </div>

          <div className="mt-1 flex items-center justify-between gap-2">
            {draft.id ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void remove()}
                className="h-9 rounded-full px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                className="h-9 rounded-full px-4"
                onClick={() => setEditorOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={draft.name.trim().length === 0 || busy}
                onClick={() => void save()}
                className="h-9 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : draft.id ? "Save" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function WidgetBlock({
  title,
  description,
  on,
  onToggle,
  disabled = false,
  disabledHint,
  children,
}: {
  title: string;
  description: string;
  on: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
  disabledHint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-3 transition-colors",
        on ? "border-foreground/20 bg-foreground/[0.02]" : "border-border/70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <Switch checked={on && !disabled} onCheckedChange={onToggle} disabled={disabled} />
      </div>
      {disabled && disabledHint ? (
        <p className="mt-2 text-xs font-medium text-amber-700">{disabledHint}</p>
      ) : null}
      {on && !disabled ? <div className="mt-2.5">{children}</div> : null}
    </div>
  );
}

function WidgetSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-xl border border-border/70 bg-card px-2.5 text-sm outline-none focus:border-foreground/30"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
