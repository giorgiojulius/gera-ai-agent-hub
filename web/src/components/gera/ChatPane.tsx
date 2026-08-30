import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Composer } from "@/components/gera/Composer";
import { Launchpad } from "@/components/gera/Launchpad";
import { MessageList } from "@/components/gera/MessageList";
import { useAgent } from "@/hooks/use-agent";
import { TID } from "@/lib/testids";

/** Distance from the bottom (px) beyond which the jump-to-latest arrow shows. */
const JUMP_THRESHOLD_PX = 200;

export function ChatPane() {
  const { active, state } = useAgent();
  const messages = active?.messages ?? [];
  const streaming = active ? state.runningIds.includes(active.id) : false;
  const activeId = active?.id ?? null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingJumpRef = useRef<boolean>(true);
  const [awayFromBottom, setAwayFromBottom] = useState<boolean>(false);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
  );
}
