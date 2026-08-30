import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { ChatPane } from "@/components/gera/ChatPane";
import { Sidebar } from "@/components/gera/Sidebar";
import { TopNav } from "@/components/gera/TopNav";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAgent } from "@/hooks/use-agent";
import { useChatUrl } from "@/hooks/use-chat-url";
import { cn } from "@/lib/utils";

const SIDEBAR_PREF_KEY = "gera.sidebar.v1";
const SIDEBAR_WIDTH_KEY = "gera.sidebar.width.v1";
const SIDEBAR_DEFAULT_WIDTH = 300;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 440;
/** Dragging the rail narrower than this snaps it closed, VS Code-style. */
const SIDEBAR_SNAP_CLOSED_AT = 170;

/** Skips re-renders while the parent updates width every pointer move. */
const MemoSidebar = memo(Sidebar);

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_PREF_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function readSidebarWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(raw) && raw > 0) {
      return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(raw)));
    }
  } catch {
    // fall through to the default
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

function persistSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // The preference just won't stick — nothing to surface.
  }
}

const Index = () => {
  const { state, setSidebarOpen, newChat } = useAgent();
  // The address bar mirrors the active chat (/c/<id>) and drives it back.
  useChatUrl();
  // Desktop rail: persistent and open by default; both the collapsed flag and
  // the dragged width stick per device.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readSidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth);
  const [resizing, setResizing] = useState<boolean>(false);
  const widthRef = useRef<number>(sidebarWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const setCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    try {
      window.localStorage.setItem(SIDEBAR_PREF_KEY, collapsed ? "collapsed" : "open");
    } catch {
      // The preference just won't stick — nothing to surface.
    }
  }, []);

  const collapseSidebar = useCallback(() => setCollapsed(true), [setCollapsed]);

  const openNav = useCallback(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      setCollapsed(false);
    } else {
      setSidebarOpen(true);
    }
  }, [setCollapsed, setSidebarOpen]);

  const toggleNav = useCallback(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      setSidebarCollapsed((prev) => {
        const next = !prev;
        try {
          window.localStorage.setItem(SIDEBAR_PREF_KEY, next ? "collapsed" : "open");
        } catch {
          // The preference just won't stick — nothing to surface.
        }
        return next;
      });
    } else {
      setSidebarOpen(!state.sidebarOpen);
    }
  }, [setSidebarOpen, state.sidebarOpen]);

  const onResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragRef.current = { startX: event.clientX, startWidth: sidebarWidth };
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(true);
    },
    [sidebarWidth],
  );

  const onResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const raw = drag.startWidth + (event.clientX - drag.startX);
      if (raw < SIDEBAR_SNAP_CLOSED_AT) {
        // Dragged almost shut — snap closed; the last good width is kept for reopening.
        dragRef.current = null;
        setResizing(false);
        setCollapsed(true);
        return;
      }
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(raw)));
      widthRef.current = next;
      setSidebarWidth(next);
    },
    [setCollapsed],
  );

  const onResizeEnd = useCallback(() => {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    setResizing(false);
    persistSidebarWidth(widthRef.current);
  }, []);

  const onResizeReset = useCallback(() => {
    widthRef.current = SIDEBAR_DEFAULT_WIDTH;
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        // ⇧ starts an incognito thread — mirrors the browser convention.
        newChat(event.shiftKey ? { incognito: true } : undefined);
      } else if (key === "b" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        toggleNav();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, toggleNav]);

  return (
    <div className="relative flex h-svh overflow-hidden">
      <div className="gera-atmosphere pointer-events-none absolute inset-0" />
      <aside
        style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        className={cn(
          "relative z-10 hidden shrink-0 overflow-hidden bg-[#F5EFF3] lg:block",
          !resizing && "transition-[width] duration-200 ease-out",
          !sidebarCollapsed && "border-r",
          !sidebarCollapsed &&
            (resizing
              ? "border-ember/70"
              : "border-border/60 has-[[role=separator]:hover]:border-ember/70"),
        )}
      >
        <div style={{ width: sidebarWidth }} className="h-full">
          <MemoSidebar onCollapse={collapseSidebar} />
        </div>
        {!sidebarCollapsed ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Drag to resize · double-click to reset"
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            onDoubleClick={onResizeReset}
            className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none"
          />
        ) : null}
      </aside>
      <div className="relative z-10 flex h-full min-w-0 flex-1 flex-col">
        <TopNav sidebarCollapsed={sidebarCollapsed} onOpenNav={openNav} />
        <ChatPane />
      </div>
      <Sheet open={state.sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[300px] border-border/70 bg-[#F5EFF3] p-0">
          <SheetTitle className="sr-only">Chats</SheetTitle>
          <Sidebar />
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default Index;
