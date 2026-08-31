import { ArrowDown, GripHorizontal } from "lucide-react";
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
import { useAgent } from "@/hooks/use-agent";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  COMPOSER_POS_KEY,
  clampComposerOffset,
  isDefaultOffset,
  parseComposerOffset,
  type ComposerOffset,
} from "@/lib/composer-position";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

/** Distance from the bottom (px) beyond which the jump-to-latest arrow shows. */
const JUMP_THRESHOLD_PX = 200;
/** Ignore tiny pointer jitter so a click on the handle does not undock. */
const DRAG_THRESHOLD_PX = 6;

function readComposerOffset(): ComposerOffset {
  try {
    return parseComposerOffset(window.localStorage.getItem(COMPOSER_POS_KEY)) ?? { x: 0, y: 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

function persistComposerOffset(offset: ComposerOffset) {
  try {
    if (isDefaultOffset(offset)) {
      window.localStorage.removeItem(COMPOSER_POS_KEY);
    } else {
      window.localStorage.setItem(COMPOSER_POS_KEY, JSON.stringify(offset));
    }
  } catch {
    // The preference just won't stick — nothing to surface.
  }
}

export function ChatPane() {
  const { active, state } = useAgent();
  const isMobile = useIsMobile();
  const messages = active?.messages ?? [];
  const streaming = active ? state.runningIds.includes(active.id) : false;
  const activeId = active?.id ?? null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingJumpRef = useRef<boolean>(true);
  const [awayFromBottom, setAwayFromBottom] = useState<boolean>(false);

  const paneRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState<ComposerOffset>(readComposerOffset);
  const [dragging, setDragging] = useState<boolean>(false);
  const [boxHeight, setBoxHeight] = useState<number>(0);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const offsetRef = useRef<ComposerOffset>(offset);
  offsetRef.current = offset;

  const measureBox = useCallback((node: HTMLDivElement | null = boxRef.current) => {
    if (!node) {
      return;
    }
    const next = Math.round(node.getBoundingClientRect().height);
    setBoxHeight((prev) => (prev === next ? prev : next));
  }, []);

  const attachBox = useCallback(
    (node: HTMLDivElement | null) => {
      boxRef.current = node;
      measureBox(node);
    },
    [measureBox],
  );

  const clampToPane = useCallback((next: ComposerOffset): ComposerOffset => {
    const pane = paneRef.current;
    const box = boxRef.current;
    if (!pane || !box) {
      return next;
    }
    return clampComposerOffset(
      next,
      { width: pane.clientWidth, height: pane.clientHeight },
      { width: box.getBoundingClientRect().width, height: box.getBoundingClientRect().height },
    );
  }, []);

  // Re-clamp when the pane resizes (sidebar drag, window) so a parked card
  // never ends up off-screen.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const box = boxRef.current;
    if (!pane || !box) {
      return;
    }
    const sync = () => {
      measureBox(box);
      setOffset((prev) => {
        if (isDefaultOffset(prev)) {
          return prev;
        }
        const next = clampToPane(prev);
        if (next.x === prev.x && next.y === prev.y) {
          return prev;
        }
        persistComposerOffset(next);
        return next;
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(pane);
    observer.observe(box);
    return () => observer.disconnect();
  }, [clampToPane, measureBox, activeId]);

  const onDragStart = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = offsetRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: current.x,
      originY: current.y,
      moved: false,
    };
    setDragging(true);
  }, []);

  const onDragMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        return;
      }
      drag.moved = true;
      // y is "up from the bottom", so a pointer moving up increases y.
      setOffset(clampToPane({ x: drag.originX + dx, y: drag.originY - dy }));
    },
    [clampToPane],
  );

  const onDragEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    persistComposerOffset(offsetRef.current);
  }, []);

  const resetComposerPos = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
    setOffset({ x: 0, y: 0 });
    persistComposerOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!dragging) {
      return;
    }
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging]);

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

  if (messages.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Launchpad />
      </div>
    );
  }

  // useIsMobile starts undefined (false) until the matchMedia effect runs —
  // hide the handle with CSS from the first paint so phones never flash it.
  const floating = !isMobile && (dragging || !isDefaultOffset(offset));
  const live = isMobile ? { x: 0, y: 0 } : offset;
  // Keep the thread ending at the composer's top: a lifted card leaves a hole
  // below rather than covering the latest messages.
  const reserved = floating ? Math.max(0, boxHeight + live.y) : 0;

  return (
    <div ref={paneRef} className="relative flex min-h-0 flex-1 flex-col">
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
      {reserved > 0 ? <div aria-hidden className="shrink-0" style={{ height: reserved }} /> : null}
      <div
        ref={attachBox}
        className={cn("w-full", floating && "absolute z-20 max-w-3xl", dragging && "pointer-events-none")}
        style={
          floating
            ? {
                left: "50%",
                bottom: live.y,
                transform: `translate3d(calc(-50% + ${live.x}px), 0, 0)`,
                width: "min(48rem, 100%)",
              }
            : undefined
        }
      >
        <div className={cn("hidden justify-center md:flex", dragging && "pointer-events-auto")}>
          <button
            type="button"
            data-testid={TID.composerDragHandle}
            aria-label="Move composer"
            title="Drag to move · double-click to dock"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onDoubleClick={resetComposerPos}
            className="flex h-5 w-12 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground touch-none"
            style={{ cursor: dragging ? "grabbing" : "grab" }}
          >
            <GripHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className={dragging ? "pointer-events-none" : undefined}>
          <Composer />
        </div>
      </div>
    </div>
  );
}
