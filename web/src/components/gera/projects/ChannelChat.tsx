// One project channel: message list with Slack-style threads, a composer
// with @agent mention autocomplete, unread marking, and 4s polling (honest —
// no fake realtime). Agent replies appear as pending rows until the run in
// the project shard fills them.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Hash, Loader2, MessageSquareText, SendHorizontal, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { toast } from "sonner";

import { MarkdownBody } from "@/components/gera/Markdown";
import {
  fetchProjectMessages,
  markProjectChannelRead,
  postProjectMessage,
  type ProjectAgent,
  type ProjectChannel,
  type ProjectMessage,
  type ProjectOverview,
  type ThreadStat,
} from "@/lib/projects";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

type MessagesCache = {
  messages: ProjectMessage[];
  threads: ThreadStat[];
  cursor: number;
};

const KEEP_MESSAGES = 400;

function formatTime(at: number): string {
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

export function ChannelChat({
  projectId,
  channel,
  channels,
  onSelectChannel,
  agents,
  meEmail,
}: {
  projectId: string;
  channel: ProjectChannel;
  channels: ProjectChannel[];
  onSelectChannel: (id: string) => void;
  agents: ProjectAgent[];
  meEmail: string;
}) {
  const queryClient = useQueryClient();
  // The open thread lives in the address (?thread=<root id>) — deep-linkable,
  // and the browser Back button closes it naturally on mobile.
  const [searchParams, setSearchParams] = useSearchParams();
  const threadRoot = searchParams.get("thread");
  const setThreadRoot = useCallback(
    (id: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) {
            next.set("thread", id);
          } else {
            next.delete("thread");
          }
          return next;
        },
        { replace: id === null },
      );
    },
    [setSearchParams],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef<boolean>(true);

  const messagesKey = useMemo(
    () => ["project-msgs", projectId, channel.id] as const,
    [projectId, channel.id],
  );

  const messagesQuery = useQuery<MessagesCache>({
    queryKey: messagesKey,
    refetchInterval: 4_000,
    // Delta poll: only rows updated since the cursor travel; the cache merges.
    queryFn: async () => {
      const prev = queryClient.getQueryData<MessagesCache>(messagesKey);
      const since = prev?.cursor ?? 0;
      const page = await fetchProjectMessages(projectId, channel.id, since > 0 ? { since } : undefined);
      const map = new Map<string, ProjectMessage>((prev?.messages ?? []).map((item) => [item.id, item]));
      for (const item of page.messages) {
        map.set(item.id, item);
      }
      const merged = [...map.values()].sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      );
      let cursor = since;
      for (const item of page.messages) {
        cursor = Math.max(cursor, item.updatedAt);
      }
      return { messages: merged.slice(-KEEP_MESSAGES), threads: page.threads, cursor };
    },
  });

  const messages = useMemo(() => messagesQuery.data?.messages ?? [], [messagesQuery.data]);
  const threadStats = useMemo(() => {
    const map = new Map<string, ThreadStat>();
    for (const stat of messagesQuery.data?.threads ?? []) {
      map.set(stat.root, stat);
    }
    return map;
  }, [messagesQuery.data]);
  const roots = useMemo(() => messages.filter((item) => item.rootId === null), [messages]);

  const threadQuery = useQuery({
    queryKey: ["project-thread", projectId, channel.id, threadRoot ?? "none"],
    enabled: threadRoot !== null,
    refetchInterval: 3_500,
    queryFn: () => fetchProjectMessages(projectId, channel.id, { root: threadRoot ?? "" }),
  });

  // Mark the channel read while it is on a visible screen.
  const lastAt = messages.length > 0 ? messages[messages.length - 1].createdAt : 0;
  useEffect(() => {
    if (lastAt === 0) {
      return;
    }
    const mark = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void markProjectChannelRead(projectId, channel.id, lastAt);
      queryClient.setQueryData<ProjectOverview>(["project", projectId], (old) =>
        old
          ? {
              ...old,
              channels: old.channels.map((item) =>
                item.id === channel.id ? { ...item, unread: 0 } : item,
              ),
            }
          : old,
      );
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => {
      document.removeEventListener("visibilitychange", mark);
    };
  }, [lastAt, channel.id, projectId, queryClient]);

  // Stick to the bottom unless the reader scrolled up.
  useEffect(() => {
    const node = listRef.current;
    if (node && stickToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, lastAt]);

  const onListScroll = useCallback(() => {
    const node = listRef.current;
    if (!node) {
      return;
    }
    stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 140;
  }, []);

  const send = useCallback(
    async (body: string, rootId?: string) => {
      const result = await postProjectMessage(projectId, {
        channelId: channel.id,
        ...(rootId ? { rootId } : {}),
        body,
      });
      stickToBottomRef.current = true;
      await queryClient.invalidateQueries({ queryKey: messagesKey });
      if (rootId) {
        void queryClient.invalidateQueries({
          queryKey: ["project-thread", projectId, channel.id, rootId],
        });
      } else if (result.jobs.length > 0) {
        // The mention summoned an agent — its reply lands in this thread.
        setThreadRoot(result.id);
      }
    },
    [projectId, channel.id, queryClient, messagesKey, setThreadRoot],
  );

  const threadRootMessage = threadRoot
    ? (threadQuery.data?.messages ?? []).find((item) => item.id === threadRoot) ??
      messages.find((item) => item.id === threadRoot) ??
      null
    : null;
  const threadReplies = threadRoot
    ? (threadQuery.data?.messages ?? []).filter((item) => item.id !== threadRoot)
    : [];

  return (
    <div className="flex min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">
        {/* Mobile channel switcher */}
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2 lg:hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {channels.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectChannel(item.id)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                item.id === channel.id
                  ? "border-foreground/20 bg-foreground/[0.07] font-medium"
                  : "border-border/70 text-muted-foreground",
              )}
            >
              <Hash className="h-3 w-3 opacity-60" />
              {item.name}
              {item.unread > 0 && item.id !== channel.id ? (
                <span className="rounded-full bg-ember px-1.5 py-px text-[10px] font-semibold leading-none text-ember-foreground">
                  {item.unread > 99 ? "99+" : item.unread}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* Channel header */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 truncate text-sm font-semibold">{channel.name}</p>
          {channel.topic ? (
            <p className="min-w-0 truncate text-xs text-muted-foreground">· {channel.topic}</p>
          ) : null}
        </div>

        {/* Messages */}
        <div ref={listRef} onScroll={onListScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {messagesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading messages…
            </div>
          ) : roots.length === 0 ? (
            <div className="mx-auto max-w-sm py-10 text-center">
              <p className="text-sm font-medium">It's quiet in #{channel.name}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                Write the first message.
                {agents.length > 0
                  ? ` Mention ${agents
                      .slice(0, 3)
                      .map((agent) => `@${agent.handle}`)
                      .join(" or ")} to summon an agent — it answers in a thread.`
                  : " Admins can add scoped agents on the Agents tab."}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {roots.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  agents={agents}
                  meEmail={meEmail}
                  stat={threadStats.get(message.id) ?? null}
                  onOpenThread={() => setThreadRoot(message.id)}
                />
              ))}
            </div>
          )}
        </div>

        <Composer
          agents={agents}
          placeholder={`Message #${channel.name}${agents.length > 0 ? " — @agent to summon" : ""}`}
          testId={TID.projectComposer}
          onSend={(body) => send(body)}
        />
      </section>

      {/* Thread pane */}
      {threadRoot !== null ? (
        <aside className="fixed inset-0 z-40 flex flex-col border-border/60 bg-background lg:static lg:z-auto lg:w-[380px] lg:shrink-0 lg:border-l">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4">
            <MessageSquareText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">Thread</p>
            <button
              type="button"
              aria-label="Close thread"
              onClick={() => setThreadRoot(null)}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {threadRootMessage ? (
              <MessageRow
                message={threadRootMessage}
                agents={agents}
                meEmail={meEmail}
                stat={null}
                inThread
              />
            ) : null}
            {threadReplies.length > 0 ? (
              <div className="mt-2 space-y-1 border-l-2 border-border/60 pl-3">
                {threadReplies.map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    agents={agents}
                    meEmail={meEmail}
                    stat={null}
                    inThread
                  />
                ))}
              </div>
            ) : threadQuery.isLoading ? (
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading thread…
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">No replies yet.</p>
            )}
          </div>
          <Composer
            agents={agents}
            placeholder="Reply in thread — @agent to summon"
            onSend={(body) => send(body, threadRoot)}
          />
        </aside>
      ) : null}
    </div>
  );
}

