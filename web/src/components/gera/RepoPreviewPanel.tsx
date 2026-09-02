import {
  AlertTriangle,
  AppWindow,
  ArrowUpRight,
  Box,
  Check,
  CircleDashed,
  CloudCog,
  ExternalLink,
  FileTerminal,
  Globe,
  Link2,
  Loader2,
  Lock,
  Maximize2,
  Play,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  Square,
  SquareDashed,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { ArtifactLightbox } from "@/components/gera/artifacts/ArtifactShell";
import { PreviewFrame, expiryCopy, phaseCopy, stepStates, type StepState } from "@/components/gera/RepoPreviewFlow";
import { Button } from "@/components/ui/button";
import { usePreviewBridge, type PreviewTabHost } from "@/hooks/use-preview-bridge";
import { REPO_PREVIEW_ACTIVE_PHASES, useRepoPreviewJob, type LiveRepoPreview } from "@/hooks/use-repo-preview-job";
import { safeCodePreviewUrl } from "@/lib/code-changes";
import { MAX_PREVIEW_TABS, previewRoutePath, sameOpener, type PopupOpener, type PopupPage } from "@/lib/preview-bridge";
import { TID } from "@/lib/testids";
import type { RepoPreviewJob } from "@/lib/types";
import { cn } from "@/lib/utils";

type PanelMode = "preview" | "log";

/**
 * One browser-style tab inside the dock. `page` tabs hold a sandboxed frame
 * (`href`/`title` arrive live from its shim); `blank` tabs are windows the app
 * opened but has not navigated yet; `window` tabs stand in for a real browser
 * window (other origins cannot run inside the panel). `opener` names the
 * `window.open` the tab stands in for, so closing it can be reported back.
 */
type PreviewTab = {
  id: string;
  kind: "page" | "blank" | "window";
  url: string;
  href: string | null;
  title: string | null;
  nonce: number;
  opener: PopupOpener | null;
  /** `window`: placement hints for a retry after the browser blocked it. */
  features: string;
  /** `window`: a real window currently stands behind the tab. */
  opened: boolean;
};

const ROOT_TAB_ID = "root";
const STAGE_LABELS = ["Source", "Install", "Build", "Preview"] as const;

function rootTab(url: string): PreviewTab {
  return { id: ROOT_TAB_ID, kind: "page", url, href: null, title: null, nonce: 0, opener: null, features: "", opened: true };
}

function popupTab(id: string, page: PopupPage, opener: PopupOpener | null): PreviewTab {
  const base = { id, href: null, title: null, nonce: 0, opener, features: "", opened: true };
  if (page.kind === "page") return { ...base, kind: "page", url: page.url };
  if (page.kind === "blank") return { ...base, kind: "blank", url: "about:blank" };
  return { ...base, kind: "window", url: page.url, features: page.features, opened: page.opened };
}

/** The app navigated a popup it already holds: the same tab shows the new destination. */
function retargetTab(tab: PreviewTab, page: PopupPage): PreviewTab {
  return { ...popupTab(tab.id, page, tab.opener), nonce: tab.nonce + 1 };
}

function tabLabel(tab: PreviewTab, previewUrl: string): string {
  if (tab.kind === "blank") return "New tab";
  if (tab.kind === "window") return hostOf(tab.url);
  return tab.title || previewRoutePath(tab.href ?? tab.url, previewUrl);
}

function tabIcon(tab: PreviewTab): LucideIcon {
  if (tab.id === ROOT_TAB_ID) return Box;
  if (tab.kind === "blank") return SquareDashed;
  if (tab.kind === "window") return AppWindow;
  return Globe;
}

function stageIcon(state: StepState): LucideIcon {
  if (state === "running") return Loader2;
  if (state === "done") return Check;
  if (state === "error") return X;
  return CircleDashed;
}

/** Vertical build timeline for the dark stage while the launch is in flight. */
function StageTimeline({ states }: { states: readonly StepState[] }) {
  return (
    <ol className="w-full max-w-[260px] space-y-1">
      {STAGE_LABELS.map((label, index) => {
        const state = states[index] ?? "waiting";
        const Icon = stageIcon(state);
        return (
          <li key={label} className="relative flex items-center gap-3 py-1.5">
            {index < STAGE_LABELS.length - 1 ? (
              <span
                className={cn(
                  "absolute left-[11px] top-[26px] h-[calc(100%-14px)] w-px",
                  state === "done" ? "bg-emerald-400/40" : "bg-white/10",
                )}
              />
            ) : null}
            <span
              className={cn(
                "relative flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border",
                state === "done" && "border-emerald-400/40 bg-emerald-400/15 text-emerald-200",
                state === "running" && "border-cyan-300/40 bg-cyan-300/15 text-cyan-100 shadow-[0_0_0_4px_rgba(103,232,249,0.08)]",
                state === "error" && "border-rose-400/40 bg-rose-400/15 text-rose-200",
                state === "waiting" && "border-white/10 bg-white/[0.03] text-white/30",
              )}
            >
              <Icon className={cn("h-3 w-3", state === "running" && "animate-spin")} />
            </span>
            <span
              className={cn(
                "text-[13px] tracking-[-0.005em]",
                state === "done" && "text-white/70",
                state === "running" && "font-medium text-white",
                state === "error" && "text-rose-200",
                state === "waiting" && "text-white/35",
              )}
            >
              {label}
            </span>
            <span className="ml-auto text-[10px] uppercase tracking-[0.12em] text-white/30">
              {state === "running" ? "now" : state === "done" ? "ok" : state === "error" ? "failed" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function logTail(logs: string, lines: number): string {
  const all = logs.trimEnd().split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

function HeaderIconButton({
  label,
  onClick,
  href,
  disabled = false,
  children,
  testId,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const className = cn(
    "flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
    disabled && "pointer-events-none opacity-40",
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" aria-label={label} title={label} className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" data-testid={testId} aria-label={label} title={label} onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  );
}

/** Browser-like tab strip; only rendered once the preview opened a second page. */
function TabStrip({
  tabs,
  activeId,
  previewUrl,
  onSelect,
  onClose,
}: {
  tabs: PreviewTab[];
  activeId: string;
  previewUrl: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div
      data-testid={TID.repoPreviewTabs}
      role="tablist"
      aria-label="Preview pages"
      className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border/60 bg-background/70 px-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const label = tabLabel(tab, previewUrl);
        const Icon = tabIcon(tab);
        const onAux = (event: ReactMouseEvent<HTMLButtonElement>) => {
          if (event.button === 1 && tabs.length > 1) onClose(tab.id);
        };
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            data-testid={TID.repoPreviewTab}
            data-active={active ? "true" : undefined}
            title={tab.href ?? tab.url}
            className={cn(
              "group relative flex h-8 min-w-[96px] max-w-[200px] flex-1 items-center gap-1 rounded-t-lg border border-b-0 pl-2.5 pr-1 text-[11.5px] transition-colors",
              active
                ? "-mb-px border-border/60 bg-card text-foreground shadow-[0_-1px_0_hsl(var(--ember)/0.55)_inset]"
                : "border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              onAuxClick={onAux}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <Icon className={cn("h-3 w-3 shrink-0", active ? "text-ember" : "text-muted-foreground/70")} />
              <span className="truncate">{label}</span>
            </button>
            {tabs.length > 1 ? (
              <button
                type="button"
                aria-label={`Close ${label}`}
                title="Close tab"
                onClick={() => onClose(tab.id)}
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-foreground/[0.08] hover:text-foreground",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Body of a `blank` tab: the app opened a window and has not loaded anything into it yet. */
function BlankPage() {
  return (
    <div data-testid={TID.repoPreviewPopupPage} className="flex h-full flex-col items-center justify-center gap-2.5 bg-white px-8 text-center">
      <SquareDashed className="h-6 w-6 text-muted-foreground/40" />
      <p className="font-mono text-[12px] text-muted-foreground/70">about:blank</p>
      <p className="max-w-xs text-[12px] leading-relaxed text-muted-foreground/60">
        The preview opened an empty window and hasn’t loaded a page into it yet. Close this tab if nothing follows.
      </p>
    </div>
  );
}

/** Body of a `window` tab: the stand-in for a real browser window, with a retry when the browser blocked it. */
function WindowPage({
  tab,
  onOpen,
  onFocus,
  onClose,
}: {
  tab: PreviewTab;
  onOpen: () => void;
  onFocus: () => void;
  onClose: () => void;
}) {
  return (
    <div
      data-testid={TID.repoPreviewPopupPage}
      data-window-state={tab.opened ? "open" : "blocked"}
      className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto bg-background px-8 py-10 text-center"
    >
      <span
        className={cn(
          "flex h-14 w-14 items-center justify-center rounded-[18px] border shadow-[0_18px_40px_-28px_rgba(35,20,28,0.5)]",
          tab.opened ? "border-border/70 bg-card text-foreground" : "border-amber-500/30 bg-amber-500/10 text-amber-700",
        )}
      >
        {tab.opened ? <AppWindow className="h-6 w-6" /> : <ShieldAlert className="h-6 w-6" />}
      </span>
      <div className="max-w-sm">
        <p className="font-display text-[20px] leading-tight tracking-[-0.01em] text-foreground">
          {tab.opened ? "Continues in a separate window" : "Your browser blocked the window"}
        </p>
        <p className="mt-1.5 truncate font-mono text-[11.5px] text-muted-foreground" title={tab.url}>
          {hostOf(tab.url)}
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          {tab.opened
            ? "Other sites — sign-in pages included — can’t run inside the preview, so this tab stands in for the window the preview opened. It closes on its own when that window does."
            : "The preview tried to open another site. Open it from here; the preview keeps waiting for the result."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {tab.opened ? (
          <Button type="button" size="sm" variant="outline" onClick={onFocus} className="h-9 gap-1.5 rounded-full px-4 text-xs">
            <ArrowUpRight className="h-3.5 w-3.5" />
            Show window
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            data-testid={TID.repoPreviewWindowOpen}
            onClick={onOpen}
            className="h-9 gap-1.5 rounded-full bg-[#101E24] px-4 text-xs text-cyan-100 hover:bg-[#17303A]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open window
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onClose} className="h-9 rounded-full px-4 text-xs text-muted-foreground hover:text-foreground">
          Close
        </Button>
      </div>
    </div>
  );
}

/**
 * Presentational dock (v0-style): the live repository preview pinned to the
 * right of the thread with browser-like chrome — page tabs, an address bar
 * for the active tab, reload/copy/open/expand and the build log. Every popup
 * the sandboxed preview opens arrives over the shim bridge and becomes a tab
 * here: in-preview pages load in a frame, blank windows show an empty page
 * until the app navigates them, and other sites open as a real browser window
 * with a tab standing in for it (retry when the browser blocked it).
 */
export function RepoPreviewPanelView({ live, onClose }: { live: LiveRepoPreview; onClose: () => void }) {
  const { job } = live;
  const panelId = useId();
  const tabSeq = useRef<number>(0);
  const [mode, setMode] = useState<PanelMode>(job.phase === "failed" ? "log" : "preview");
  const [expanded, setExpanded] = useState<boolean>(false);
  const previewUrl = job.previewUrl ? safeCodePreviewUrl(job.previewUrl) : null;
  const [tabs, setTabsState] = useState<PreviewTab[]>(() => (previewUrl ? [rootTab(previewUrl)] : []));
  // Bridge messages arrive back-to-back (open, then navigate) before React re-renders: the ref is the
  // synchronous source of truth and state mirrors it.
  const tabsRef = useRef<PreviewTab[]>(tabs);
  const [activeTabId, setActiveTabId] = useState<string>(ROOT_TAB_ID);
  const running = REPO_PREVIEW_ACTIVE_PHASES.has(job.phase);
  const ready = job.phase === "ready" && Boolean(previewUrl);
  const copy = phaseCopy(job);
  const states = stepStates(job.phase);
  const [owner, name] = job.repository.split("/");
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const activeHref = activeTab
    ? activeTab.kind === "page"
      ? activeTab.href ?? activeTab.url
      : activeTab.kind === "window"
        ? activeTab.url
        : null
    : previewUrl;
  const routePath = previewUrl && activeTab ? previewRoutePath(activeTab.href ?? activeTab.url, previewUrl) : "/";

  const updateTabs = useCallback((update: (current: PreviewTab[]) => PreviewTab[]) => {
    tabsRef.current = update(tabsRef.current);
    setTabsState(tabsRef.current);
  }, []);

  /** Drops matching tabs (never the last one) and moves a closed active tab to its left neighbour. */
  const removeTabs = useCallback(
    (match: (tab: PreviewTab) => boolean): PreviewTab[] => {
      const before = tabsRef.current;
      const removed = before.filter(match);
      if (removed.length === 0 || removed.length === before.length) return [];
      const next = before.filter((tab) => !match(tab));
      updateTabs(() => next);
      setActiveTabId((active) => {
        if (!removed.some((tab) => tab.id === active)) return active;
        const index = before.findIndex((tab) => tab.id === active);
        return next[Math.max(0, index - 1)]?.id ?? next[0].id;
      });
      return removed;
    },
    [updateTabs],
  );

  // A failing build lands on its log; a fresh ready build returns to the preview.
  useEffect(() => {
    if (job.phase === "failed") setMode("log");
    else if (job.phase === "ready") setMode("preview");
  }, [job.phase]);

  // The preview URL appears when the launch turns ready (or changes on rebuild): reset to one root tab.
  useEffect(() => {
    if (!previewUrl) return;
    updateTabs((current) => (current[0]?.url === previewUrl ? current : [rootTab(previewUrl)]));
    setActiveTabId((current) => current || ROOT_TAB_ID);
  }, [previewUrl, updateTabs]);

  const tabHost: PreviewTabHost = {
    open: (_frameKey, page, opener) => {
      const existing = opener ? tabsRef.current.find((tab) => sameOpener(tab.opener, opener)) : undefined;
      if (existing) {
        updateTabs((current) => current.map((tab) => (tab.id === existing.id ? retargetTab(tab, page) : tab)));
        return;
      }
      if (tabsRef.current.length >= MAX_PREVIEW_TABS) {
        toast.error("Preview tab limit reached", { description: "Close a tab in the preview panel to open another page." });
        // A real window that did open keeps working on its own; a page that never got a tab reports closed.
        if (opener && !(page.kind === "window" && page.opened)) bridge.dismissPopup(opener);
        return;
      }
      tabSeq.current += 1;
      const id = `tab-${tabSeq.current}`;
      updateTabs((current) => [...current, popupTab(id, page, opener)]);
      setActiveTabId(id);
      setMode("preview");
    },
    close: (opener) => {
      removeTabs((tab) => sameOpener(tab.opener, opener));
    },
    focus: (opener) => {
      const tab = tabsRef.current.find((item) => sameOpener(item.opener, opener));
      if (!tab) return;
      setActiveTabId(tab.id);
      setMode("preview");
    },
    closed: (opener) => {
      removeTabs((tab) => sameOpener(tab.opener, opener));
    },
  };

  const bridge = usePreviewBridge({
    prefix: `${panelId}:`,
    previewUrl,
    tabs: tabHost,
    onState: (frameKey, state) => {
      const tabId = frameKey.startsWith("expanded:") ? frameKey.slice("expanded:".length) : frameKey;
      updateTabs((current) =>
        current.map((tab) => (tab.id === tabId && tab.kind === "page" ? { ...tab, href: state.href, title: state.title || null } : tab)),
      );
    },
  });

  /** The user closes a tab: any real window behind it goes too, and the opener hears `closed`. */
  const closeTab = useCallback(
    (id: string) => {
      if (tabsRef.current.length <= 1) return;
      const [closing] = removeTabs((tab) => tab.id === id);
      if (closing?.opener) bridge.dismissPopup(closing.opener);
    },
    [bridge, removeTabs],
  );

  const reopenWindow = useCallback(
    (tab: PreviewTab) => {
      if (!tab.opener) return;
      if (bridge.openPopupWindow(tab.opener, tab.url, tab.features)) {
        updateTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, opened: true } : item)));
        return;
      }
      toast.error("The browser blocked the window again", { description: "Allow popups for Gera, then try once more." });
    },
    [bridge, updateTabs],
  );

  const reloadActive = useCallback(() => {
    if (!activeTab || activeTab.kind !== "page") return;
    updateTabs((current) =>
      current.map((tab) => (tab.id === activeTab.id ? { ...tab, href: null, title: null, nonce: tab.nonce + 1 } : tab)),
    );
  }, [activeTab, updateTabs]);

  const copyLink = async () => {
    if (!activeHref) return;
    try {
      await navigator.clipboard.writeText(activeHref);
      toast.success("Preview link copied");
    } catch {
      toast.error("Could not copy the preview link");
    }
  };

  return (
    <section
      data-testid={TID.repoPreviewPanel}
      aria-label={`${job.repository} preview`}
      className="flex h-full min-w-0 flex-col bg-card"
    >
      <header className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border/60 px-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#101E24] text-cyan-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
            <CloudCog className={cn("h-4 w-4", running && "animate-pulse")} />
            <span
              className={cn(
                "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card",
                ready && "bg-emerald-400",
                running && "bg-cyan-300 animate-pulse",
                job.phase === "failed" && "bg-rose-400",
                (job.phase === "cancelled" || job.phase === "expired") && "bg-muted-foreground/50",
              )}
            />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium leading-tight text-foreground">
              {name ?? job.repository}
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{owner}</span>
            </p>
            <p className="truncate text-[10.5px] leading-tight text-muted-foreground">
              {job.ref} · {job.commitSha.slice(0, 7)} · {job.framework}
              {live.statusUnavailable ? " · status offline" : ""}
            </p>
          </div>
        </div>

        <div role="tablist" aria-label="Preview panel views" className="flex items-center rounded-lg bg-foreground/[0.05] p-0.5">
          {(["preview", "log"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              onClick={() => setMode(item)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-all",
                mode === item
                  ? "bg-card text-foreground shadow-[0_1px_2px_rgba(35,20,28,0.08)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item === "preview" ? <Box className="h-3.5 w-3.5" /> : <FileTerminal className="h-3.5 w-3.5" />}
              {item === "preview" ? "Preview" : "Log"}
              {item === "preview" && tabs.length > 1 ? (
                <span className="rounded-full bg-foreground/[0.08] px-1.5 text-[10px] tabular-nums">{tabs.length}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-0.5">
          <HeaderIconButton label="Refresh status" onClick={live.refresh}>
            <RefreshCw className={cn("h-3.5 w-3.5", live.isRefreshing && "animate-spin")} />
          </HeaderIconButton>
          {job.actionsUrl ? (
            <HeaderIconButton label="Open GitHub Actions run" href={job.actionsUrl}>
              <Workflow className="h-3.5 w-3.5" />
            </HeaderIconButton>
          ) : null}
          {running ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={TID.repoPreviewStop}
              disabled={live.actionBusy}
              onClick={live.cancel}
              className="h-8 gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Square className="h-3 w-3 fill-current" />
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              data-testid={TID.repoPreviewRebuild}
              disabled={live.actionBusy}
              onClick={live.rebuild}
              className="h-8 gap-1.5 rounded-lg bg-[#101E24] px-2.5 text-xs text-cyan-100 hover:bg-[#17303A]"
            >
              {live.actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3 w-3 fill-current" />}
              Rebuild
            </Button>
          )}
          <span className="mx-0.5 h-5 w-px bg-border/70" />
          <HeaderIconButton label="Close preview panel" onClick={onClose} testId={TID.repoPreviewPanelClose}>
            <X className="h-4 w-4" />
          </HeaderIconButton>
        </div>
      </header>

      {mode === "preview" && ready && previewUrl && tabs.length > 1 ? (
        <TabStrip tabs={tabs} activeId={activeTab?.id ?? ROOT_TAB_ID} previewUrl={previewUrl} onSelect={setActiveTabId} onClose={closeTab} />
      ) : null}

      {mode === "preview" && ready && previewUrl && activeTab ? (
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/60 bg-background/70 px-2.5">
          <HeaderIconButton label="Reload preview" onClick={reloadActive} disabled={activeTab.kind !== "page"}>
            <RotateCw className="h-3.5 w-3.5" />
          </HeaderIconButton>
          <div
            data-testid={TID.repoPreviewAddress}
            title={activeHref ?? "about:blank"}
            className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-card px-2.5 font-mono text-[11px] text-muted-foreground shadow-[inset_0_1px_2px_rgba(35,20,28,0.04)]"
          >
            {activeTab.kind === "page" ? (
              <Lock className="h-3 w-3 shrink-0 text-emerald-600" />
            ) : activeTab.kind === "window" ? (
              <AppWindow className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <SquareDashed className="h-3 w-3 shrink-0 text-muted-foreground/70" />
            )}
            <span className="truncate">
              {activeTab.kind === "page" ? (
                <>
                  <span className="text-foreground/80">{hostOf(previewUrl)}</span>
                  <span className="text-muted-foreground/50">/…</span>
                  <span className="text-foreground/80">{routePath}</span>
                </>
              ) : activeTab.kind === "window" ? (
                <>
                  <span className="text-foreground/80">{hostOf(activeTab.url)}</span>
                  <span className="text-muted-foreground/70">{pathOf(activeTab.url)}</span>
                </>
              ) : (
                <span className="text-muted-foreground/70">about:blank</span>
              )}
            </span>
            {activeTab.kind === "page" ? (
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] font-sans">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                {expiryCopy(job.expiresAt)}
              </span>
            ) : null}
          </div>
          <HeaderIconButton label="Copy preview link" onClick={() => void copyLink()} disabled={!activeHref}>
            <Link2 className="h-3.5 w-3.5" />
          </HeaderIconButton>
          {activeHref ? (
            <HeaderIconButton label="Open preview in a new tab" href={activeHref}>
              <ExternalLink className="h-3.5 w-3.5" />
            </HeaderIconButton>
          ) : (
            <HeaderIconButton label="Open preview in a new tab" disabled>
              <ExternalLink className="h-3.5 w-3.5" />
            </HeaderIconButton>
          )}
          <HeaderIconButton label="Expand preview" onClick={() => setExpanded(true)} disabled={activeTab.kind !== "page"}>
            <Maximize2 className="h-3.5 w-3.5" />
          </HeaderIconButton>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {mode === "log" ? (
          <div className="flex h-full flex-col bg-[#091317]">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 text-[11px] text-white/45">
              <FileTerminal className="h-3.5 w-3.5" />
              <span>Build log</span>
              <span className="ml-auto font-mono text-[9px] text-white/25">bounded · redacted</span>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto px-3.5 py-3 font-mono text-[11px] leading-relaxed text-white/60">
              {job.logs ?? (running ? "Waiting for the runner to stream its first lines…" : "No build output was recorded for this launch.")}
            </pre>
          </div>
        ) : ready && activeTab ? (
          <div className="h-full bg-white animate-in fade-in-0 duration-300">
            {tabs.map((tab) => (
              // Inactive pages stay mounted (hidden) so switching tabs never reloads them.
              <div key={tab.id} className={cn("h-full", tab.id !== activeTab.id && "hidden")} aria-hidden={tab.id !== activeTab.id}>
                {tab.kind === "page" ? (
                  <PreviewFrame key={tab.nonce} job={job} url={tab.url} frameKey={`${panelId}:${tab.id}`} full />
                ) : tab.kind === "blank" ? (
                  <BlankPage />
                ) : (
                  <WindowPage
                    tab={tab}
                    onOpen={() => reopenWindow(tab)}
                    onFocus={() => {
                      if (tab.opener) bridge.focusPopupWindow(tab.opener);
                    }}
                    onClose={() => closeTab(tab.id)}
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-7 overflow-y-auto bg-[#0D191E] px-8 py-10 text-white [background-image:radial-gradient(55%_45%_at_50%_0%,rgba(42,178,210,0.16),transparent),radial-gradient(40%_40%_at_100%_100%,rgba(255,255,255,0.03),transparent)]">
            <span
              className={cn(
                "flex h-16 w-16 items-center justify-center rounded-[22px] border shadow-[0_24px_60px_-30px_rgba(103,232,249,0.6)]",
                job.phase === "failed"
                  ? "border-rose-300/25 bg-rose-300/10"
                  : running
                    ? "border-cyan-300/25 bg-cyan-300/10"
                    : "border-white/10 bg-white/[0.04]",
              )}
            >
              {running ? (
                <Loader2 className="h-6 w-6 animate-spin text-cyan-200" />
              ) : job.phase === "failed" ? (
                <AlertTriangle className="h-6 w-6 text-rose-200" />
              ) : (
                <Box className="h-6 w-6 text-white/50" />
              )}
            </span>
            <div className="max-w-sm text-center">
              <p className="font-display text-[22px] leading-tight tracking-[-0.01em] text-white/95">{copy.label}</p>
              <p className="mt-2 text-[13px] leading-relaxed text-white/45">{copy.detail}</p>
              {live.statusUnavailable ? (
                <p className="mt-2 text-[11px] text-amber-200/70">Live status is temporarily unavailable; the last durable state is shown.</p>
              ) : null}
            </div>
            <StageTimeline states={states} />
            {job.logs && running ? (
              <pre className="max-h-36 w-full max-w-md overflow-hidden rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-3 font-mono text-[10px] leading-relaxed text-white/45 [mask-image:linear-gradient(to_bottom,transparent,black_30%)]">
                {logTail(job.logs, 8)}
              </pre>
            ) : null}
            {job.logs && job.phase === "failed" ? (
              <button
                type="button"
                onClick={() => setMode("log")}
                className="flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 text-xs text-white/70 transition-colors hover:bg-white/[0.1] hover:text-white"
              >
                <FileTerminal className="h-3.5 w-3.5" />
                Open the build log
              </button>
            ) : null}
          </div>
        )}
      </div>

      {previewUrl && activeTab && activeTab.kind === "page" ? (
        <ArtifactLightbox
          open={expanded}
          onOpenChange={setExpanded}
          icon={CloudCog}
          title={`${job.repository} preview`}
          badge="Rork cloud"
        >
          <PreviewFrame job={job} url={activeTab.href ?? activeTab.url} frameKey={`${panelId}:expanded:${activeTab.id}`} full />
        </ArtifactLightbox>
      ) : null}
    </section>
  );
}

/** Live dock: shares the launch's polling query with the thread receipt. */
export const RepoPreviewPanel = memo(function RepoPreviewPanel({
  initialJob,
  onClose,
}: {
  initialJob: RepoPreviewJob;
  onClose: () => void;
}) {
  const live = useRepoPreviewJob(initialJob);
  return <RepoPreviewPanelView live={live} onClose={onClose} />;
});
