// One project's workspace: Slack-style channels with threads, the scoped
// agent roster, and member management. Polls the shard while open — the
// overview every 5s (unread badges), the active channel every 4s.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Hash,
  Loader2,
  MonitorDot,
  MoreHorizontal,
  Plus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { AgentsPanel } from "@/components/gera/projects/AgentsPanel";
import { ChannelChat } from "@/components/gera/projects/ChannelChat";
import { MembersPanel } from "@/components/gera/projects/MembersPanel";
import { ScreensPanel } from "@/components/gera/projects/ScreensPanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  createProjectChannel,
  deleteProject,
  fetchProjectOverview,
  renameProject,
} from "@/lib/projects";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

type SpaceTab = "channels" | "screens" | "agents" | "members";

export default function ProjectSpacePage() {
  const {
    projectId = "",
    channelId: channelParam,
    tab: tabParam,
  } = useParams<{ projectId: string; channelId?: string; tab?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The URL owns the workspace state: /projects/:id/channels/:channelId for
  // channels, /projects/:id/{screens|agents|members} for the other tabs.
  const tab: SpaceTab =
    channelParam !== undefined
      ? "channels"
      : tabParam === "screens" || tabParam === "agents" || tabParam === "members"
        ? tabParam
        : "channels";
  const channelId = channelParam ?? null;
  /** Last visited channel — restored when returning to the Channels tab. */
  const lastChannelRef = useRef<string | null>(null);
  useEffect(() => {
    if (channelParam) {
      lastChannelRef.current = channelParam;
    }
  }, [channelParam]);

  const openChannel = useCallback(
    (id: string, replace = false) => {
      navigate(`/projects/${projectId}/channels/${id}`, { replace });
    },
    [navigate, projectId],
  );

  const openTab = (next: SpaceTab) => {
    if (next === tab) {
      return;
    }
    if (next === "channels") {
      const remembered = lastChannelRef.current;
      navigate(
        remembered ? `/projects/${projectId}/channels/${remembered}` : `/projects/${projectId}`,
      );
    } else {
      navigate(`/projects/${projectId}/${next}`);
    }
  };

  const [channelDialog, setChannelDialog] = useState<boolean>(false);
  const [channelName, setChannelName] = useState<string>("");
  const [channelTopic, setChannelTopic] = useState<string>("");
  const [renameDialog, setRenameDialog] = useState<boolean>(false);
  const [renameDraft, setRenameDraft] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const overviewQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProjectOverview(projectId),
    enabled: projectId.length > 0,
    refetchInterval: 5_000,
  });
  const overview = overviewQuery.data;
  const canManage = overview ? overview.me.role === "owner" || overview.me.role === "admin" : false;

  // Keep a valid channel address as channels appear/disappear — the bare
  // project URL silently normalizes to the first channel's address.
  useEffect(() => {
    if (!overview || tab !== "channels") {
      return;
    }
    if (channelId && overview.channels.some((channel) => channel.id === channelId)) {
      return;
    }
    const first = overview.channels[0]?.id;
    if (first) {
      openChannel(first, true);
    } else if (channelId) {
      navigate(`/projects/${projectId}`, { replace: true });
    }
  }, [overview, channelId, tab, openChannel, navigate, projectId]);

  // Unread badge in the tab title while the space is open.
  const totalUnread = useMemo(
    () => (overview?.channels ?? []).reduce((sum, channel) => sum + channel.unread, 0),
    [overview],
  );
  const baseTitleRef = useRef<string>(document.title);
  useEffect(() => {
    const name = overview?.project.name ?? "Project";
    document.title = totalUnread > 0 ? `(${totalUnread}) ${name} — Gera` : `${name} — Gera`;
    const original = baseTitleRef.current;
    return () => {
      document.title = original;
    };
  }, [overview?.project.name, totalUnread]);

  const activeChannel = overview?.channels.find((channel) => channel.id === channelId) ?? null;

  const submitChannel = async () => {
    const name = channelName.trim();
    if (!name || busy) {
      return;
    }
    setBusy(true);
    try {
      const created = await createProjectChannel(projectId, name, channelTopic.trim());
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      openChannel(created.id);
      setChannelDialog(false);
      setChannelName("");
      setChannelTopic("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the channel");
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async () => {
    const name = renameDraft.trim();
    if (!name || busy) {
      return;
    }
    setBusy(true);
    try {
      await renameProject(projectId, name);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setRenameDialog(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename the project");
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async () => {
    if (!window.confirm("Delete this project for everyone? Channels, messages and agents are erased.")) {
      return;
    }
    try {
      await deleteProject(projectId);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/projects");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the project");
    }
  };

  if (overviewQuery.isLoading) {
    return (
      <div className="gera-atmosphere flex min-h-dvh items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening the project…
        </div>
      </div>
    );
  }

  if (overviewQuery.isError || !overview) {
    const message =
      overviewQuery.error instanceof Error ? overviewQuery.error.message : "Could not open the project";
    const friendly =
      message === "not_a_member"
        ? "You're not a member of this project. Ask an admin to add your email."
        : message === "project_not_found"
          ? "This project does not exist (or was deleted)."
          : message;
    return (
      <div className="gera-atmosphere flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{friendly}</p>
        <Button variant="outline" className="rounded-full" onClick={() => navigate("/projects")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to projects
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-background" data-testid={TID.projectSpace}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-background/70 px-3 backdrop-blur-xl sm:px-4">
        <button
          type="button"
          onClick={() => navigate("/projects")}
          aria-label="Back to projects"
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Projects</span>
        </button>
        <span className="h-4 w-px shrink-0 bg-border/80" aria-hidden />
        <h1 className="min-w-0 truncate text-[15px] font-semibold">{overview.project.name}</h1>
        <span className="hidden shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground sm:inline">
          {overview.me.role}
        </span>

        <nav className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-foreground/[0.04] p-0.5">
          <SpaceTabButton
            icon={Hash}
            label="Channels"
            active={tab === "channels"}
            onClick={() => openTab("channels")}
          />
          <SpaceTabButton
            icon={MonitorDot}
            label={`Screens${(overview.screens ?? []).length > 0 ? ` · ${(overview.screens ?? []).length}` : ""}`}
            active={tab === "screens"}
            onClick={() => openTab("screens")}
          />
          <SpaceTabButton
            icon={Bot}
            label={`Agents${overview.agents.length > 0 ? ` · ${overview.agents.length}` : ""}`}
            active={tab === "agents"}
            onClick={() => openTab("agents")}
          />
          <SpaceTabButton
            icon={Users}
            label={`Members · ${overview.members.length}`}
            active={tab === "members"}
            onClick={() => openTab("members")}
          />
        </nav>

        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Project settings"
                className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 rounded-2xl border-border/70 p-1.5">
              <DropdownMenuItem
                className="gap-2 rounded-xl"
                onSelect={() => {
                  setRenameDraft(overview.project.name);
                  setRenameDialog(true);
                }}
              >
                Rename project
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 rounded-xl" onSelect={() => setChannelDialog(true)}>
                New channel
              </DropdownMenuItem>
              {overview.me.role === "owner" ? (
                <>
                  <DropdownMenuSeparator className="bg-border/60" />
                  <DropdownMenuItem
                    className="gap-2 rounded-xl text-destructive focus:bg-destructive/10 focus:text-destructive"
                    onSelect={() => void removeProject()}
                  >
                    Delete project
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      {tab === "channels" ? (
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-60 shrink-0 flex-col border-r border-border/60 lg:flex">
            <div className="flex items-center justify-between px-4 pb-1 pt-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Channels
              </p>
              {canManage ? (
                <button
                  type="button"
                  aria-label="New channel"
                  onClick={() => setChannelDialog(true)}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {overview.channels.map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => openChannel(channel.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm transition-colors",
                    channel.id === channelId
                      ? "bg-foreground/[0.07] font-medium"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  )}
                >
                  <Hash className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  {channel.unread > 0 && channel.id !== channelId ? (
                    <span className="shrink-0 rounded-full bg-ember px-1.5 py-0.5 text-[10px] font-semibold leading-none text-ember-foreground">
                      {channel.unread > 99 ? "99+" : channel.unread}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            {overview.agents.length > 0 ? (
              <div className="border-t border-border/60 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Agents
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {overview.agents.map((agent) => (
                    <span key={agent.id} className="mr-1.5 inline-block">
                      <span className="font-medium text-foreground">@{agent.handle}</span>
                    </span>
                  ))}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/80">
                  Mention an agent in any channel — it replies in the thread.
                </p>
              </div>
            ) : null}
          </aside>

          {activeChannel ? (
            <ChannelChat
              key={activeChannel.id}
              projectId={projectId}
              channel={activeChannel}
              channels={overview.channels}
              onSelectChannel={openChannel}
              agents={overview.agents}
              meEmail={overview.me.email}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
              No channels yet.{canManage ? " Create the first one from the ··· menu." : ""}
            </div>
          )}
        </div>
      ) : tab === "screens" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
            <ScreensPanel
              projectId={projectId}
              screens={overview.screens ?? []}
              agents={overview.agents}
              channels={overview.channels}
              canManage={canManage}
            />
          </div>
        </div>
      ) : tab === "agents" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
            <AgentsPanel
              projectId={projectId}
              agents={overview.agents}
              canManage={canManage}
              slackConfig={overview.slackConfig ?? null}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
            <MembersPanel
              projectId={projectId}
              members={overview.members}
              meEmail={overview.me.email}
              myRole={overview.me.role}
            />
          </div>
        </div>
      )}

      <Dialog open={channelDialog} onOpenChange={setChannelDialog}>
        <DialogContent className="rounded-3xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
            <DialogDescription>A shared room inside this project, with threads.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitChannel();
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={channelName}
              onChange={(event) => setChannelName(event.target.value)}
              placeholder="Name — e.g. support"
              maxLength={40}
              className="h-10 rounded-xl"
            />
            <Input
              value={channelTopic}
              onChange={(event) => setChannelTopic(event.target.value)}
              placeholder="Topic (optional)"
              maxLength={140}
              className="h-10 rounded-xl"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                className="h-9 rounded-full px-4"
                onClick={() => setChannelDialog(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={channelName.trim().length === 0 || busy}
                className="h-9 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={renameDialog} onOpenChange={setRenameDialog}>
        <DialogContent className="rounded-3xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              maxLength={60}
              className="h-10 rounded-xl"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                className="h-9 rounded-full px-4"
                onClick={() => setRenameDialog(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={renameDraft.trim().length === 0 || busy}
                className="h-9 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
              >
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SpaceTabButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Hash;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 sm:text-[13px]",
        active ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", active && "text-ember")} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