function MessageRow({
  message,
  agents,
  meEmail,
  stat,
  onOpenThread,
  inThread = false,
}: {
  message: ProjectMessage;
  agents: ProjectAgent[];
  meEmail: string;
  stat: ThreadStat | null;
  onOpenThread?: () => void;
  inThread?: boolean;
}) {
  const isAgent = message.kind === "agent";
  const agent = isAgent ? agents.find((item) => item.id === message.author) : undefined;
  const mine = !isAgent && message.author === meEmail;
  return (
    <div className="group rounded-2xl px-2 py-1.5 transition-colors hover:bg-foreground/[0.03]">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            isAgent ? "bg-ember/10 text-ember" : "bg-foreground/[0.07] text-muted-foreground",
          )}
        >
          {isAgent ? (
            agent?.emoji ? (
              <span className="text-sm leading-none">{agent.emoji}</span>
            ) : (
              <Bot className="h-3.5 w-3.5" />
            )
          ) : (
            (message.authorName || "?").slice(0, 1).toUpperCase()
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <span className="font-semibold">{mine ? "You" : message.authorName}</span>
            {isAgent ? (
              <span className="rounded-full bg-ember/10 px-1.5 py-px text-[10px] font-medium text-ember">
                agent
              </span>
            ) : null}
            <span className="text-[11px] text-muted-foreground/80">{formatTime(message.createdAt)}</span>
          </p>
          {message.pending ? (
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              thinking…
            </p>
          ) : isAgent ? (
            <MarkdownBody text={message.body} className="mt-0.5 text-sm" />
          ) : (
            <UserBody body={message.body} agents={agents} />
          )}
          {!inThread ? (
            stat && stat.count > 0 ? (
              <button
                type="button"
                onClick={onOpenThread}
                className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                <MessageSquareText className="h-3 w-3" />
                {stat.count} {stat.count === 1 ? "reply" : "replies"} · {formatTime(stat.lastAt)}
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenThread}
                className="mt-1 hidden items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground group-hover:inline-flex"
              >
                <MessageSquareText className="h-3 w-3" />
                Reply in thread
              </button>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Plain text with line breaks and highlighted @agent mentions. */
function UserBody({ body, agents }: { body: string; agents: ProjectAgent[] }) {
  const parts = useMemo(() => {
    if (agents.length === 0 || !body.includes("@")) {
      return [{ text: body, mention: false }];
    }
    const handles = agents
      .map((agent) => agent.handle)
      .filter((handle) => handle.length > 0)
      .sort((a, b) => b.length - a.length)
      .map((handle) => handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`@(?:${handles.join("|")})(?![A-Za-z0-9-])`, "gi");
    const out: Array<{ text: string; mention: boolean }> = [];
    let cursor = 0;
    for (const match of body.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) {
        out.push({ text: body.slice(cursor, index), mention: false });
      }
      out.push({ text: match[0], mention: true });
      cursor = index + match[0].length;
    }
    if (cursor < body.length) {
      out.push({ text: body.slice(cursor), mention: false });
    }
    return out;
  }, [body, agents]);
  return (
    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
      {parts.map((part, index) =>
        part.mention ? (
          <span key={index} className="rounded bg-ember/10 px-1 py-0.5 font-medium text-ember">
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

/** Textarea with @agent autocomplete; Enter sends, Shift+Enter breaks. */
function Composer({
  agents,
  placeholder,
  onSend,
  testId,
}: {
  agents: ProjectAgent[];
  placeholder: string;
  onSend: (body: string) => Promise<void>;
  testId?: string;
}) {
  const [text, setText] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [highlightIndex, setHighlightIndex] = useState<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const matches = useMemo(() => {
    if (mentionQuery === null) {
      return [];
    }
    const query = mentionQuery.toLowerCase();
    return agents
      .filter(
        (agent) =>
          agent.handle.toLowerCase().startsWith(query) ||
          agent.name.toLowerCase().startsWith(query),
      )
      .slice(0, 6);
  }, [agents, mentionQuery]);

  const detectMention = useCallback(
    (value: string, caret: number) => {
      if (agents.length === 0) {
        setMentionQuery(null);
        return;
      }
      const before = value.slice(0, caret);
      const match = /(^|\s)@([a-z0-9-]*)$/i.exec(before);
      setMentionQuery(match ? match[2] : null);
      setHighlightIndex(0);
    },
    [agents.length],
  );

  const insertMention = useCallback(
    (agent: ProjectAgent) => {
      const node = textareaRef.current;
      const caret = node ? node.selectionStart : text.length;
      const before = text.slice(0, caret);
      const after = text.slice(caret);
      const replaced = before.replace(/@[a-z0-9-]*$/i, `@${agent.handle} `);
      const next = `${replaced}${after}`;
      setText(next);
      setMentionQuery(null);
      requestAnimationFrame(() => {
        if (node) {
          node.focus();
          const position = replaced.length;
          node.setSelectionRange(position, position);
        }
      });
    },
    [text],
  );

  const submit = useCallback(async () => {
    const body = text.trim();
    if (body.length === 0 || sending) {
      return;
    }
    setSending(true);
    try {
      await onSend(body);
      setText("");
      setMentionQuery(null);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node) {
          node.style.height = "auto";
          node.focus();
        }
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the message");
    } finally {
      setSending(false);
    }
  }, [text, sending, onSend]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && matches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(matches[highlightIndex] ?? matches[0]);
        return;
      }
      if (event.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="relative shrink-0 border-t border-border/60 p-3">
      {mentionQuery !== null && matches.length > 0 ? (
        <div className="absolute bottom-full left-3 z-10 mb-1 w-72 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-lg">
          {matches.map((agent, index) => (
            <button
              key={agent.id}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                insertMention(agent);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
                index === highlightIndex ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.04]",
              )}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ember/10 text-xs">
                {agent.emoji || <Bot className="h-3 w-3 text-ember" />}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">@{agent.handle}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-2 rounded-2xl border border-border/70 bg-card px-3 py-2 shadow-sm focus-within:border-foreground/25">
        <textarea
          ref={textareaRef}
          data-testid={testId}
          value={text}
          rows={1}
          maxLength={8_000}
          placeholder={placeholder}
          onChange={(event) => {
            setText(event.target.value);
            detectMention(event.target.value, event.target.selectionStart);
            const node = event.target;
            node.style.height = "auto";
            node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setMentionQuery(null)}
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground/70"
        />
        <button
          type="button"
          aria-label="Send"
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
        Enter to send · Shift+Enter for a new line · updates every ~4s
      </p>
    </div>
  );
}
