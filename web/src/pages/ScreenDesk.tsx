// One screen's desk — the "one job, one UI" surface composed by admins:
// the team's real Intercom inbox (state filter defaults to Open, exactly like
// Intercom — so bot-per-session workspaces read as dialogs, not a message
// feed), a thread pane, an Intercom-style details panel (contact card,
// highlighted Subscription & payments, recent events, user data with
// clickable links, conversation meta collapsed at the bottom), a composer that
// switches between Reply / internal Note / posting into a Gera channel, and a
// private AI assistant floating over the desk like a live-chat messenger.
// Honest polling everywhere: inbox ~20s, thread ~8s, details ~30s, chat ~3.5s.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlarmClock,
  ArrowLeft,
  Bot,
  CalendarDays,
  ChartColumn,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  Clock,
  Copy,
  CreditCard,
  ExternalLink,
  Globe,
  GraduationCap,
  Hash,
  Inbox,
  Loader2,
  MessagesSquare,
  PanelRight,
  Paperclip,
  RefreshCw,
  SendHorizontal,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ExecutionOutcomeCard } from "@/components/gera/ExecutionOutcomeCard";
import { MarkdownBody } from "@/components/gera/Markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  actOnScreenConversation,
  askGeraFromScreen,
  clearDeskStats,
  deskTrackerSnippet,
  fetchDeskAskStatus,
  fetchDeskSlackRelated,
  fetchDeskStats,
  fetchProjectOverview,
  fetchScreenChat,
  fetchScreenConversationDetails,
  fetchScreenInbox,
  fetchScreenMentionAdmins,
  fetchScreenSuggestions,
  fetchScreenThread,
  formatAttachmentBytes,
  formatSpendCompact,
  linkDeskTeammate,
  postProjectMessage,
  rateScreenSuggestion,
  refreshDeskStats,
  sendScreenChatMessage,
  sendScreenIntercomReply,
  setupDeskTracking,
  type DeskConversationDetails,
  type DeskMentionAdmin,
  type DeskStats,
  type DeskStatsRange,
  type DeskTeammate,
  type IntercomAttr,
  type IntercomContactProfile,
  type IntercomInboxItem,
  type IntercomInboxState,
  type IntercomPart,
  type ProjectAgent,
} from "@/lib/projects";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

type ComposerTarget = "reply" | "note" | "channel";

const INBOX_FILTERS: Array<{ id: IntercomInboxState; label: string }> = [
  { id: "open", label: "Open" },
  { id: "snoozed", label: "Snoozed" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

function formatTime(at: number): string {
  if (at <= 0) {
    return "";
  }
  const date = new Date(at);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay) {
    return hm;
  }
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${hm}`;
}

/** Compact "10m / 3h / 2d" age for inbox rows. */
function ago(at: number): string {
  if (at <= 0) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) {
    return "now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function deskDateRange(fromDate: string, toDate: string): DeskStatsRange {
  const from = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : 0;
  const to = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : 0;
  return {
    from: Number.isFinite(from) ? from : 0,
    to: Number.isFinite(to) ? to : 0,
  };
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function performanceRangeLabel(range: DeskStatsRange): string {
  if (range.from === 0 && range.to === 0) {
    return "All collected time";
  }
  const format = (at: number): string =>
    new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (range.from > 0 && range.to > 0) {
    return `${format(range.from)} – ${format(range.to)}`;
  }
  return range.from > 0 ? `Since ${format(range.from)}` : `Through ${format(range.to)}`;
}

export default function ScreenDeskPage() {
  const { projectId = "", screenId = "" } = useParams<{ projectId: string; screenId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The open conversation and the performance panel live in the address
  // (?conversation=…&panel=performance) — shareable, and Back closes them.
  const [searchParams, setSearchParams] = useSearchParams();
  const conversationId = searchParams.get("conversation");
  const setConversationId = useCallback(
    (id: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) {
            next.set("conversation", id);
          } else {
            next.delete("conversation");
          }
          return next;
        },
        { replace: id === null },
      );
    },
    [setSearchParams],
  );
  const perfOpen = searchParams.get("panel") === "performance";
  const setPerfOpen = useCallback(
    (open: boolean) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (open) {
            next.set("panel", "performance");
          } else {
            next.delete("panel");
          }
          return next;
        },
        { replace: !open },
      );
    },
    [setSearchParams],
  );
  const [inboxState, setInboxState] = useState<IntercomInboxState>("open");
  const [assistantOpen, setAssistantOpen] = useState<boolean>(false);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const [target, setTarget] = useState<ComposerTarget>("reply");
  /** A picked suggestion loads into the composer; nonce forces re-apply. */
  const [seed, setSeed] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });

  const overviewQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProjectOverview(projectId),
    enabled: projectId.length > 0,
    refetchInterval: 15_000,
  });
  const overview = overviewQuery.data;
  const screen = (overview?.screens ?? []).find((item) => item.id === screenId) ?? null;
  const agents = useMemo(() => overview?.agents ?? [], [overview]);
  const channels = useMemo(() => overview?.channels ?? [], [overview]);

  const inboxWidget = screen?.widgets.find((widget) => widget.kind === "intercom-inbox") ?? null;
  const assistantWidget = screen?.widgets.find((widget) => widget.kind === "agent-chat") ?? null;
  const channelWidget = screen?.widgets.find((widget) => widget.kind === "channel-post") ?? null;
  const assistantAgent = assistantWidget
    ? agents.find((agent) => agent.id === assistantWidget.agentId) ?? null
    : null;
  const postChannel = channelWidget
    ? channels.find((channel) => channel.id === channelWidget.channelId) ?? null
    : null;

  const inboxQuery = useQuery({
    queryKey: ["screen-inbox", projectId, screenId, inboxState],
    enabled: Boolean(inboxWidget),
    refetchInterval: 20_000,
    retry: false,
    queryFn: () => fetchScreenInbox(projectId, screenId, inboxState),
  });
  const conversations = useMemo(() => inboxQuery.data ?? [], [inboxQuery.data]);
  /** First row without a spend tier — rows are server-ranked payers-first, so this is the section split. */
  const firstUnrankedIndex = useMemo(
    () => conversations.findIndex((item) => item.tier == null),
    [conversations],
  );
  const hasSpendSignal = conversations.length > 0 && firstUnrankedIndex !== 0;
  const selectedItem = conversations.find((item) => item.id === conversationId) ?? null;

  const threadQuery = useQuery({
    queryKey: ["screen-thread", projectId, screenId, conversationId ?? "none"],
    enabled: Boolean(inboxWidget) && conversationId !== null,
    refetchInterval: 8_000,
    retry: false,
    queryFn: () => fetchScreenThread(projectId, screenId, conversationId ?? ""),
  });

  // Teammate directory loads once the composer flips to Note — powers the @-mention picker.
  const mentionAdminsQuery = useQuery({
    queryKey: ["desk-mention-admins", projectId, screenId],
    enabled: Boolean(inboxWidget) && target === "note",
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => fetchScreenMentionAdmins(projectId, screenId),
  });

  // Keep the composer target valid as widgets/selection change.
  useEffect(() => {
    if (target === "channel" && !postChannel) {
      setTarget("reply");
    }
  }, [target, postChannel]);
  useEffect(() => {
    if (!inboxWidget && postChannel) {
      setTarget("channel");
    }
  }, [inboxWidget, postChannel]);
  // The small-screen details overlay is per conversation — close it on switch.
  useEffect(() => {
    setDetailsOpen(false);
  }, [conversationId]);

  const sendFromComposer = async (text: string, mentions: Array<{ id: string; name: string }>) => {
    if (target === "channel") {
      if (!postChannel) {
        return;
      }
      const prefix = selectedItem ? `> Intercom #${selectedItem.id} — ${selectedItem.author}\n\n` : "";
      await postProjectMessage(projectId, { channelId: postChannel.id, body: `${prefix}${text}` });
      toast.success(`Posted to #${postChannel.name}`);
      return;
    }
    if (!conversationId) {
      return;
    }
    await sendScreenIntercomReply(projectId, {
      screenId,
      conversationId,
      body: text,
      note: target === "note",
      ...(target === "note" && mentions.length > 0 ? { mentions } : {}),
    });
    await queryClient.invalidateQueries({
      queryKey: ["screen-thread", projectId, screenId, conversationId],
    });
    toast.success(target === "note" ? "Internal note added" : "Reply sent to the customer");
  };

  const threadParts = threadQuery.data?.parts ?? [];
  const lastPartId = threadParts.length > 0 ? threadParts[threadParts.length - 1].id : "";

  /** "Ask Gera" — fires the research run (deduped server-side per conversation). */
  const askGera = async (question: string) => {
    if (!assistantWidget) {
      return;
    }
    const result = await askGeraFromScreen(projectId, {
      screenId,
      widgetId: assistantWidget.id,
      question,
      ...(conversationId ? { conversationId } : {}),
    });
    await queryClient.invalidateQueries({ queryKey: ["desk-ask", projectId, screenId] });
    if (result.alreadyRunning) {
      toast.info("An investigation for this conversation is already running — the result lands right in the strip.");
      return;
    }
    setAssistantOpen(true);
    await queryClient.invalidateQueries({
      queryKey: ["screen-chat", projectId, screenId, assistantWidget.id],
    });
    toast.success("Gera is researching — the answer lands in the assistant chat");
  };

  const afterConversationAction = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["screen-thread", projectId, screenId] }),
      queryClient.invalidateQueries({ queryKey: ["screen-inbox", projectId, screenId] }),
    ]);
  };

  if (overviewQuery.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening the screen…
        </div>
      </div>
    );
  }

  if (overviewQuery.isError || !overview || !screen) {
    const raw = overviewQuery.error instanceof Error ? overviewQuery.error.message : "";
    const friendly = !overview
      ? raw === "not_a_member"
        ? "You're not a member of this project."
        : raw || "Could not open the project."
      : "This screen does not exist (or was deleted by an admin).";
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{friendly}</p>
        <Button
          variant="outline"
          className="rounded-full"
          onClick={() => navigate(`/projects/${projectId}`)}
        >
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to the project
        </Button>
      </div>
    );
  }

  const composerVisible = Boolean(inboxWidget) || Boolean(postChannel);

  return (
    <div className="flex h-dvh flex-col bg-background" data-testid={TID.screenDesk}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-background/70 px-3 backdrop-blur-xl sm:px-4">
        <button
          type="button"
          onClick={() => navigate(`/projects/${projectId}`)}
          aria-label="Back to the project"
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">{overview.project.name}</span>
        </button>
        <span className="h-4 w-px shrink-0 bg-border/80" aria-hidden />
        <span className="text-base leading-none" aria-hidden>
          {screen.emoji || "🖥️"}
        </span>
        <h1 className="min-w-0 truncate text-[15px] font-semibold">{screen.name}</h1>
        {postChannel ? (
          <span className="hidden shrink-0 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[10px] font-medium text-muted-foreground md:inline">
            escalates to #{postChannel.name}
          </span>
        ) : null}
        {inboxWidget ? (
          <button
            type="button"
            aria-label="Team performance"
            data-testid={TID.screenDeskPerformance}
            onClick={() => setPerfOpen(true)}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ChartColumn className="h-4 w-4" />
            <span className="hidden md:inline">Performance</span>
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        {inboxWidget ? (
          <aside
            className={cn(
              "w-full flex-col border-border/60 sm:flex sm:w-[300px] sm:shrink-0 sm:border-r",
              conversationId ? "hidden" : "flex",
            )}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3.5">
              <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                Inbox{conversations.length > 0 ? ` · ${conversations.length}` : ""}
              </p>
              <button
                type="button"
                aria-label="Refresh inbox"
                onClick={() => void inboxQuery.refetch()}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", inboxQuery.isFetching && "animate-spin")} />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
              {INBOX_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setInboxState(filter.id)}
                  aria-pressed={inboxState === filter.id}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    inboxState === filter.id
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {inboxQuery.isLoading ? (
                <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading the real inbox…
                </div>
              ) : inboxQuery.isError ? (
                <div className="m-1 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="text-xs font-medium leading-relaxed text-amber-800">
                    {inboxQuery.error instanceof Error
                      ? inboxQuery.error.message
                      : "Could not load the inbox."}
                  </p>
                  <button
                    type="button"
                    onClick={() => void inboxQuery.refetch()}
                    className="mt-2 rounded-full border border-amber-600/40 px-2.5 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-500/20"
                  >
                    Retry
                  </button>
                </div>
              ) : conversations.length === 0 ? (
                <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
                  {inboxState === "all"
                    ? "The inbox is clear — no conversations yet."
                    : `No ${inboxState} conversations — switch the filter above to see others.`}
                </p>
              ) : (
                conversations.map((item, index) => (
                  <Fragment key={item.id}>
                    {hasSpendSignal && index === 0 ? (
                      <InboxRankLabel tone="paying" label="Paying customers · biggest spend first" />
                    ) : null}
                    {hasSpendSignal && index === firstUnrankedIndex ? (
                      <InboxRankLabel tone="recency" label="Everyone else · newest first" />
                    ) : null}
                    <InboxRow
                      item={item}
                      active={item.id === conversationId}
                      onClick={() => setConversationId(item.id)}
                    />
                  </Fragment>
                ))
              )}
            </div>
            <p className="border-t border-border/60 px-3.5 py-2 text-[10px] text-muted-foreground/70">
              Live Intercom ·{" "}
              {hasSpendSignal
                ? "higher spenders first"
                : "no spend data on these contacts — newest first"}{" "}
              · updates ~20s
            </p>
          </aside>
        ) : null}

        <main
          className={cn(
            "min-w-0 flex-1 flex-col sm:flex",
            inboxWidget && !conversationId ? "hidden" : "flex",
          )}
        >
          {inboxWidget ? (
            conversationId ? (
              <>
                <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
                  <button
                    type="button"
                    aria-label="Back to inbox"
                    onClick={() => setConversationId(null)}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground sm:hidden"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <p className="min-w-0 truncate text-sm font-semibold">
                    {threadQuery.data?.author ?? selectedItem?.author ?? "Conversation"}
                  </p>
                  <TierBadge tier={selectedItem?.tier} spend={selectedItem?.spend} />
                  {threadQuery.data?.email || selectedItem?.email ? (
                    <p className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
                      {threadQuery.data?.email ?? selectedItem?.email}
                    </p>
                  ) : null}
                  <StatePill state={threadQuery.data?.state ?? selectedItem?.state ?? "open"} />
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70">
                    #{conversationId}
                  </span>
                  <button
                    type="button"
                    aria-label="Conversation details"
                    onClick={() => setDetailsOpen(true)}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground xl:hidden"
                  >
                    <PanelRight className="h-4 w-4" />
                  </button>
                </div>
                <ThreadPane
                  parts={threadParts}
                  loading={threadQuery.isLoading}
                  error={threadQuery.isError ? threadQuery.error : null}
                  onRetry={() => void threadQuery.refetch()}
                />
                {lastPartId ? (
                  <SuggestStrip
                    projectId={projectId}
                    screenId={screenId}
                    conversationId={conversationId}
                    lastPartId={lastPartId}
                    hasAssistant={Boolean(assistantWidget)}
                    onPick={(text) => {
                      setTarget("reply");
                      setSeed({ text, nonce: Date.now() });
                    }}
                    onAsk={askGera}
                    onActed={afterConversationAction}
                    onOpenAssistant={() => setAssistantOpen(true)}
                  />
                ) : null}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-8 text-center">
                <div>
                  <Inbox className="mx-auto h-6 w-6 text-muted-foreground/60" />
                  <p className="mt-3 text-sm font-medium">Pick a conversation</p>
                  <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                    Replies and notes go straight to Intercom as the connected admin.
                  </p>
                </div>
              </div>
            )
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center">
              <div>
                <Inbox className="mx-auto h-6 w-6 text-muted-foreground/60" />
                <p className="mt-3 text-sm font-medium">This screen has no inbox widget</p>
                <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                  {postChannel
                    ? `Use the composer below to post into #${postChannel.name}, or ask the assistant.`
                    : "An admin can add widgets to this screen on the Screens tab."}
                </p>
              </div>
            </div>
          )}

          {composerVisible ? (
            <DeskComposer
              target={target}
              onTarget={setTarget}
              hasInbox={Boolean(inboxWidget)}
              conversationSelected={conversationId !== null}
              channelName={postChannel?.name ?? null}
              contextLine={selectedItem ? `Intercom #${selectedItem.id} — ${selectedItem.author}` : null}
              seedText={seed.text}
              seedNonce={seed.nonce}
              mentionAdmins={mentionAdminsQuery.data ?? []}
              onSend={sendFromComposer}
            />
          ) : null}
        </main>

        {inboxWidget && conversationId ? (
          <DetailsPanel
            projectId={projectId}
            screenId={screenId}
            conversationId={conversationId}
            tier={selectedItem?.tier ?? null}
            spend={selectedItem?.spend ?? null}
            open={detailsOpen}
            onClose={() => setDetailsOpen(false)}
          />
        ) : null}
      </div>

      {perfOpen ? (
        <PerformancePanel projectId={projectId} screenId={screenId} onClose={() => setPerfOpen(false)} />
      ) : null}

      {assistantWidget ? (
        <AssistantOverlay
          projectId={projectId}
          screenId={screenId}
          widgetId={assistantWidget.id}
          agent={assistantAgent}
          conversationId={conversationId}
          open={assistantOpen}
          onOpen={() => setAssistantOpen(true)}
          onClose={() => setAssistantOpen(false)}
        />
      ) : null}
    </div>
  );
}

function StatePill({ state }: { state: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize",
        state === "open"
          ? "bg-emerald-500/10 text-emerald-600"
          : state === "snoozed"
            ? "bg-amber-500/10 text-amber-600"
            : "bg-foreground/[0.06] text-muted-foreground",
      )}
    >
      {state}
    </span>
  );
}

