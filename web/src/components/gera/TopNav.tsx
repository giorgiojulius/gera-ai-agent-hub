import {
  ChevronDown,
  EyeOff,
  Ghost,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Share2,
  Trash2,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { ShareDialog } from "@/components/gera/ShareDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgent } from "@/hooks/use-agent";
import { cn } from "@/lib/utils";

/**
 * Slim content header, Claude-style: sidebar toggle (mobile always, desktop
 * only when collapsed), the thread title with its actions menu, and Share.
 */
export function TopNav({
  sidebarCollapsed,
  onOpenNav,
}: {
  sidebarCollapsed: boolean;
  onOpenNav: () => void;
}) {
  const { state, active, newChat, togglePinChat, markUnreadChat, renameChat, deleteChat } =
    useAgent();
  const [shareOpen, setShareOpen] = useState<boolean>(false);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [renaming, setRenaming] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");
  // Keeps the rename input focused instead of the menu returning focus to its trigger.
  const renamePendingRef = useRef<boolean>(false);

  const isIncognito = active?.incognito === true;
  const canShare = (active?.messages.length ?? 0) > 0 && !isIncognito;
  const attention = state.runningIds.length > 0 || state.unreadIds.length > 0;

  const startRename = () => {
    if (!active) {
      return;
    }
    setDraft(active.title);
    renamePendingRef.current = true;
    setRenaming(true);
  };

  const commitRename = () => {
    if (active) {
      const title = draft.trim();
      if (title && title !== active.title) {
        renameChat(active.id, title);
      }
    }
    setRenaming(false);
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!active) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "p" && !isIncognito) {
      event.preventDefault();
      setMenuOpen(false);
      togglePinChat(active.id);
    } else if (key === "u" && active.messages.length > 0) {
      event.preventDefault();
      setMenuOpen(false);
      markUnreadChat(active.id);
    } else if (key === "r") {
      event.preventDefault();
      setMenuOpen(false);
      startRename();
    } else if (key === "d") {
      event.preventDefault();
      setMenuOpen(false);
      deleteChat(active.id);
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 bg-background/70 px-2 backdrop-blur-xl sm:px-3">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open sidebar"
        title="Open sidebar · ⌘B"
        onClick={onOpenNav}
        className={cn(
          "relative h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground",
          !sidebarCollapsed && "lg:hidden",
        )}
      >
        <PanelLeft className="h-4 w-4" />
        {attention ? (
          <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-ember ring-2 ring-background" />
        ) : null}
      </Button>

      {renaming && active ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename();
            } else if (event.key === "Escape") {
              setRenaming(false);
            }
          }}
          aria-label="Chat title"
          className="h-8 w-[min(420px,60vw)] rounded-lg border border-ember/50 bg-white px-2.5 text-sm font-medium outline-none"
        />
      ) : active && active.messages.length > 0 ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-left text-sm font-medium transition-colors hover:bg-foreground/5 data-[state=open]:bg-foreground/5"
            >
              {active.pinned ? <Pin className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
              <span className="truncate">{active.title}</span>
              {isIncognito ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-medium text-background">
                  <Ghost className="h-3 w-3" />
                  Incognito
                </span>
              ) : null}
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={6}
            onKeyDown={onMenuKeyDown}
            onCloseAutoFocus={(event) => {
              if (renamePendingRef.current) {
                event.preventDefault();
                renamePendingRef.current = false;
              }
            }}
            className="w-56 rounded-2xl border-border/70 p-1.5"
          >
            {!isIncognito ? (
              <DropdownMenuItem onSelect={() => togglePinChat(active.id)} className="gap-2 rounded-xl">
                {active.pinned ? (
                  <PinOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Pin className="h-4 w-4 text-muted-foreground" />
                )}
                {active.pinned ? "Unpin" : "Pin"}
                <DropdownMenuShortcut>P</DropdownMenuShortcut>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={active.messages.length === 0}
              onSelect={() => markUnreadChat(active.id)}
              className="gap-2 rounded-xl"
            >
              <EyeOff className="h-4 w-4 text-muted-foreground" />
              Mark as unread
              <DropdownMenuShortcut>U</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={startRename} className="gap-2 rounded-xl">
              <Pencil className="h-4 w-4 text-muted-foreground" />
              Rename
              <DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-border/60" />
            <DropdownMenuItem
              onSelect={() => deleteChat(active.id)}
              className="gap-2 rounded-xl text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Delete
              <DropdownMenuShortcut>D</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : isIncognito ? (
        <span className="px-2 text-sm font-medium text-muted-foreground">Incognito chat</span>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {canShare ? (
          <Button
            variant="ghost"
            onClick={() => setShareOpen(true)}
            className="h-8 gap-1.5 rounded-lg border border-border/70 bg-card px-3 text-sm shadow-sm hover:bg-secondary/70"
          >
            <Share2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Share</span>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => newChat({ incognito: true })}
          aria-label="New incognito chat"
          title="Incognito chat — never saved · ⌘⇧N"
          className={cn(
            "h-8 w-8 rounded-full text-muted-foreground hover:text-foreground",
            isIncognito && "bg-foreground text-background hover:bg-foreground/85 hover:text-background",
          )}
        >
          <Ghost className="h-4 w-4" />
        </Button>
      </div>
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
    </header>
  );
}
