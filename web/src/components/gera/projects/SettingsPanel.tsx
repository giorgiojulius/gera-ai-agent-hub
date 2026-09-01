// Project settings — a real screen instead of a hidden "···" menu: rename,
// channels, the project-level Slack app manager, and the danger zone. Slack
// bot creation for a specific agent still lives in the agent editor; this is
// the workspace-level connection it relies on.
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ExternalLink,
  Hash,
  Loader2,
  Plus,
  Slack,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createProjectChannel,
  deleteProject,
  renameProject,
  saveProjectSlackConfig,
  type ProjectChannel,
  type ProjectRole,
  type ProjectSlackConfig,
} from "@/lib/projects";
import { TID } from "@/lib/testids";

export function SettingsPanel({
  projectId,
  projectName,
  channels,
  slackConfig,
  myRole,
}: {
  projectId: string;
  projectName: string;
  channels: ProjectChannel[];
  slackConfig: ProjectSlackConfig | null;
  myRole: ProjectRole;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canManage = myRole === "owner" || myRole === "admin";
  const isOwner = myRole === "owner";

  const [nameDraft, setNameDraft] = useState<string>(projectName);
  const [savingName, setSavingName] = useState<boolean>(false);
  const [channelName, setChannelName] = useState<string>("");
  const [channelTopic, setChannelTopic] = useState<string>("");
  const [creatingChannel, setCreatingChannel] = useState<boolean>(false);
  const [slackToken, setSlackToken] = useState<string>("");
  const [slackBusy, setSlackBusy] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["project", projectId] });

  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name || name === projectName || savingName) {
      return;
    }
    setSavingName(true);
    try {
      await renameProject(projectId, name);
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project renamed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename the project");
    } finally {
      setSavingName(false);
    }
  };

  const createChannel = async () => {
    const name = channelName.trim();
    if (!name || creatingChannel) {
      return;
    }
    setCreatingChannel(true);
    try {
      const created = await createProjectChannel(projectId, name, channelTopic.trim());
      await refresh();
      setChannelName("");
      setChannelTopic("");
      navigate(`/projects/${projectId}/channels/${created.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the channel");
    } finally {
      setCreatingChannel(false);
    }
  };

  const connectSlack = async () => {
    const token = slackToken.trim();
    if (!token || slackBusy) {
      return;
    }
    setSlackBusy(true);
    try {
      await saveProjectSlackConfig(projectId, token);
      await refresh();
      setSlackToken("");
      toast.success("Slack app manager connected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not connect Slack");
    } finally {
      setSlackBusy(false);
    }
  };

  const disconnectSlack = async () => {
    if (slackBusy) {
      return;
    }
    setSlackBusy(true);
    try {
      await saveProjectSlackConfig(projectId, null);
      await refresh();
      toast.success("Slack app manager disconnected — created bots keep working");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect");
    } finally {
      setSlackBusy(false);
    }
  };

  const removeProject = async () => {
    if (
      deleting ||
      !window.confirm("Delete this project for everyone? Channels, messages and agents are erased.")
    ) {
      return;
    }
    setDeleting(true);
    try {
      await deleteProject(projectId);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/projects");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the project");
      setDeleting(false);
    }
  };

  return (
    <div data-testid={TID.projectSettings}>
      <h2 className="font-display text-2xl tracking-tight">Settings</h2>
      <p className="mt-1 max-w-lg text-sm leading-relaxed text-muted-foreground">
        {canManage
          ? "Name, channels and the project-level Slack connection. Agents and members have their own tabs."
          : "Only the owner and admins can change these settings — you can review them here."}
      </p>

      {/* General */}
      <section className="gera-card mt-6 rounded-3xl p-5 sm:p-6">
        <h3 className="text-[15px] font-semibold">General</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          The project name — visible to every member and in the tab title.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          <Input
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            maxLength={60}
            disabled={!canManage}
            className="h-10 w-full rounded-xl sm:w-72"
          />
          {canManage ? (
            <Button
              type="submit"
              disabled={
                nameDraft.trim().length === 0 || nameDraft.trim() === projectName || savingName
              }
              className="h-10 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
            >
              {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          ) : null}
        </form>
      </section>

      {/* Channels */}
      <section className="gera-card mt-4 rounded-3xl p-5 sm:p-6">
        <h3 className="text-[15px] font-semibold">Channels</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Shared rooms with threads. Everyone in the project sees every channel.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => navigate(`/projects/${projectId}/channels/${channel.id}`)}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-foreground/[0.03] px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <Hash className="h-3 w-3 opacity-60" />
              {channel.name}
            </button>
          ))}
          {channels.length === 0 ? (
            <p className="text-xs text-muted-foreground">No channels yet.</p>
          ) : null}
        </div>
        {canManage ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createChannel();
            }}
            className="mt-4 flex flex-wrap items-center gap-2"
          >
            <Input
              value={channelName}
              onChange={(event) => setChannelName(event.target.value)}
              placeholder="New channel — e.g. support"
              maxLength={40}
              className="h-10 w-full rounded-xl sm:w-56"
            />
            <Input
              value={channelTopic}
              onChange={(event) => setChannelTopic(event.target.value)}
              placeholder="Topic (optional)"
              maxLength={140}
              className="h-10 w-full rounded-xl sm:w-56"
            />
            <Button
              type="submit"
              disabled={channelName.trim().length === 0 || creatingChannel}
              className="h-10 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90"
            >
              {creatingChannel ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create
            </Button>
          </form>
        ) : null}
      </section>

      {/* Slack workspace */}
      <section className="gera-card mt-4 rounded-3xl p-5 sm:p-6">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          <Slack className="h-4 w-4 text-ember" />
          Slack app manager
        </h3>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
          One project-level connection lets Gera create a Slack bot for any agent in one click —
          the bot itself is wired in the agent's editor (Agents tab). Tokens stay server-side.
        </p>
        {slackConfig ? (
          <div className="mt-3 space-y-2">
            <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-emerald-700">
              <Check className="h-3.5 w-3.5" />
              Connected{slackConfig.team ? ` (${slackConfig.team})` : ""} —{" "}
              {slackConfig.renews
                ? "renews automatically."
                : "expires within 12 h; reconnect with a fresh refresh token to keep it alive."}
            </p>
            {canManage ? (
              <button
                type="button"
                onClick={() => void disconnectSlack()}
                disabled={slackBusy}
                className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {slackBusy ? "Disconnecting…" : "Disconnect manager (created bots keep working)"}
              </button>
            ) : null}
          </div>
        ) : canManage ? (
          <div className="mt-3 space-y-2">
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
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
              → "Your App Configuration Tokens" → Generate → copy the{" "}
              <span className="font-medium text-foreground">Refresh Token</span> (xoxe-1-…). Gera
              stores it server-side and rotates it automatically.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void connectSlack();
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <Input
                type="password"
                autoComplete="off"
                value={slackToken}
                onChange={(event) => setSlackToken(event.target.value)}
                placeholder="xoxe-1-… refresh token"
                className="h-10 w-full rounded-xl font-mono text-xs sm:w-72"
              />
              <Button
                type="submit"
                disabled={slackToken.trim().length === 0 || slackBusy}
                className="h-10 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
              >
                {slackBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
              </Button>
            </form>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">Not connected.</p>
        )}
      </section>

      {/* Danger zone */}
      {isOwner ? (
        <section className="mt-4 rounded-3xl border border-destructive/30 bg-destructive/[0.03] p-5 sm:p-6">
          <h3 className="text-[15px] font-semibold text-destructive">Danger zone</h3>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Deleting the project erases channels, messages, agents and screens for every member.
            This cannot be undone.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void removeProject()}
            disabled={deleting}
            className="mt-3 h-10 gap-1.5 rounded-full border-destructive/40 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete project
          </Button>
        </section>
      ) : null}
    </div>
  );
}
