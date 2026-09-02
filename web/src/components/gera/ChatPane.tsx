import { ArrowDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Composer } from "@/components/gera/Composer";
import { Launchpad } from "@/components/gera/Launchpad";
import { MessageList } from "@/components/gera/MessageList";
import { RepoPreviewPanel } from "@/components/gera/RepoPreviewPanel";
import { useAgent } from "@/hooks/use-agent";
import { usePreviewPanel } from "@/hooks/use-preview-panel";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

/** Distance from the bottom (px) beyond which the jump-to-latest arrow shows. */
const JUMP_THRESHOLD_PX = 200;

const PANEL_RATIO_KEY = "gera.preview.ratio.v1";
/** v0 proportions: the preview takes a bit more than half of the content column. */
const PANEL_DEFAULT_RATIO = 0.58;
/** Neither side may collapse below a usable width while dragging the divider. */
const PANEL_MIN_PX = 380;
const CHAT_MIN_PX = 360;

function readPanelRatio(): number {
  try {
    const raw = Number(window.localStorage.getItem(PANEL_RATIO_KEY));
    if (Number.isFinite(raw) && raw > 0.2 && raw < 0.85) {
      return raw;
    }
  } catch {
    // fall through to the default
  }
  return PANEL_DEFAULT_RATIO;
}

function persistPanelRatio(ratio: number) {
  try {
    window.localStorage.setItem(PANEL_RATIO_KEY, ratio.toFixed(3));
  } catch {
    // The preference just won't stick — nothing to surface.
  }
}

export function ChatPane() {
  const { active, state } = useAgent();
  const panel = usePreviewPanel();
  const messages = active?.messages ?? [];
  const streaming = active ? state.runningIds.includes(active.id) : false;
  const activeId = active?.id ?? null;
  const dockedJob = panel && panel.isDesktop ? panel.openJob : null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingJumpRef = useRef<boolean>(true);
  const [awayFromBottom, setAwayFromBottom] = useState<boolean>(false);

  // Preview dock width as a share of the content column; dragged and persisted per device.
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [panelRatio, setPanelRatio] = useState<number>(readPanelRatio);
  const [resizing, setResizing] = useState<boolean>(false);
  const ratioRef = useRef<number>(panelRatio);
  const dragRef = useRef<{ startX: number; startRatio: number; width: number } | null>(null);

  // The scroller mounts later than the pane when a fresh chat gets its first
  // message (Launchpad swaps for the list) — honor the pending jump then.
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    if (node && pendingJumpRef.current) {
      node.scrollTop = node.scrollHeight;
      pendingJumpRef.current = false;
    }
  }, []);

  // Opening or switching a chat always lands on the newest messages —
  // before paint, so the old position never flashes.
  useLayoutEffect(() => {
    pendingJumpRef.current = true;
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
      pendingJumpRef.current = false;
    }
    setAwayFromBottom(false);
  }, [activeId]);

  const measure = useCallback(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setAwayFromBottom(distance > JUMP_THRESHOLD_PX);
  }, []);

  // Streamed replies grow the thread below the fold without a scroll event —
  // re-measure after every render so the arrow appears exactly when needed.
  useEffect(() => {
    measure();
  });

  const jumpToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const onSplitStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const width = splitRef.current?.getBoundingClientRect().width ?? 0;
      if (width <= 0) {
        return;
      }
      event.preventDefault();
      dragRef.current = { startX: event.clientX, startRatio: panelRatio, width };
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(true);
    },
    [panelRatio],
  );

  const onSplitMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    // Dragging left widens the dock; clamp so both columns stay usable.
    const raw = drag.startRatio - (event.clientX - drag.startX) / drag.width;
    const min = Math.min(0.8, PANEL_MIN_PX / drag.width);
    const max = Math.max(min, 1 - CHAT_MIN_PX / drag.width);
    const next = Math.min(max, Math.max(min, raw));
    ratioRef.current = next;
    setPanelRatio(next);
  }, []);

  const onSplitEnd = useCallback(() => {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    setResizing(false);
    persistPanelRatio(ratioRef.current);
  }, []);

  const onSplitReset = useCallback(() => {
    ratioRef.current = PANEL_DEFAULT_RATIO;
    setPanelRatio(PANEL_DEFAULT_RATIO);
    persistPanelRatio(PANEL_DEFAULT_RATIO);
  }, []);

  // While dragging, keep the col-resize cursor and suppress text selection everywhere.
  useEffect(() => {
    if (!resizing) {
      return;
    }
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing]);

  if (messages.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Launchpad />
      </div>
    );
  }

  return (
    <div ref={splitRef} className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div ref={attachScroller} onScroll={measure} data-testid={TID.chatThread} className="h-full overflow-y-auto">
            <MessageList messages={messages} streaming={streaming} />
          </div>
          {awayFromBottom ? (
            <button
              type="button"
              onClick={jumpToLatest}
              aria-label="Scroll to latest"
              title="Scroll to latest"
              className="absolute bottom-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg transition-colors animate-in fade-in slide-in-from-bottom-2 hover:text-foreground"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <Composer />
      </div>
      {dockedJob && panel ? (
        <aside
          style={{ width: `${(panelRatio * 100).toFixed(2)}%` }}
          className={cn(
            "relative z-10 flex min-w-0 shrink-0 border-l bg-card shadow-[-16px_0_48px_-36px_rgba(35,20,28,0.45)] animate-in fade-in-0 slide-in-from-right-4 duration-200",
            resizing ? "border-ember/70" : "border-border/60 has-[[role=separator]:hover]:border-ember/70",
          )}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize preview panel"
            title="Drag to resize · double-click to reset"
            onPointerDown={onSplitStart}
            onPointerMove={onSplitMove}
            onPointerUp={onSplitEnd}
            onPointerCancel={onSplitEnd}
            onDoubleClick={onSplitReset}
            className="absolute inset-y-0 -left-[3px] z-20 w-1.5 cursor-col-resize touch-none"
          />
          <div className="min-w-0 flex-1">
            <RepoPreviewPanel key={dockedJob.id} initialJob={dockedJob} onClose={panel.close} />
          </div>
        </aside>
      ) : null}
    </div>
  );
}
