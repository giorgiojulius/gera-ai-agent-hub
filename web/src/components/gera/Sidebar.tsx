import {
  Bot,
  FolderKanban,
  Ghost,
  Loader2,
  NotebookPen,
  PanelLeftClose,
  Pin,
  PinOff,
  Plug,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { AccountMenu } from "@/components/gera/AccountMenu";
import { SparkMark } from "@/components/gera/Spark";
import { useAgent } from "@/hooks/use-agent";
import { TID } from "@/lib/testids";
import type { Automation, Conversation } from "@/lib/types";
import { cn } from "@/lib/utils";

function threadMatches(item: Conversation, q: string): boolean {
  if (!q) {
    return true;
  }
  return `${item.title} ${item.messages[0]?.content ?? ""}`.toLowerCase().includes(q);
}

/** Compact countdown for the Scheduled section: "soon", "in 25m", "in 3h", "in 2d". */
function nextRunLabel(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 60_000) {
    return "soon";
  }
  if (diff < 3_600_000) {
    return `in ${Math.round(diff / 60_000)}m`;
  }
  if (diff < 86_400_000) {
    return `in ${Math.round(diff / 3_600_000)}h`;
  }
  return `in ${Math.round(diff / 86_400_000)}d`;
}

/**
 * Claude-desktop-style navigation rail: brand row, primary actions, then
 * Scheduled / Pinned / Chats, with the account docked at the bottom.
 * Rendered persistently on desktop (with a collapse control) and inside a
 * Sheet on mobile (no `onCollapse`).
 */
export function Sidebar({ onCollapse }: { onCollapse?: () => void }) {
  const {
    state,
    active,
    automations,
    newChat,
    selectChat,
    deleteChat,
    togglePinChat,
    setSidebarOpen,
  } = useAgent();
  const navigate = useNavigate();
  const [query, setQuery] = useState<string>("");
  const q = query.trim().toLowerCase();

  // Blank drafts (no messages yet) are not real threads — they only enter the
  // list once the first message is sent. `newChat` reuses the same draft, so
  // nothing is lost by hiding it here.
  const pinned = useMemo(
    () =>
      state.conversations
        .filter(
          (item) =>
            item.messages.length > 0 && item.pinned === true && item.incognito !== true && threadMatches(item, q),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [state.conversations, q],
  );

  const incognitoThreads = useMemo(
    () =>
      state.conversations
        .filter((item) => item.messages.length > 0 && item.incognito === true && threadMatches(item, q))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [state.conversations, q],
  );

  const chats = useMemo(
    () =>
      state.conversations
        .filter(
          (item) =>
            item.messages.length > 0 && item.pinned !== true && item.incognito !== true && threadMatches(item, q),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [state.conversations, q],
  );

  const scheduled = useMemo(() => {
    const list = automations.filter((item) => (q ? item.name.toLowerCase().includes(q) : true));
    return [...list].sort(
      (a, b) => Number(b.enabled) - Number(a.enabled) || a.nextRunAt - b.nextRunAt,
    );
  }, [automations, q]);

  const openScheduled = (automation: Automation) => {
    const exists = state.conversations.some((item) => item.id === automation.conversationId);
    if (exists) {
      selectChat(automation.conversationId);
    } else {
      setSidebarOpen(false);
      navigate("/automations");
    }
  };

  return (
    <aside className="flex h-full w-full flex-col">
      <div className={cn("flex h-14 shrink-0 items-center gap-2.5 pl-[18px] pr-3", !onCollapse && "pr-12")}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <SparkMark className="h-5 w-5" />
        </span>
        <p className="font-brand text-[19px] font-semibold leading-none tracking-tight">Gera</p>
        {state.runningIds.length > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-ember/40 bg-ember/10 px-2 py-0.5 text-[10px] font-medium text-ember">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            {state.runningIds.length}
          </span>
        ) : null}
        {onCollapse ? (
          <button
            type="button"
            aria-label="Collapse sidebar"
            title="Collapse sidebar · ⌘B"
            onClick={onCollapse}
            className="ml-auto rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <nav className="px-2">
        <button
          type="button"
          data-testid={TID.sidebarNewChat}
          onClick={() => {
            newChat();
            setSidebarOpen(false);
          }}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors hover:bg-foreground/5"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07]">
            <Plus className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} />
          </span>
          New chat
          <span className="ml-auto text-[10px] text-muted-foreground/70">⌘N</span>
        </button>
        <NavRow
          icon={Bot}
          label="Profiles"
          onClick={() => {
            setSidebarOpen(false);
            navigate("/profiles");
          }}
        />
        <NavRow
          icon={Sparkles}
          label="Skills"
          onClick={() => {
            setSidebarOpen(false);
            navigate("/skills");
          }}
        />
        <NavRow
          icon={FolderKanban}
          label="Projects"
          onClick={() => {
            setSidebarOpen(false);
            navigate("/projects");
          }}
        />
        <NavRow
          icon={Zap}
          label="Automations"
          onClick={() => {
            setSidebarOpen(false);
            navigate("/automations");
          }}
        />
        <NavRow
          icon={NotebookPen}
          label="Hub"
          onClick={() => {
            setSidebarOpen(false);
            navigate("/hub");
          }}
        />
        <NavRow
          icon={Plug}
          label="MCP"
          onClick={() => {
            setSidebarOpen(false);
            navigate("/mcp");
          }}
        />
      </nav>

      <div className="relative mx-3 mt-2.5">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search chats"
          className="h-8 w-full rounded-lg border border-transparent bg-foreground/[0.04] pl-8 pr-2 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-border focus:bg-white"
        />
      </div>

      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {scheduled.length > 0 ? (
          <section className="mb-1">
            <p className="px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">Scheduled</p>
            {scheduled.map((automation) => {
              const running = state.runningIds.includes(automation.conversationId);
              const unread = state.unreadIds.includes(automation.conversationId);
              return (
                <button
                  key={automation.id}
                  type="button"
                  onClick={() => openScheduled(automation)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm transition-colors hover:bg-foreground/[0.04]"
                >
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      automation.enabled ? "bg-ember" : "border border-muted-foreground/40",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{automation.name}</span>
                  {running ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ember" aria-label="Running" />
                  ) : unread ? (
                    <span className="shrink-0 rounded-full bg-ember/10 px-1.5 py-0.5 text-[10px] font-medium text-ember">
                      new
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {automation.enabled ? nextRunLabel(automation.nextRunAt) : "paused"}
                    </span>
                  )}
                </button>
              );
            })}
          </section>
        ) : null}

        {incognitoThreads.length > 0 ? (
          <section className="mb-1">
            <p
              title="Not saved — disappears when you close or reload the tab"
              className="flex items-center gap-1 px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground"
            >
              <Ghost className="h-3 w-3" />
              Incognito
            </p>
            {incognitoThreads.map((item) => (
              <ThreadRow
                key={item.id}
                item={item}
                selected={item.id === active?.id}
                running={state.runningIds.includes(item.id)}
                unread={state.unreadIds.includes(item.id)}
                hidePin
                onSelect={() => selectChat(item.id)}
                onTogglePin={() => togglePinChat(item.id)}
                onDelete={() => deleteChat(item.id)}
              />
            ))}
          </section>
        ) : null}

        {pinned.length > 0 ? (
          <section className="mb-1">
            <p className="px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">Pinned</p>
            {pinned.map((item) => (
              <ThreadRow
                key={item.id}
                item={item}
                selected={item.id === active?.id}
                running={state.runningIds.includes(item.id)}
                unread={state.unreadIds.includes(item.id)}
                onSelect={() => selectChat(item.id)}
                onTogglePin={() => togglePinChat(item.id)}
                onDelete={() => deleteChat(item.id)}
              />
            ))}
          </section>
        ) : null}

        <section>
          <p className="px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">Chats</p>
          {chats.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {q ? "No matches." : "No threads yet. Start one."}
            </p>
          ) : (
            chats.map((item) => (
              <ThreadRow
                key={item.id}
                item={item}
                selected={item.id === active?.id}
                running={state.runningIds.includes(item.id)}
                unread={state.unreadIds.includes(item.id)}
                onSelect={() => selectChat(item.id)}
                onTogglePin={() => togglePinChat(item.id)}
                onDelete={() => deleteChat(item.id)}
              />
            ))
          )}
        </section>
      </div>

      <div className="shrink-0 border-t border-border/50 p-2">
        <AccountMenu variant="row" />
      </div>
    </aside>
  );
}

function NavRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Bot;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors hover:bg-foreground/5"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </span>
      {label}
    </button>
  );
}