/** Names the ranking rule of each inbox section — the priority is visible, not implied. */
function InboxRankLabel({ label, tone }: { label: string; tone: "paying" | "recency" }) {
  return (
    <p
      className={cn(
        "flex items-center gap-1 px-2.5 pb-1 pt-1.5 text-[9px] font-bold uppercase tracking-[0.08em]",
        tone === "paying" ? "text-ember" : "text-muted-foreground/60",
      )}
    >
      {tone === "paying" ? (
        <CreditCard className="h-2.5 w-2.5" aria-hidden />
      ) : (
        <Clock className="h-2.5 w-2.5" aria-hidden />
      )}
      {label}
    </p>
  );
}

/** Money-first priority signal: T1 pays like the top of the list, T2 midfield, T3 pays anything. */
function TierBadge({ tier, spend }: { tier?: number | null; spend?: number | null }) {
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    return null;
  }
  const amount =
    typeof spend === "number" && spend > 0
      ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(spend)
      : "";
  const compact = typeof spend === "number" && spend > 0 ? formatSpendCompact(spend) : "";
  const hint = tier === 1 ? "Top spender" : tier === 2 ? "Mid-tier spender" : "Paying customer";
  return (
    <span
      title={amount ? `${hint} · spend ${amount}` : hint}
      aria-label={amount ? `${hint}, spend ${amount}` : hint}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full px-1.5 py-px text-[9px] font-bold tracking-wide",
        tier === 1 && "bg-ember text-ember-foreground",
        tier === 2 && "bg-ember/15 text-ember",
        tier === 3 && "border border-border/70 bg-foreground/[0.03] text-muted-foreground",
      )}
    >
      T{tier}
      {compact ? ` · ${compact}` : ""}
    </span>
  );
}

function InboxRow({
  item,
  active,
  onClick,
}: {
  item: IntercomInboxItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "mb-0.5 block w-full rounded-xl px-2.5 py-2 text-left transition-colors",
        active ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
      )}
    >
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            item.state === "open"
              ? "bg-emerald-500"
              : item.state === "snoozed"
                ? "bg-amber-500"
                : "bg-muted-foreground/40",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.author}</span>
        <TierBadge tier={item.tier} spend={item.spend} />
        <span className="shrink-0 text-[10px] text-muted-foreground/70">{ago(item.updatedAt)}</span>
      </span>
      <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-muted-foreground">
        {item.snippet}
      </span>
    </button>
  );
}

