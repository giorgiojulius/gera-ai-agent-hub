import {
  AlertTriangle,
  Box,
  Check,
  CircleDashed,
  CloudCog,
  ExternalLink,
  FileTerminal,
  Link2,
  Loader2,
  Lock,
  Maximize2,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ArtifactLightbox } from "@/components/gera/artifacts/ArtifactShell";
import { PreviewFrame, expiryCopy, phaseCopy, stepStates, type StepState } from "@/components/gera/RepoPreviewFlow";
import { Button } from "@/components/ui/button";
import { REPO_PREVIEW_ACTIVE_PHASES, useRepoPreviewJob } from "@/hooks/use-repo-preview-job";
import { safeCodePreviewUrl } from "@/lib/code-changes";
import { TID } from "@/lib/testids";
import type { RepoPreviewJob } from "@/lib/types";
import { cn } from "@/lib/utils";

type PanelTab = "preview" | "log";

const STAGE_LABELS = ["Source", "Install", "Build", "Preview"] as const;

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

function shortUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const path = segments.length > 2
      ? `/${segments[0]}/${segments[1].slice(0, 10)}…/`
      : parsed.pathname;
    return { host: parsed.host, path };
  } catch {
    return { host: url, path: "" };
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

/**
 * v0-style dock: the live repository preview pinned to the right of the
 * thread with browser-like chrome (tabs, address bar, reload, open, expand).
 */
export const RepoPreviewPanel = memo(function RepoPreviewPanel({
  initialJob,
  onClose,
}: {
  initialJob: RepoPreviewJob;
  onClose: () => void;
}) {
  const live = useRepoPreviewJob(initialJob);
  const { job } = live;
  const [tab, setTab] = useState<PanelTab>(job.phase === "failed" ? "log" : "preview");
  const [reloadNonce, setReloadNonce] = useState<number>(0);
  const [expanded, setExpanded] = useState<boolean>(false);
  const previewUrl = job.previewUrl ? safeCodePreviewUrl(job.previewUrl) : null;
  const running = REPO_PREVIEW_ACTIVE_PHASES.has(job.phase);
  const ready = job.phase === "ready" && Boolean(previewUrl);
  const copy = phaseCopy(job);
  const states = stepStates(job.phase);
  const [owner, name] = job.repository.split("/");
  const address = previewUrl ? shortUrl(previewUrl) : null;

  // A failing build lands on its log; a fresh ready build returns to the preview.
  useEffect(() => {
    if (job.phase === "failed") setTab("log");
    else if (job.phase === "ready") setTab("preview");
  }, [job.phase]);

  const copyLink = async () => {
    if (!previewUrl) return;
    try {
      await navigator.clipboard.writeText(previewUrl);
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
              aria-selected={tab === item}
              onClick={() => setTab(item)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-all",
                tab === item
                  ? "bg-card text-foreground shadow-[0_1px_2px_rgba(35,20,28,0.08)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item === "preview" ? <Box className="h-3.5 w-3.5" /> : <FileTerminal className="h-3.5 w-3.5" />}
              {item === "preview" ? "Preview" : "Log"}
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

      {tab === "preview" && ready && address ? (
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/60 bg-background/70 px-2.5">
          <HeaderIconButton label="Reload preview" onClick={() => setReloadNonce((value) => value + 1)}>
            <RotateCw className="h-3.5 w-3.5" />
          </HeaderIconButton>
          <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-card px-2.5 font-mono text-[11px] text-muted-foreground shadow-[inset_0_1px_2px_rgba(35,20,28,0.04)]">
            <Lock className="h-3 w-3 shrink-0 text-emerald-600" />
            <span className="truncate">
              <span className="text-foreground/80">{address.host}</span>
              <span className="text-muted-foreground/70">{address.path}</span>
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] font-sans">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              {expiryCopy(job.expiresAt)}
            </span>
          </div>
          <HeaderIconButton label="Copy preview link" onClick={() => void copyLink()}>
            <Link2 className="h-3.5 w-3.5" />
          </HeaderIconButton>
          <HeaderIconButton label="Open preview in a new tab" href={previewUrl ?? undefined}>
            <ExternalLink className="h-3.5 w-3.5" />
          </HeaderIconButton>
          <HeaderIconButton label="Expand preview" onClick={() => setExpanded(true)}>
            <Maximize2 className="h-3.5 w-3.5" />
          </HeaderIconButton>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {tab === "log" ? (
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
        ) : ready ? (
          <div className="h-full bg-white animate-in fade-in-0 duration-300">
            <PreviewFrame key={reloadNonce} job={job} full />
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
                onClick={() => setTab("log")}
                className="flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 text-xs text-white/70 transition-colors hover:bg-white/[0.1] hover:text-white"
              >
                <FileTerminal className="h-3.5 w-3.5" />
                Open the build log
              </button>
            ) : null}
          </div>
        )}
      </div>

      {previewUrl ? (
        <ArtifactLightbox
          open={expanded}
          onOpenChange={setExpanded}
          icon={CloudCog}
          title={`${job.repository} preview`}
          badge="Rork cloud"
        >
          <PreviewFrame job={job} full />
        </ArtifactLightbox>
      ) : null}
    </section>
  );
});