function ThreadRow({
  item,
  selected,
  running,
  unread,
  hidePin,
  onSelect,
  onTogglePin,
  onDelete,
}: {
  item: Conversation;
  selected: boolean;
  running: boolean;
  unread: boolean;
  /** Incognito rows: pinning a thread that vanishes on reload makes no sense. */
  hidePin?: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      data-testid={TID.sidebarThread}
      className={cn(
        "group mb-0.5 flex items-center rounded-xl pr-1 transition-colors",
        selected ? "bg-white shadow-sm" : "hover:bg-foreground/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left text-sm"
      >
        {item.automationId ? (
          <Zap className="h-3 w-3 shrink-0 text-ember/70" aria-label="Automation thread" />
        ) : null}
        <span className="truncate">{item.title}</span>
      </button>
      {running ? (
        <Loader2 className="mr-1 h-3.5 w-3.5 shrink-0 animate-spin text-ember" aria-label="Running" />
      ) : unread ? (
        <span className="mr-1 h-2 w-2 shrink-0 rounded-full bg-ember" aria-label="Unread" />
      ) : null}
      {!hidePin ? (
        <button
          type="button"
          aria-label={item.pinned ? "Unpin thread" : "Pin thread"}
          title={item.pinned ? "Unpin" : "Pin"}
          onClick={onTogglePin}
          className="rounded-lg p-1.5 text-muted-foreground transition-opacity hover:text-foreground lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover:opacity-100"
        >
          {item.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Delete thread"
        title="Delete"
        onClick={onDelete}
        className="rounded-lg p-1.5 text-muted-foreground transition-opacity hover:text-destructive lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