function ThreadPane({
  parts,
  loading,
  error,
  onRetry,
}: {
  parts: IntercomPart[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = listRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [parts.length]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading the conversation…
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-sm rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-center">
          <p className="text-xs font-medium leading-relaxed text-amber-800">
            {error instanceof Error ? error.message : "Could not load the conversation."}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded-full border border-amber-600/40 px-3 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-500/20"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  return (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-2.5">
        {parts.map((part) => (
          <div
            key={part.id}
            className={cn(
              "max-w-[88%] rounded-2xl px-3.5 py-2.5",
              part.note
                ? "self-end border border-amber-500/40 bg-amber-500/10"
                : part.role === "teammate"
                  ? "self-end bg-ember/10"
                  : part.role === "bot"
                    ? "self-start bg-violet-500/10"
                    : "self-start bg-foreground/[0.05]",
            )}
          >
            <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
              <span className="font-semibold text-foreground/80">{part.author}</span>
              {part.note ? (
                <span className="font-semibold uppercase tracking-wide text-amber-700">
                  Internal note
                </span>
              ) : part.role === "bot" ? (
                <span className="font-semibold uppercase tracking-wide text-violet-600">Bot</span>
              ) : null}
              <span>{formatTime(part.createdAt)}</span>
            </p>
            {part.body ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {part.body}
              </p>
            ) : null}
            {(part.attachments ?? []).length > 0 ? (
              <div className="mt-2 flex flex-col items-start gap-2">
                {(part.attachments ?? []).map((file, index) =>
                  file.contentType.startsWith("image/") ? (
                    <a
                      key={`${part.id}-att-${index}`}
                      href={file.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block max-w-full"
                      title={file.name}
                    >
                      <img
                        src={file.url}
                        alt={file.name}
                        loading="lazy"
                        className="max-h-56 w-auto max-w-full rounded-lg border border-foreground/10"
                      />
                    </a>
                  ) : (
                    <a
                      key={`${part.id}-att-${index}`}
                      href={file.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-foreground/10 bg-background/70 px-2.5 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-background"
                    >
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{file.name}</span>
                      {formatAttachmentBytes(file.size) ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatAttachmentBytes(file.size)}
                        </span>
                      ) : null}
                    </a>
                  ),
                )}
              </div>
            ) : null}
          </div>
        ))}
        {parts.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No readable messages in this conversation.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Composer with a target switch: Intercom Reply / internal Note / #channel. */
function DeskComposer({
  target,
  onTarget,
  hasInbox,
  conversationSelected,
  channelName,
  contextLine,
  seedText,
  seedNonce,
  mentionAdmins,
  onSend,
}: {
  target: ComposerTarget;
  onTarget: (next: ComposerTarget) => void;
  hasInbox: boolean;
  conversationSelected: boolean;
  channelName: string | null;
  contextLine: string | null;
  seedText: string;
  seedNonce: number;
  mentionAdmins: DeskMentionAdmin[];
  onSend: (text: string, mentions: Array<{ id: string; name: string }>) => Promise<void>;
}) {
  const [text, setText] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  /** Open "@query" fragment before the caret (Note only) + the picked name → id log. */
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState<number>(0);
  const pickedRef = useRef<Map<string, string>>(new Map());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (target !== "note") {
      setMention(null);
    }
  }, [target]);

  const mentionOptions = useMemo(() => {
    if (!mention) {
      return [];
    }
    return mentionAdmins
      .filter(
        (admin) =>
          mention.query.length === 0 ||
          admin.name.toLowerCase().includes(mention.query) ||
          admin.email.toLowerCase().includes(mention.query),
      )
      .slice(0, 6);
  }, [mention, mentionAdmins]);

  /** "@quer" right before the caret opens the picker — Note target only. */
  const trackMention = (value: string, caret: number) => {
    if (target !== "note") {
      return;
    }
    const match = /(^|[\s(])@([^\s@]{0,40})$/u.exec(value.slice(0, caret));
    if (!match) {
      setMention(null);
      return;
    }
    setMention({ query: match[2].toLowerCase(), start: caret - match[2].length - 1 });
    setMentionIndex(0);
  };

  const insertMention = (admin: DeskMentionAdmin) => {
    if (!mention) {
      return;
    }
    const caret = textareaRef.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${admin.name} ${text.slice(caret)}`;
    pickedRef.current.set(admin.name, admin.id);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node) {
        const position = mention.start + admin.name.length + 2;
        node.focus();
        node.setSelectionRange(position, position);
        node.style.height = "auto";
        node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
      }
    });
  };

  // A picked suggestion loads into the composer — still sent by the human.
  useEffect(() => {
    if (seedNonce > 0) {
      setText(seedText);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node) {
          node.style.height = "auto";
          node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
          node.focus();
        }
      });
    }
  }, [seedNonce, seedText]);

  const needsConversation = target !== "channel";
  const blocked = needsConversation && !conversationSelected;

  const submit = async () => {
    const body = text.trim();
    if (body.length === 0 || sending || blocked) {
      return;
    }
    // Only names still present as "@Name" ride along — deleting the text unmentions.
    const mentions =
      target === "note"
        ? [...pickedRef.current.entries()]
            .filter(([name]) => body.includes(`@${name}`))
            .map(([name, id]) => ({ id, name }))
        : [];
    setSending(true);
    try {
      await onSend(body, mentions);
      setText("");
      pickedRef.current.clear();
      setMention(null);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node) {
          node.style.height = "auto";
          node.focus();
        }
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send");
    } finally {
      setSending(false);
    }
  };

  const hint =
    target === "reply"
      ? "Replies to the customer as the connected Intercom admin"
      : target === "note"
        ? "Internal note — visible only to teammates in Intercom · type @ to tag someone"
        : contextLine
          ? `Posts to #${channelName} with a "${contextLine}" reference line`
          : `Posts to #${channelName} in this project`;

  return (
    <div className="shrink-0 border-t border-border/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {hasInbox ? (
          <>
            <TargetChip
              label="Reply"
              active={target === "reply"}
              activeClass="bg-ember text-ember-foreground"
              onClick={() => onTarget("reply")}
            />
            <TargetChip
              label="Note"
              active={target === "note"}
              activeClass="bg-amber-500 text-white"
              onClick={() => onTarget("note")}
            />
          </>
        ) : null}
        {channelName ? (
          <TargetChip
            label={`#${channelName}`}
            active={target === "channel"}
            activeClass="bg-foreground text-background"
            onClick={() => onTarget("channel")}
          />
        ) : null}
      </div>
      <div
        className={cn(
          "relative flex items-end gap-2 rounded-2xl border px-3 py-2 shadow-sm transition-colors focus-within:border-foreground/25",
          target === "note" ? "border-amber-500/50 bg-amber-500/10" : "border-border/70 bg-card",
        )}
      >
        {mention && mentionOptions.length > 0 ? (
          <div
            data-testid="desk-mention-list"
            className="absolute bottom-full left-2 z-20 mb-1.5 w-64 overflow-hidden rounded-xl border border-border/70 bg-popover shadow-lg"
          >
            <p className="border-b border-border/50 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Tag a teammate
            </p>
            {mentionOptions.map((admin, index) => (
              <button
                key={admin.id}
                type="button"
                data-testid="desk-mention-option"
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(admin);
                }}
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm",
                  index === mentionIndex ? "bg-amber-500/15" : "hover:bg-foreground/[0.04]",
                )}
              >
                <span className="truncate font-medium">{admin.name}</span>
                {admin.email ? (
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">{admin.email}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          maxLength={8_000}
          disabled={blocked}
          placeholder={
            blocked
              ? "Select a conversation first"
              : target === "note"
                ? "Internal note for teammates…"
                : target === "channel"
                  ? `Message #${channelName}…`
                  : "Reply to the customer…"
          }
          onChange={(event) => {
            setText(event.target.value);
            const node = event.target;
            trackMention(node.value, node.selectionStart ?? node.value.length);
            node.style.height = "auto";
            node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
          }}
          onKeyDown={(event) => {
            if (mention && mentionOptions.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setMentionIndex((index) => (index + delta + mentionOptions.length) % mentionOptions.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                insertMention(mentionOptions[mentionIndex] ?? mentionOptions[0]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMention(null);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
        />
        <button
          type="button"
          aria-label="Send"
          disabled={text.trim().length === 0 || sending || blocked}
          onClick={() => void submit()}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
            text.trim().length > 0 && !sending && !blocked
              ? target === "note"
                ? "bg-amber-500 text-white hover:bg-amber-500/90"
                : "bg-ember text-ember-foreground hover:bg-ember/90"
              : "bg-foreground/[0.07] text-muted-foreground/60",
          )}
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <SendHorizontal className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <p className="mt-1.5 px-1 text-[10px] text-muted-foreground/70">{hint}</p>
    </div>
  );
}

function TargetChip({
  label,
  active,
  activeClass,
  onClick,
}: {
  label: string;
  active: boolean;
  activeClass: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active ? activeClass : "border border-border/70 text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/** "45s" / "12m" / "3h" — compact duration for response-time stats. */
function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "—";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 36) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

/**
 * Gera's strip above the composer: reply drafts in a live-human voice (click
 * loads one into the composer — a person still sends it; 👍/👎 calibrate the
 * next drafts), a snooze/close recommendation with one-tap actions, and an
 * "Ask Gera" escalation when the customer asks how the product works.
 * One model run per thread update — cached server-side per last message.
 */
function SuggestStrip({
  projectId,
  screenId,
  conversationId,
  lastPartId,
  hasAssistant,
  onPick,
  onAsk,
  onActed,
  onOpenAssistant,
}: {
  projectId: string;
  screenId: string;
  conversationId: string;
  lastPartId: string;
  hasAssistant: boolean;
  onPick: (text: string) => void;
  onAsk: (question: string) => Promise<void>;
  onActed: () => Promise<void>;
  onOpenAssistant: () => void;
}) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [votes, setVotes] = useState<Record<string, "up" | "down">>({});
  const [acting, setActing] = useState<"snooze" | "close" | null>(null);
  const [asking, setAsking] = useState<boolean>(false);
  const [regenerating, setRegenerating] = useState<boolean>(false);

  const suggestKey = useMemo(
    () => ["screen-suggest", projectId, screenId, conversationId, lastPartId] as const,
    [projectId, screenId, conversationId, lastPartId],
  );
  const suggestQuery = useQuery({
    queryKey: suggestKey,
    enabled: lastPartId.length > 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => fetchScreenSuggestions(projectId, { screenId, conversationId }),
  });
  const payload = suggestQuery.data ?? null;

  // Slack awareness: internal discussions that reference this conversation —
  // polled while the thread is open, so the desk waits and shows the outcome.
  const slackQuery = useQuery({
    queryKey: ["desk-slack", projectId, screenId, conversationId],
    refetchInterval: 45_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => fetchDeskSlackRelated(projectId, { screenId, conversationId }),
  });
  const slack = slackQuery.data?.slack ?? null;
  const related = slack?.related ?? [];
  const slackLatestTs = related.reduce((max, item) => Math.max(max, item.lastActivityTs), 0);

  // The latest "Ask Gera" investigation on this conversation (any member's):
  // fast poll while running so the answer lands inline the moment it's ready.
  const askQuery = useQuery({
    queryKey: ["desk-ask", projectId, screenId, conversationId],
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.ask?.status === "running" ? 4_000 : 30_000),
    queryFn: () => fetchDeskAskStatus(projectId, { screenId, conversationId }),
  });
  const ask = askQuery.data?.ask ?? null;
  const [askExpanded, setAskExpanded] = useState<boolean>(false);

  const vote = async (suggestionId: string, verdict: "up" | "down") => {
    setVotes((prev) => ({ ...prev, [suggestionId]: verdict }));
    try {
      await rateScreenSuggestion(projectId, { screenId, suggestionId, verdict });
    } catch {
      // Non-fatal — the vote is a calibration hint; the next run just misses it.
    }
  };

  const act = async (action: "snooze" | "close") => {
    setActing(action);
    try {
      await actOnScreenConversation(projectId, { screenId, conversationId, action });
      toast.success(action === "close" ? "Closed in Intercom" : "Snoozed until tomorrow");
      await onActed();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the conversation");
    } finally {
      setActing(null);
    }
  };

  const regenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      const fresh = await fetchScreenSuggestions(projectId, { screenId, conversationId, force: true });
      queryClient.setQueryData(suggestKey, fresh);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not draft suggestions");
    } finally {
      setRegenerating(false);
    }
  }, [projectId, screenId, conversationId, queryClient, suggestKey]);

  // "Wait, then show": when Slack moved AFTER these drafts were generated,
  // hold while the thread is hot, then force ONE regenerate so the drafts
  // absorb the outcome. Re-checked on every ~45s Slack poll.
  const autoRefreshedFor = useRef<number>(0);
  const slackStale = Boolean(
    payload && slackLatestTs > 0 && slackLatestTs * 1000 > payload.generatedAt + 5_000,
  );
  useEffect(() => {
    autoRefreshedFor.current = 0;
    setAskExpanded(false);
  }, [conversationId]);
  useEffect(() => {
    if (!slackStale || regenerating || slackLatestTs === 0) {
      return;
    }
    if (Date.now() - slackLatestTs * 1000 < 150_000) {
      return; // The thread is still hot — keep waiting for the outcome.
    }
    if (autoRefreshedFor.current === slackLatestTs) {
      return; // Already refreshed for this activity burst.
    }
    autoRefreshedFor.current = slackLatestTs;
    void regenerate();
  }, [slackStale, slackLatestTs, regenerating, regenerate]);

  const askFunctionality = async () => {
    if (!payload?.functionalityQuestion) {
      return;
    }
    setAsking(true);
    try {
      await onAsk(payload.functionalityQuestion);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the research");
    } finally {
      setAsking(false);
    }
  };

  const recommended = payload?.action ?? "reply";

  return (
    <div className="shrink-0 border-t border-border/60 px-3 pt-2" data-testid={TID.screenDeskSuggest}>
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-ember" />
        <p className="min-w-0 flex-1 truncate text-[11px] font-semibold">
          Gera suggests
          {payload?.cached ? (
            <span className="ml-1 font-normal text-muted-foreground/70">· cached</span>
          ) : null}
        </p>
        {suggestQuery.isFetching || regenerating ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : null}
        <button
          type="button"
          aria-label="Regenerate suggestions"
          disabled={regenerating}
          onClick={() => void regenerate()}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={collapsed ? "Expand suggestions" : "Collapse suggestions"}
          onClick={() => setCollapsed(!collapsed)}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")} />
        </button>
      </div>

      {!collapsed ? (
        <div className="mt-1.5 space-y-1.5 pb-1">
          {ask ? (
            <div
              data-testid={TID.screenDeskAsk}
              className={cn(
                "rounded-xl border px-2.5 py-1.5",
                ask.status === "error"
                  ? "border-amber-500/40 bg-amber-500/10"
                  : "border-violet-500/40 bg-violet-500/10",
              )}
            >
              <div className="flex items-center gap-1.5">
                {ask.status === "running" ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-violet-700" />
                ) : (
                  <Sparkles
                    className={cn(
                      "h-3 w-3 shrink-0",
                      ask.status === "error" ? "text-amber-700" : "text-violet-700",
                    )}
                  />
                )}
                <p
                  className={cn(
                    "min-w-0 flex-1 truncate text-[11px] font-semibold",
                    ask.status === "error" ? "text-amber-800" : "text-violet-800",
                  )}
                >
                  {ask.status === "running"
                    ? "Gera investigates"
                    : ask.status === "error"
                      ? "Investigation failed"
                      : "Gera researched"}
                  {ask.by ? <span className="font-normal"> · {ask.by}</span> : null}
                  <span className="font-normal"> · {ago(ask.at)}</span>
                </p>
                {hasAssistant ? (
                  <button
                    type="button"
                    onClick={onOpenAssistant}
                    className="shrink-0 rounded-full border border-violet-500/40 px-2 py-0.5 text-[10px] font-medium text-violet-700 transition-colors hover:bg-violet-500/10"
                  >
                    Open assistant
                  </button>
                ) : null}
              </div>
              {ask.question ? (
                <p className="mt-0.5 truncate text-[11px] text-violet-800/90">{ask.question}</p>
              ) : null}
              {ask.status === "running" ? (
                <p className="mt-0.5 text-[10px] leading-relaxed text-violet-700/80">
                  The answer lands right here when the research finishes.
                </p>
              ) : ask.answer ? (
                <>
                  <div
                    className={cn(
                      "mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/85",
                      askExpanded ? "max-h-64 overflow-y-auto" : "max-h-16 overflow-hidden",
                    )}
                  >
                    {ask.answer}
                  </div>
                  <button
                    type="button"
                    onClick={() => setAskExpanded(!askExpanded)}
                    className="mt-1 text-[10px] font-medium text-violet-700 hover:underline"
                  >
                    {askExpanded ? "Show less" : "Show more"}
                  </button>
                </>
              ) : null}
              {ask.execution ? <ExecutionOutcomeCard outcome={ask.execution} className="mt-2" /> : null}
            </div>
          ) : null}

          {slackQuery.isError ? (
            <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium leading-relaxed text-amber-800">
              Slack check failed:{" "}
              {slackQuery.error instanceof Error ? slackQuery.error.message : "error"}
            </p>
          ) : null}
          {related.length > 0 ? (
            <div className="space-y-1.5" data-testid={TID.screenDeskSlack}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                Already in Slack
              </p>
              {related.map((thread) => (
                <div
                  key={`${thread.channelId}:${thread.rootTs}`}
                  className="rounded-xl border border-border/60 bg-card px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-1.5">
                    <Hash className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate text-[11px] font-semibold">{thread.channelName}</span>
                    {thread.active ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                        investigating
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {ago(thread.lastActivityTs * 1000)}
                    </span>
                    <a
                      href={thread.permalink}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open in Slack (#${thread.channelName})`}
                      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {thread.lines.slice(-3).map((line) => (
                      <p key={line.ts} className="truncate text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground/75">@{line.author}</span>{" "}
                        {line.text}
                      </p>
                    ))}
                  </div>
                  {thread.active ? (
                    <p className="mt-1 text-[10px] leading-relaxed text-amber-700/90">
                      Waiting for the outcome — drafts refresh when this settles.
                    </p>
                  ) : null}
                </div>
              ))}
              {slackStale ? (
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Slack moved after these drafts — they auto-refresh once the thread settles, or hit
                  refresh now.
                </p>
              ) : null}
            </div>
          ) : null}

          {suggestQuery.isError ? (
            <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium leading-relaxed text-amber-800">
              {suggestQuery.error instanceof Error
                ? suggestQuery.error.message
                : "Could not draft suggestions."}
            </p>
          ) : !payload ? (
            <p className="flex items-center gap-1.5 py-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Reading the thread, drafting like a human…
            </p>
          ) : (
            <>
            {payload.investigation ? (
              <div
                className={cn(
                  "flex items-start gap-1.5 rounded-xl border px-2.5 py-1.5",
                  payload.investigation.status === "in_progress"
                    ? "border-amber-500/40 bg-amber-500/10"
                    : "border-emerald-500/40 bg-emerald-500/10",
                )}
              >
                {payload.investigation.status === "in_progress" ? (
                  <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-amber-700" />
                ) : (
                  <CheckCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-700" />
                )}
                <p
                  className={cn(
                    "min-w-0 flex-1 text-[11px] leading-snug",
                    payload.investigation.status === "in_progress"
                      ? "text-amber-800"
                      : "text-emerald-800",
                  )}
                >
                  <span className="font-semibold">
                    {payload.investigation.status === "in_progress"
                      ? "Team is investigating in Slack — wait"
                      : "Slack has the outcome"}
                  </span>
                  {payload.investigation.summary ? ` — ${payload.investigation.summary}` : ""}
                </p>
              </div>
            ) : null}
            {payload.suggestions.map((suggestion) => (
              <div
                key={suggestion.id}
                className="flex items-start gap-1.5 rounded-xl border border-border/60 bg-card px-2.5 py-1.5"
              >
                <button
                  type="button"
                  onClick={() => onPick(suggestion.text)}
                  title="Load into the composer — you still press Send"
                  className="min-w-0 flex-1 text-left text-xs leading-snug text-foreground/90 transition-colors hover:text-foreground"
                >
                  <span className="line-clamp-2">{suggestion.text}</span>
                </button>
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="Good suggestion"
                    aria-pressed={votes[suggestion.id] === "up"}
                    onClick={() => void vote(suggestion.id, "up")}
                    className={cn(
                      "rounded-md p-1 transition-colors",
                      votes[suggestion.id] === "up"
                        ? "bg-emerald-500/15 text-emerald-600"
                        : "text-muted-foreground/60 hover:bg-foreground/5 hover:text-foreground",
                    )}
                  >
                    <ThumbsUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label="Bad suggestion"
                    aria-pressed={votes[suggestion.id] === "down"}
                    onClick={() => void vote(suggestion.id, "down")}
                    className={cn(
                      "rounded-md p-1 transition-colors",
                      votes[suggestion.id] === "down"
                        ? "bg-red-500/15 text-red-600"
                        : "text-muted-foreground/60 hover:bg-foreground/5 hover:text-foreground",
                    )}
                  >
                    <ThumbsDown className="h-3 w-3" />
                  </button>
                </span>
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
                title={payload.actionReason || undefined}
              >
                Recommends:{" "}
                <span className="font-semibold capitalize text-foreground/80">{payload.action}</span>
                {payload.actionReason ? ` — ${payload.actionReason}` : ""}
              </span>
              <button
                type="button"
                disabled={acting !== null}
                onClick={() => void act("snooze")}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  recommended === "snooze"
                    ? "border-amber-500/50 bg-amber-500/10 text-amber-700"
                    : "border-border/70 text-muted-foreground hover:text-foreground",
                )}
              >
                {acting === "snooze" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <AlarmClock className="h-3 w-3" />
                )}
                Snooze 1d
              </button>
              <button
                type="button"
                disabled={acting !== null}
                onClick={() => void act("close")}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  recommended === "close"
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700"
                    : "border-border/70 text-muted-foreground hover:text-foreground",
                )}
              >
                {acting === "close" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCheck className="h-3 w-3" />
                )}
                Close
              </button>
            </div>

            {payload.functionalityQuestion && ask?.status !== "running" ? (
              hasAssistant ? (
                <div className="flex items-center gap-2 rounded-xl border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5">
                  <p className="min-w-0 flex-1 text-[11px] leading-snug text-violet-800">
                    Functionality question:{" "}
                    <span className="font-medium">{payload.functionalityQuestion}</span>
                  </p>
                  <button
                    type="button"
                    disabled={asking}
                    onClick={() => void askFunctionality()}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-violet-600/90"
                  >
                    {asking ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    Ask Gera AI
                  </button>
                </div>
              ) : (
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Looks like a functionality question — add an assistant widget to this screen and
                  Gera can research it.
                </p>
              )
            ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Team performance — per-teammate stats from REAL Intercom threads: reply
 * counts, median response time, model-written grades with reasons, coaching
 * notes, and Intercom-admin ↔ Gera-member links. Admins see the whole team
 * and collect & grade on demand; members see their own linked card only.
 */
function PerformancePanel({
  projectId,
  screenId,
  onClose,
}: {
  projectId: string;
  screenId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [clearing, setClearing] = useState<boolean>(false);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const range = useMemo(() => deskDateRange(fromDate, toDate), [fromDate, toDate]);
  const statsKey = useMemo(
    () => ["desk-stats", projectId, screenId, range.from, range.to] as const,
    [projectId, range.from, range.to, screenId],
  );
  const statsQuery = useQuery({
    queryKey: statsKey,
    retry: false,
    queryFn: () => fetchDeskStats(projectId, screenId, range),
  });
  const stats: DeskStats | null = statsQuery.data ?? null;
  const members = stats?.members ?? [];

  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await refreshDeskStats(projectId, screenId, range);
      queryClient.setQueryData(statsKey, next);
      toast.success(
        `Read ${next.analyzedConversations ?? 0} conversations · collected ${next.collected ?? 0} replies · graded ${next.graded ?? 0}`,
      );
      if (next.gradeError) {
        toast.error(next.gradeError);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not collect team stats");
    } finally {
      setRefreshing(false);
    }
  };

  const clearResults = async (): Promise<void> => {
    if (!window.confirm("Clear all collected replies, grades and coaching for this desk? Team links will stay.")) {
      return;
    }
    setClearing(true);
    try {
      const next = await clearDeskStats(projectId, screenId, range);
      queryClient.setQueryData(statsKey, next);
      await queryClient.invalidateQueries({ queryKey: ["desk-stats", projectId, screenId] });
      toast.success("Team performance results cleared");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear team performance");
    } finally {
      setClearing(false);
    }
  };

  const setPreset = (days: number | null): void => {
    if (days === null) {
      setFromDate("");
      setToDate("");
      return;
    }
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days + 1);
    setFromDate(dateInputValue(from));
    setToDate(dateInputValue(to));
  };

  const link = async (teammate: { adminId: string; name: string }, email: string) => {
    try {
      await linkDeskTeammate(projectId, {
        adminId: teammate.adminId,
        email,
        adminName: teammate.name,
      });
      await queryClient.invalidateQueries({ queryKey: statsKey });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the link");
    }
  };

  const knownAdminIds = new Set((stats?.teammates ?? []).map((teammate) => teammate.adminId));
  const unseenAdmins = (stats?.intercomAdmins ?? []).filter((admin) => !knownAdminIds.has(admin.id));
  const slowReplies = stats ? Math.max(0, stats.responseSamples - stats.withinOneHour) : 0;
  const withinHourShare =
    stats && stats.responseSamples > 0 ? Math.round((stats.withinOneHour / stats.responseSamples) * 100) : null;
  const attentionItems = stats
    ? [
        ...(stats.ungraded > 0
          ? [`Grade ${stats.ungraded} waiting ${stats.ungraded === 1 ? "reply" : "replies"} to make coaching current.`]
          : []),
        ...(stats.badReplies > 0
          ? [`Review ${stats.badReplies} ${stats.badReplies === 1 ? "reply" : "replies"} that left the customer stuck or missed context.`]
          : []),
        ...(stats.responseSamples >= 5 && slowReplies > 0
          ? [`Reduce the slow tail: ${slowReplies} measured replies took over one hour; p90 is ${formatDuration(stats.p90ResponseMs)}.`]
          : []),
        ...(stats.coverage?.limitReached
          ? ["Narrow the date range for complete coverage; this pass reached the 300-conversation scan limit."]
          : []),
      ]
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      data-testid={TID.screenDeskPerformancePanel}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <ChartColumn className="h-4 w-4 text-ember" />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">Team performance</p>
        <button
          type="button"
          aria-label="Refresh stats"
          onClick={() => void statsQuery.refetch()}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", statsQuery.isFetching && "animate-spin")} />
        </button>
        <button
          type="button"
          aria-label="Close performance"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-4">
          <section
            className="mb-3 rounded-2xl border border-border/60 bg-card p-3.5"
            data-testid={TID.screenDeskPerformanceDates}
          >
            <div className="flex items-start gap-2">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-ember" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">Performance period</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {performanceRangeLabel(range)} · results update as dates change
                </p>
              </div>
              {(fromDate || toDate) && (
                <button
                  type="button"
                  onClick={() => setPreset(null)}
                  className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  Clear dates
                </button>
              )}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {[
                { label: "7 days", days: 7 },
                { label: "30 days", days: 30 },
                { label: "90 days", days: 90 },
                { label: "All time", days: null },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setPreset(preset.days)}
                  className="rounded-full border border-border/70 px-2.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:border-ember/40 hover:text-foreground"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <label className="text-[10px] font-medium text-muted-foreground">
                From
                <input
                  type="date"
                  value={fromDate}
                  max={toDate || dateInputValue(new Date())}
                  onChange={(event) => setFromDate(event.target.value)}
                  className="mt-1 h-8 w-full rounded-lg border border-border/70 bg-background px-2 text-[11px] text-foreground"
                />
              </label>
              <label className="text-[10px] font-medium text-muted-foreground">
                To
                <input
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  max={dateInputValue(new Date())}
                  onChange={(event) => setToDate(event.target.value)}
                  className="mt-1 h-8 w-full rounded-lg border border-border/70 bg-background px-2 text-[11px] text-foreground"
                />
              </label>
            </div>
          </section>

          {stats?.isAdmin ? (
            <div className="mb-3 rounded-2xl border border-border/60 bg-card p-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold">Deep analysis</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    Reads up to 300 matching Intercom conversations and their deeper transcripts,
                    grades up to 24 new replies, then rebuilds pattern-based coaching.
                    {stats.ungraded > 0 ? ` ${stats.ungraded} replies in this period await grading.` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={refreshing || clearing}
                  onClick={() => void refresh()}
                  data-testid={TID.screenDeskPerformanceAnalyze}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ember px-3.5 py-1.5 text-xs font-semibold text-ember-foreground transition-colors hover:bg-ember/90 disabled:opacity-60"
                >
                  {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {refreshing ? "Reading conversations…" : "Analyze conversations"}
                </button>
              </div>
              {stats.totalReplies > 0 ? (
                <button
                  type="button"
                  disabled={refreshing || clearing}
                  onClick={() => void clearResults()}
                  data-testid={TID.screenDeskPerformanceClear}
                  className="mt-2.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-red-600 transition-colors hover:text-red-700 disabled:opacity-50"
                >
                  {clearing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  {clearing ? "Clearing…" : "Clear current results"}
                </button>
              ) : null}
            </div>
          ) : null}

          {stats && stats.totalReplies > 0 ? (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "Conversations", value: stats.conversations },
                { label: "Replies", value: stats.totalReplies },
                { label: "Graded", value: stats.gradedReplies },
                { label: "Teammates", value: stats.teammates.length },
              ].map((metric) => (
                <div key={metric.label} className="rounded-xl border border-border/60 bg-card px-3 py-2.5">
                  <p className="text-[10px] text-muted-foreground">{metric.label}</p>
                  <p className="mt-0.5 text-lg font-bold tracking-tight">{metric.value}</p>
                </div>
              ))}
              {stats.coverage ? (
                <p className="col-span-2 px-1 text-[10px] leading-relaxed text-muted-foreground sm:col-span-4">
                  Last analysis read {stats.coverage.analyzedConversations} of {stats.coverage.scannedConversations} scanned conversations
                  {stats.coverage.limitReached ? " · scan limit reached" : ""} · updated {ago(stats.coverage.collectedAt)} ago
                </p>
              ) : null}
            </div>
          ) : null}

          {stats && stats.totalReplies > 0 ? (
            <section className="mb-3 rounded-2xl border border-border/60 bg-card p-3.5">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-ember" />
                <p className="text-xs font-semibold">What to act on</p>
                {withinHourShare !== null ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">{withinHourShare}% answered within 1h</span>
                ) : null}
              </div>
              {attentionItems.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {attentionItems.map((item) => (
                    <li key={item} className="flex gap-2 text-[11px] leading-relaxed text-foreground/85">
                      <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ember" />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  No actionable warning in this sample. Keep the period consistent and rerun analysis to spot a real change.
                </p>
              )}
            </section>
          ) : null}

          {statsQuery.isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading team performance…
            </div>
          ) : statsQuery.isError ? (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-xs font-medium leading-relaxed text-amber-800">
                {statsQuery.error instanceof Error
                  ? statsQuery.error.message
                  : "Could not load team performance."}
              </p>
            </div>
          ) : stats && stats.teammates.length === 0 ? (
            <div className="rounded-2xl border border-border/60 bg-card p-4 text-center">
              <ChartColumn className="mx-auto h-5 w-5 text-muted-foreground/60" />
              <p className="mt-2 text-sm font-medium">
                {stats.isAdmin ? "No teammate replies collected yet" : "Nothing to show you yet"}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                {stats.isAdmin
                  ? "Choose a date range and press Analyze conversations — Gera will rebuild performance from real Intercom threads."
                  : "Your Intercom identity isn't linked yet, or no stats were collected. Ask a project admin to open this panel, collect stats and link you."}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {(stats?.teammates ?? []).map((teammate) => (
                <TeammateCard
                  key={teammate.adminId}
                  teammate={teammate}
                  isAdmin={stats?.isAdmin === true}
                  members={members}
                  onLink={(email) => link(teammate, email)}
                />
              ))}
            </div>
          )}

          {stats?.isAdmin && unseenAdmins.length > 0 ? (
            <div className="mt-4">
              <p className="px-1 text-xs font-semibold">Other Intercom teammates</p>
              <p className="mt-0.5 px-1 text-[11px] leading-relaxed text-muted-foreground">
                No collected replies yet — link them to Gera members now so stats attach to the
                right person later.
              </p>
              <div className="mt-2 space-y-1.5">
                {unseenAdmins.map((admin) => (
                  <div
                    key={admin.id}
                    className="flex items-center gap-2 rounded-xl border border-border/60 bg-card px-3 py-2"
                  >
                    <p className="min-w-0 flex-1 truncate text-xs font-medium">
                      {admin.name}
                      {admin.email ? (
                        <span className="ml-1.5 font-normal text-muted-foreground">
                          {admin.email}
                        </span>
                      ) : null}
                    </p>
                    <select
                      value=""
                      aria-label={`Link ${admin.name} to a Gera member`}
                      onChange={(event) =>
                        void link({ adminId: admin.id, name: admin.name }, event.target.value)
                      }
                      className="h-7 shrink-0 rounded-lg border border-border/70 bg-card px-2 text-[11px]"
                    >
                      <option value="">Not linked</option>
                      {members.map((member) => (
                        <option key={member.email} value={member.email}>
                          {member.name} · {member.email}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <p className="mt-4 px-1 pb-4 text-[10px] leading-relaxed text-muted-foreground/70">
            Stats come from real Intercom threads in the selected reply-date range. Collection is
            paginated and bounded at 300 conversations per pass; every grade sees the surrounding
            transcript, while coaching looks for broader patterns. Admins run analysis on demand;
            nothing spends model credits in the background.
          </p>
        </div>
      </div>
    </div>
  );
}

/** One teammate's card: metrics, good-share bar, coaching, graded examples. */
function TeammateCard({
  teammate,
  isAdmin,
  members,
  onLink,
}: {
  teammate: DeskTeammate;
  isAdmin: boolean;
  members: Array<{ email: string; name: string }>;
  onLink: (email: string) => Promise<void>;
}) {
  const [showExamples, setShowExamples] = useState<boolean>(false);
  const graded = teammate.good + teammate.bad;
  const goodShare = graded > 0 ? Math.round((teammate.good / graded) * 100) : null;

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-3.5">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ember/15 text-sm font-bold uppercase text-ember"
        >
          {teammate.name.trim().charAt(0) || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{teammate.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {teammate.linkedEmail ? `Gera: ${teammate.linkedEmail}` : "Not linked to a Gera member"}
          </p>
        </div>
        {isAdmin ? (
          <select
            value={teammate.linkedEmail}
            aria-label={`Link ${teammate.name} to a Gera member`}
            onChange={(event) => void onLink(event.target.value)}
            className="h-7 shrink-0 rounded-lg border border-border/70 bg-card px-2 text-[11px]"
          >
            <option value="">Not linked</option>
            {members.map((member) => (
              <option key={member.email} value={member.email}>
                {member.name} · {member.email}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div>
          <p className="text-[10px] text-muted-foreground">Replies</p>
          <p className="text-sm font-bold">{teammate.replies}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Conversations</p>
          <p className="text-sm font-bold">{teammate.conversations}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Median reply</p>
          <p className="text-sm font-bold">{formatDuration(teammate.medianResponseMs)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Slow tail (p90)</p>
          <p className="text-sm font-bold">{formatDuration(teammate.p90ResponseMs)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Within 1 hour</p>
          <p className="text-sm font-bold">
            {teammate.responseSamples > 0 ? `${Math.round((teammate.withinOneHour / teammate.responseSamples) * 100)}%` : "—"}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Good / Bad</p>
          <p className="text-sm font-bold">
            <span className="text-emerald-600">{teammate.good}</span>
            <span className="text-muted-foreground/60"> / </span>
            <span className={teammate.bad > 0 ? "text-red-600" : "text-muted-foreground/60"}>
              {teammate.bad}
            </span>
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Ungraded</p>
          <p className="text-sm font-bold text-muted-foreground">{teammate.ungraded}</p>
        </div>
      </div>

      {goodShare !== null ? (
        <div className="mt-2">
          <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.08]">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${goodShare}%` }} />
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {goodShare}% of graded replies rated good · {new Date(teammate.firstAt).toLocaleDateString()} – {new Date(teammate.lastAt).toLocaleDateString()} · last reply {ago(teammate.lastAt)} ago
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[10px] text-muted-foreground">
          Not graded yet — {isAdmin ? "press Collect & grade above." : "an admin grades on demand."}
        </p>
      )}

      {teammate.coaching ? (
        <div className="mt-2.5 rounded-xl border border-violet-500/30 bg-violet-500/[0.07] p-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-800">
            <GraduationCap className="h-3.5 w-3.5" />
            Coaching
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-violet-900/90">{teammate.coaching}</p>
        </div>
      ) : null}

      {teammate.examples.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowExamples(!showExamples)}
            aria-expanded={showExamples}
            className="text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {showExamples ? "Hide graded examples" : `Graded examples (${teammate.examples.length})`}
          </button>
          {showExamples ? (
            <div className="mt-1.5 space-y-1.5">
              {teammate.examples.map((example, index) => (
                <div
                  key={`${teammate.adminId}:${index}`}
                  className="rounded-xl border border-border/60 bg-background px-2.5 py-2"
                >
                  <p className="flex flex-wrap items-center gap-1.5 text-[10px]">
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-px font-bold uppercase tracking-wide",
                        example.grade === "good"
                          ? "bg-emerald-500/15 text-emerald-700"
                          : "bg-red-500/15 text-red-700",
                      )}
                    >
                      {example.grade}
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(example.at).toLocaleDateString()} · reply in {formatDuration(example.responseMs)}
                    </span>
                    {example.reason ? (
                      <span className="min-w-0 flex-1 text-muted-foreground">{example.reason}</span>
                    ) : null}
                  </p>
                  {example.customer ? (
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                      Customer: {example.customer}
                    </p>
                  ) : null}
                  <p className="mt-0.5 line-clamp-2 text-[11px]">{example.reply}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Private per-member chat with the screen's agent — a floating live-chat
 * launcher + fixed panel (Intercom-messenger style); can attach the open case.
 */
function AssistantOverlay({
  projectId,
  screenId,
  widgetId,
  agent,
  conversationId,
  open,
  onOpen,
  onClose,
}: {
  projectId: string;
  screenId: string;
  widgetId: string;
  agent: ProjectAgent | null;
  conversationId: string | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [attach, setAttach] = useState<boolean>(true);
  const listRef = useRef<HTMLDivElement>(null);

  const chatKey = useMemo(
    () => ["screen-chat", projectId, screenId, widgetId] as const,
    [projectId, screenId, widgetId],
  );
  const chatQuery = useQuery({
    queryKey: chatKey,
    enabled: open,
    refetchInterval: open ? 3_500 : false,
    queryFn: () => fetchScreenChat(projectId, screenId, widgetId),
  });
  const messages = useMemo(() => chatQuery.data ?? [], [chatQuery.data]);

  useEffect(() => {
    const node = listRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length]);

  const submit = async () => {
    const body = text.trim();
    if (body.length === 0 || sending) {
      return;
    }
    setSending(true);
    try {
      await sendScreenChatMessage(projectId, {
        screenId,
        widgetId,
        body,
        ...(attach && conversationId ? { conversationId } : {}),
      });
      setText("");
      await queryClient.invalidateQueries({ queryKey: chatKey });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not message the assistant");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {!open ? (
        <button
          type="button"
          aria-label={agent ? `Chat with ${agent.name}` : "Open assistant"}
          data-testid={TID.screenDeskAssistant}
          onClick={onOpen}
          className="fixed bottom-28 right-4 z-40 flex h-[52px] w-[52px] items-center justify-center rounded-full bg-ember text-2xl text-ember-foreground shadow-xl shadow-ember/30 transition-transform hover:scale-105 active:scale-95 xl:bottom-6 xl:right-6"
        >
          {agent?.emoji || <Sparkles className="h-5 w-5" />}
        </button>
      ) : null}

      <aside
        data-testid={TID.screenDeskAssistantPanel}
        className={cn(
          "fixed inset-x-3 bottom-3 z-50 h-[min(620px,calc(100dvh-24px))] flex-col overflow-hidden rounded-3xl border border-border/70 bg-background shadow-2xl sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[400px]",
          open ? "flex animate-in fade-in slide-in-from-bottom-4 zoom-in-95 duration-200" : "hidden",
        )}
      >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ember/10 text-xs">
          {agent?.emoji || <Sparkles className="h-3 w-3 text-ember" />}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">
          {agent ? agent.name : "Assistant"}
          {agent ? (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">@{agent.handle}</span>
          ) : null}
        </p>
        <button
          type="button"
          aria-label="Close assistant"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {!agent ? (
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-xs font-medium leading-relaxed text-amber-800">
              The agent behind this widget was deleted — an admin must re-link it on the Screens
              tab.
            </p>
          </div>
        ) : messages.length === 0 && !chatQuery.isLoading ? (
          <div className="py-6 text-center">
            <Bot className="mx-auto h-5 w-5 text-muted-foreground/60" />
            <p className="mt-2 text-sm font-medium">Ask {agent.name}</p>
            <p className="mx-auto mt-1 max-w-[240px] text-xs leading-relaxed text-muted-foreground">
              A private chat just for you. Attach the open conversation and ask things like "what's
              this bug about?" or "draft a reply".
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) =>
              message.kind === "user" ? (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl bg-foreground/[0.06] px-3 py-2">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {message.body}
                    </p>
                  </div>
                </div>
              ) : (
                <div key={message.id} className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">
                    <span className="font-semibold text-foreground/80">{message.authorName}</span>{" "}
                    · {formatTime(message.createdAt)}
                  </p>
                  {message.pending ? (
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      thinking…
                    </p>
                  ) : (
                    <>
                      <MarkdownBody text={message.body} className="mt-0.5 text-sm" />
                      {message.execution ? (
                        <ExecutionOutcomeCard outcome={message.execution} className="mt-2" />
                      ) : null}
                    </>
                  )}
                </div>
              ),
            )}
          </div>
        )}
      </div>

      {agent ? (
        <div className="shrink-0 border-t border-border/60 p-3">
          {conversationId ? (
            <button
              type="button"
              onClick={() => setAttach((prev) => !prev)}
              aria-pressed={attach}
              className={cn(
                "mb-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                attach
                  ? "border-ember/40 bg-ember/10 text-ember"
                  : "border-border/70 text-muted-foreground hover:text-foreground",
              )}
            >
              <Paperclip className="h-3 w-3" />
              {attach ? `Attaching conv #${conversationId}` : `Attach conv #${conversationId}`}
            </button>
          ) : null}
          <div className="flex items-end gap-2 rounded-2xl border border-border/70 bg-card px-3 py-2 shadow-sm focus-within:border-foreground/25">
            <textarea
              value={text}
              rows={1}
              maxLength={8_000}
              placeholder={`Ask @${agent.handle}…`}
              onChange={(event) => {
                setText(event.target.value);
                const node = event.target;
                node.style.height = "auto";
                node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              className="max-h-36 min-h-[24px] flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground/70"
            />
            <button
              type="button"
              aria-label="Send to assistant"
              disabled={text.trim().length === 0 || sending}
              onClick={() => void submit()}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
                text.trim().length > 0 && !sending
                  ? "bg-ember text-ember-foreground hover:bg-ember/90"
                  : "bg-foreground/[0.07] text-muted-foreground/60",
              )}
            >
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <SendHorizontal className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[10px] text-muted-foreground/70">
            Private to you · one run per message, ~2 min budget
          </p>
        </div>
      ) : null}
      </aside>
    </>
  );
}

// Billing keys are matched in English and Russian — plan/Stripe/RevenueCat
// attribute names vary per workspace, and debt must never hide.
const SUBSCRIPTION_KEY_PATTERN =
  /stripe|plan|subscription|billing|revenue|payment|trial|mrr|invoice|balance|debt|credit|charge|spend|долг|баланс|тариф|подписк|оплат|плат[её]ж|сч[её]т/i;
const BALANCE_KEY_PATTERN = /balance|debt|owed|arrears|долг|задолж|баланс/i;
const URL_VALUE_PATTERN = /^https?:\/\/\S+$/i;

/** True for numeric-looking values that are not zero — flags debt honestly. */
function isNonZeroNumber(value: string): boolean {
  const num = Number.parseFloat(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(num) && num !== 0;
}

function formatDate(at: number): string {
  if (at <= 0) {
    return "";
  }
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Intercom-style right panel: assignee/team, conversation meta, subscription
 * attributes and the full contact profile — live via the screen's token.
 */
function DetailsPanel({
  projectId,
  screenId,
  conversationId,
  tier,
  spend,
  open,
  onClose,
}: {
  projectId: string;
  screenId: string;
  conversationId: string;
  tier?: number | null;
  spend?: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const detailsQuery = useQuery({
    queryKey: ["screen-conv-details", projectId, screenId, conversationId],
    refetchInterval: 30_000,
    retry: false,
    queryFn: () => fetchScreenConversationDetails(projectId, screenId, conversationId),
  });
  const details = detailsQuery.data ?? null;

  return (
    <aside
      data-testid={TID.screenDeskDetails}
      className={cn(
        "w-full flex-col bg-background",
        open ? "fixed inset-0 z-40 flex xl:static xl:z-auto" : "hidden xl:flex",
        "xl:w-[300px] xl:shrink-0 xl:border-l xl:border-border/60",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3.5">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">Details</p>
        {details?.intercomUrl ? (
          <a
            href={details.intercomUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in Intercom"
            title="Open in Intercom"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
        <button
          type="button"
          aria-label="Refresh details"
          onClick={() => void detailsQuery.refetch()}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", detailsQuery.isFetching && "animate-spin")} />
        </button>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground xl:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {detailsQuery.isLoading ? (
          <div className="flex items-center gap-2 px-3.5 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading from Intercom…
          </div>
        ) : detailsQuery.isError ? (
          <div className="m-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-xs font-medium leading-relaxed text-amber-800">
              {detailsQuery.error instanceof Error
                ? detailsQuery.error.message
                : "Could not load conversation details."}
            </p>
            <button
              type="button"
              onClick={() => void detailsQuery.refetch()}
              className="mt-2 rounded-full border border-amber-600/40 px-2.5 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-500/20"
            >
              Retry
            </button>
          </div>
        ) : details ? (
          <DetailsBody projectId={projectId} details={details} tier={tier} spend={spend} />
        ) : null}
      </div>
      <p className="border-t border-border/60 px-3.5 py-2 text-[10px] text-muted-foreground/70">
        Live Intercom data · updates every ~30s
      </p>
    </aside>
  );
}

function DetailsBody({
  projectId,
  details,
  tier,
  spend,
}: {
  projectId: string;
  details: DeskConversationDetails;
  tier?: number | null;
  spend?: number | null;
}) {
  const contact = details.contact;
  const allAttrs = [...(contact?.attributes ?? []), ...(contact?.companyAttrs ?? [])];
  const billingAttrs = allAttrs.filter((attr) => SUBSCRIPTION_KEY_PATTERN.test(attr.key));
  const otherAttrs = allAttrs.filter((attr) => !SUBSCRIPTION_KEY_PATTERN.test(attr.key));
  const planAttr =
    billingAttrs.find((attr) => /^plan$/i.test(attr.key.trim())) ??
    billingAttrs.find((attr) => /plan/i.test(attr.key) && !/price|id|stripe|revenue/i.test(attr.key)) ??
    null;

  const userRows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: "Name", value: contact?.name ?? "" },
    { label: "Company", value: (contact?.companies ?? []).join(", ") },
    { label: "Type", value: contact?.type ?? "" },
    { label: "Location", value: contact?.location ?? "" },
    { label: "Owner", value: contact?.owner ?? "" },
    { label: "Email", value: contact?.email ?? "", mono: true },
    { label: "Phone", value: contact?.phone ?? "" },
    { label: "User id", value: contact?.userId ?? "", mono: true },
    ...otherAttrs.map((attr) => ({ label: attr.key, value: attr.value })),
    { label: "Browser", value: contact?.browser ?? "" },
    { label: "Browser version", value: contact?.browserVersion ?? "" },
    { label: "OS", value: contact?.os ?? "" },
    { label: "Language", value: contact?.language ?? "" },
  ];
  // Filled facts first — important attributes must not hide behind "See all".
  const sortedUserRows = [
    ...userRows.filter((row) => row.value),
    ...userRows.filter((row) => !row.value),
  ];

  return (
    <>
      {contact ? <ContactCard contact={contact} tier={tier} spend={spend} /> : null}

      <div className={cn("py-1.5", contact && "border-t border-border/60")}>
        <DetailRow label="Assignee" value={details.assignee} placeholder="Unassigned" />
        <DetailRow label="Team Inbox" value={details.teamInbox} placeholder="—" />
      </div>

      {contact ? <BillingCard attrs={billingAttrs} planAttr={planAttr} /> : null}

      <DetailsSection
        title="Recent activity"
        icon={<Activity className="h-3.5 w-3.5 text-muted-foreground" />}
      >
        <DetailRow label="Last seen" value={formatTime(contact?.lastSeenAt ?? 0)} placeholder="—" />
        <DetailRow label="Signed up" value={formatDate(contact?.signedUpAt ?? 0)} placeholder="—" />
        {details.events.length > 0 ? (
          <div className="mt-1 space-y-1 px-3.5">
            {details.events.slice(0, 8).map((event, index) => (
              <p key={`${event.name}:${index}`} className="flex items-baseline gap-2 text-[11px]">
                <span className="w-9 shrink-0 text-muted-foreground/70">{ago(event.at)}</span>
                <span className="min-w-0 flex-1 truncate font-medium" title={event.name}>
                  {event.name}
                </span>
              </p>
            ))}
          </div>
        ) : null}
        <PageViewsBlock projectId={projectId} details={details} />
      </DetailsSection>

      {contact ? (
        <UserDataSection rows={sortedUserRows} />
      ) : (
        <DetailsSection
          title="User data"
          icon={<UserRound className="h-3.5 w-3.5 text-muted-foreground" />}
        >
          <p className="px-3.5 py-1 text-[11px] leading-relaxed text-muted-foreground">
            Intercom did not return a contact for this conversation.
          </p>
        </DetailsSection>
      )}

      <DetailsSection
        title="Conversation"
        icon={<MessagesSquare className="h-3.5 w-3.5 text-muted-foreground" />}
        defaultOpen={false}
      >
        <DetailRow
          label="State"
          value={details.state ? details.state.charAt(0).toUpperCase() + details.state.slice(1) : ""}
          placeholder="—"
        />
        {details.priority ? <DetailRow label="Priority" value="Priority" /> : null}
        <DetailRow label="Channel" value={details.channel} placeholder="—" />
        {details.subject ? <DetailRow label="Subject" value={details.subject} /> : null}
        <DetailRow label="Started" value={formatDate(details.createdAt)} placeholder="—" />
        <DetailRow label="Last activity" value={formatTime(details.updatedAt)} placeholder="—" />
        {details.waitingSince > 0 && details.state === "open" ? (
          <DetailRow label="Waiting" value={ago(details.waitingSince)} />
        ) : null}
        <DetailRow label="ID" value={`#${details.id}`} mono />
        {details.attributes.map((attr) => (
          <DetailRow key={attr.key} label={attr.key} value={attr.value} />
        ))}
        {details.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1 px-3.5 pt-1.5">
            {details.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border/70 bg-foreground/[0.03] px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </DetailsSection>
    </>
  );
}

/** Who the panel is about — avatar, identity, spend tier, and honest presence. */
function ContactCard({
  contact,
  tier,
  spend,
}: {
  contact: IntercomContactProfile;
  tier?: number | null;
  spend?: number | null;
}) {
  const seen = contact.lastSeenAt > 0 ? ago(contact.lastSeenAt) : "";
  const active = contact.lastSeenAt > 0 && Date.now() - contact.lastSeenAt < 10 * 60_000;
  return (
    <div className="flex items-center gap-2.5 px-3.5 pb-3 pt-3.5">
      <span
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ember/15 text-sm font-bold uppercase text-ember"
      >
        {(contact.name || contact.email || "?").trim().charAt(0) || "?"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <span className="min-w-0 truncate">
            {contact.name || contact.email || "Unknown contact"}
          </span>
          <TierBadge tier={tier} spend={spend} />
        </p>
        {contact.email ? (
          <p className="truncate text-[11px] text-muted-foreground">{contact.email}</p>
        ) : null}
        {seen ? (
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/80">
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                active ? "bg-emerald-500" : "bg-muted-foreground/40",
              )}
            />
            {seen === "now" ? "Active just now" : `Last seen ${seen} ago`}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Money facts stay loud: plan badge, billing attributes, debt in red. */
function BillingCard({
  attrs,
  planAttr,
}: {
  attrs: IntercomAttr[];
  planAttr: IntercomAttr | null;
}) {
  const rest = attrs.filter((attr) => attr !== planAttr);
  return (
    <div className="px-3 pb-3">
      <div className="rounded-2xl border border-ember/30 bg-ember/[0.06] pb-2 pt-2.5">
        <p className="flex items-center gap-1.5 px-3.5 pb-1 text-xs font-semibold">
          <CreditCard className="h-3.5 w-3.5 text-ember" />
          Subscription & payments
        </p>
        {planAttr ? (
          <div className="flex items-center justify-between gap-3 px-3.5 py-[5px]">
            <span className="shrink-0 text-[11px] text-muted-foreground">{planAttr.key}</span>
            <span className="rounded-full bg-ember px-2.5 py-0.5 text-[11px] font-bold text-ember-foreground">
              {planAttr.value}
            </span>
          </div>
        ) : null}
        {rest.map((attr) => (
          <DetailRow
            key={attr.key}
            label={attr.key}
            value={attr.value}
            danger={BALANCE_KEY_PATTERN.test(attr.key) && isNonZeroNumber(attr.value)}
          />
        ))}
        {attrs.length === 0 ? (
          <p className="px-3.5 py-1 text-[11px] leading-relaxed text-muted-foreground">
            No plan or billing attributes on this contact in Intercom yet.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** "User data" with Intercom's See-all folding past the first rows. */
function UserDataSection({
  rows,
}: {
  rows: Array<{ label: string; value: string; mono?: boolean }>;
}) {
  const [showAll, setShowAll] = useState<boolean>(false);
  const visible = showAll ? rows : rows.slice(0, 12);
  const hidden = rows.length - visible.length;
  return (
    <DetailsSection
      title="User data"
      icon={<UserRound className="h-3.5 w-3.5 text-muted-foreground" />}
    >
      {visible.map((row, index) => (
        <DetailRow
          key={`${row.label}:${index}`}
          label={row.label}
          value={row.value}
          mono={row.mono}
          placeholder="—"
        />
      ))}
      {hidden > 0 || showAll ? (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="px-3.5 pt-1.5 text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {showAll ? "Show less" : `See all (${hidden} more)`}
        </button>
      ) : null}
    </DetailsSection>
  );
}

/**
 * One label/value line; empty values render the placeholder (or hide the row),
 * URL values become clickable links, `danger` paints debt-like numbers red.
 */
/** "site.com/pricing" — scheme + www stripped for tight rows. */
function compactUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
}

/**
 * First-party "Recent page views" — Intercom's API keeps page views private,
 * so Gera tracks its own via the pv.js snippet on the customer's site.
 * Admins get a one-click setup dialog; members see an honest note, no fakes.
 */
function PageViewsBlock({ projectId, details }: { projectId: string; details: DeskConversationDetails }) {
  const [setupOpen, setSetupOpen] = useState<boolean>(false);
  const views = details.pageViews;

  return (
    <div className="mt-2 border-t border-border/40 pt-2" data-testid={TID.screenDeskPageViews}>
      <p className="flex items-center gap-1.5 px-3.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        <Globe className="h-3 w-3" />
        Recent page views
      </p>
      {views.length > 0 ? (
        <div className="space-y-1 px-3.5">
          {views.slice(0, 10).map((view, index) => (
            <p key={`${view.at}:${index}`} className="flex items-baseline gap-2 text-[11px]">
              <span className="w-9 shrink-0 text-muted-foreground/70">{ago(view.at)}</span>
              <a
                href={view.url}
                target="_blank"
                rel="noreferrer"
                title={view.title ? `${view.title} — ${view.url}` : view.url}
                className="min-w-0 flex-1 truncate font-medium underline-offset-2 hover:underline"
              >
                {compactUrl(view.url)}
              </a>
            </p>
          ))}
        </div>
      ) : (
        <p className="px-3.5 text-[10px] leading-relaxed text-muted-foreground/70">
          {details.tracking
            ? "The tracking snippet is live, but no views are recorded for this contact yet — visits appear once they browse your site while identified."
            : details.viewerIsAdmin
              ? "Intercom's API keeps page views private. Add Gera's snippet to your site to track them here."
              : "Intercom's API keeps page views private — ask a project admin to set up Gera's tracking snippet."}
        </p>
      )}
      {details.viewerIsAdmin && views.length === 0 ? (
        <div className="px-3.5 pt-1.5">
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-foreground/5"
          >
            {details.tracking ? "Get the snippet" : "Set up page views"}
          </button>
        </div>
      ) : null}
      {setupOpen ? <TrackingSetupDialog projectId={projectId} onClose={() => setSetupOpen(false)} /> : null}
    </div>
  );
}

/** Admin dialog: creates the write-only beacon key and shows the paste-ready snippet. */
function TrackingSetupDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const setupQuery = useQuery({
    queryKey: ["desk-tracking-key", projectId],
    retry: false,
    staleTime: Infinity,
    queryFn: () => setupDeskTracking(projectId),
  });
  const snippet = setupQuery.data ? deskTrackerSnippet(projectId, setupQuery.data.key) : "";

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success("Snippet copied");
    } catch {
      toast.error("Could not copy — select the code manually");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg" data-testid={TID.screenDeskTrackingSetup}>
        <DialogHeader>
          <DialogTitle>Track page views</DialogTitle>
          <DialogDescription>
            Intercom's API does not share page views, so Gera collects its own. Paste this snippet
            into your site's HTML — before &lt;/body&gt; or via your tag manager.
          </DialogDescription>
        </DialogHeader>
        {setupQuery.isLoading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Creating the project's tracking key…
          </div>
        ) : setupQuery.isError ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-xs font-medium leading-relaxed text-amber-800">
              {setupQuery.error instanceof Error
                ? setupQuery.error.message
                : "Could not create the tracking key."}
            </p>
            <button
              type="button"
              onClick={() => void setupQuery.refetch()}
              className="mt-2 rounded-full border border-amber-600/40 px-2.5 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-500/20"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-muted/40 p-3 pr-11 text-[11px] leading-relaxed">
                {snippet}
              </pre>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Copy snippet"
                onClick={() => void copySnippet()}
                className="absolute right-1.5 top-1.5 h-7 w-7"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <ul className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <li>
                • Visitors are identified automatically from Intercom Messenger
                (window.intercomSettings); on pages without it, call
                window.geraPageViews.identify("email") after login.
              </li>
              <li>
                • Single-page route changes are tracked too; pages viewed before sign-in are
                buffered in the browser and reported once the visitor is identified.
              </li>
              <li>
                • Only identified visitors appear — the email or user id must match the Intercom
                contact. Views are kept 30 days, newest 40 per contact.
              </li>
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
  placeholder,
  danger = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  placeholder?: string;
  danger?: boolean;
}) {
  if (!value && placeholder === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (URL_VALUE_PATTERN.test(trimmed)) {
    return (
      <div className="flex items-baseline justify-between gap-3 px-3.5 py-[5px]">
        <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
        <a
          href={trimmed}
          target="_blank"
          rel="noreferrer"
          title={trimmed}
          className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-sky-600 hover:underline"
        >
          <span className="truncate">{trimmed.replace(/^https?:\/\//i, "")}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      </div>
    );
  }
  return (
    <div className="flex items-baseline justify-between gap-3 px-3.5 py-[5px]">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        title={value || undefined}
        className={cn(
          "min-w-0 select-text break-words text-right text-[11px] font-medium",
          mono && "font-mono text-[10.5px]",
          danger && "font-semibold text-red-600",
          !value && "text-muted-foreground/60",
        )}
      >
        {value || placeholder}
      </span>
    </div>
  );
}

/** Collapsible section with an Intercom-style chevron header. */
function DetailsSection({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [openState, setOpenState] = useState<boolean>(defaultOpen);
  return (
    <div className="border-t border-border/60">
      <button
        type="button"
        onClick={() => setOpenState(!openState)}
        aria-expanded={openState}
        className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{title}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            !openState && "-rotate-90",
          )}
        />
      </button>
      {openState ? <div className="pb-2">{children}</div> : null}
    </div>
  );
}
