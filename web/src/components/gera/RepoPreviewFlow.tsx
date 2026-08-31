import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Box,
  Check,
  CircleDashed,
  CloudCog,
  ExternalLink,
  FileTerminal,
  Loader2,
  Maximize2,
  Play,
  RefreshCw,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { toast } from "sonner";

import { ArtifactLightbox } from "@/components/gera/artifacts/ArtifactShell";
import { Button } from "@/components/ui/button";
import { useAgent } from "@/hooks/use-agent";
import { safeCodePreviewUrl } from "@/lib/code-changes";
import { errorFromUnknown } from "@/lib/errors";
import { resolveGitHubAuth } from "@/lib/github-native";
import {
  cancelRepoPreview,
  getRepoPreview,
  startRepoPreview,
} from "@/lib/repo-preview";
import { TID } from "@/lib/testids";
import type { RepoPreviewJob, RepoPreviewPhase } from "@/lib/types";
import { cn } from "@/lib/utils";

const REMOTE_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";
const ACTIVE_PHASES = new Set<RepoPreviewPhase>(["queued", "installing", "building", "packaging", "uploading"]);

type StepState = "waiting" | "running" | "done" | "error";

type RepoPreviewCardProps = {
  job: RepoPreviewJob;
  isRefreshing?: boolean;
  statusUnavailable?: boolean;
  readOnly?: boolean;
  onRefresh?: () => void;
  onCancel?: () => void;
  onRebuild?: () => void;
  actionBusy?: boolean;
};

function stepIcon(state: StepState): LucideIcon {
  if (state === "running") return Loader2;
  if (state === "done") return Check;
  if (state === "error") return X;
  return CircleDashed;
}

function Step({ label, state }: { label: string; state: StepState }) {
  const Icon = stepIcon(state);
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.11em]",
        state === "done" && "text-emerald-300",
        state === "running" && "text-cyan-200",
        state === "error" && "text-rose-300",
        state === "waiting" && "text-white/35",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          state === "done" && "border-emerald-400/30 bg-emerald-400/10",
          state === "running" && "border-cyan-300/30 bg-cyan-300/10",
          state === "error" && "border-rose-400/30 bg-rose-400/10",
          state === "waiting" && "border-white/10 bg-white/[0.03]",
        )}
      >
        <Icon className={cn("h-2.5 w-2.5", state === "running" && "animate-spin")} />
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}

function phaseCopy(job: RepoPreviewJob): { label: string; detail: string } {
  const values: Record<RepoPreviewPhase, { label: string; detail: string }> = {
    queued: { label: "Runner queued", detail: "GitHub is allocating an isolated build machine" },
    installing: { label: "Installing dependencies", detail: `Using ${job.packageManager === "none" ? "a static site" : job.packageManager}` },
    building: { label: "Building web project", detail: `${job.framework} · immutable ${job.commitSha.slice(0, 7)}` },
    packaging: { label: "Packaging preview", detail: "Indexing the static output for edge range delivery" },
    uploading: { label: "Publishing to Rork", detail: "Uploading the bounded artifact to Rork storage" },
    ready: { label: "Preview running", detail: "Hosted by the Rork backend for 24 hours" },
    failed: { label: "Build needs attention", detail: job.error ?? "Open the build log for the exact failure" },
    cancelled: { label: "Preview stopped", detail: "The launch was cancelled" },
    expired: { label: "Preview expired", detail: "Rebuild it to create a fresh 24-hour URL" },
  };
  return values[job.phase];
}

function stepStates(phase: RepoPreviewPhase): [StepState, StepState, StepState, StepState] {
  if (phase === "failed") return ["done", "done", "error", "waiting"];
  if (phase === "cancelled" || phase === "expired") return ["done", "done", "done", "error"];
  if (phase === "queued") return ["done", "running", "waiting", "waiting"];
  if (phase === "installing") return ["done", "running", "waiting", "waiting"];
  if (phase === "building") return ["done", "done", "running", "waiting"];
  if (phase === "packaging" || phase === "uploading") return ["done", "done", "done", "running"];
  return ["done", "done", "done", "done"];
}

function expiryCopy(expiresAt: number): string {
  const hours = Math.max(0, Math.ceil((expiresAt - Date.now()) / 3_600_000));
  return hours > 0 ? `expires in ${hours}h` : "expired";
}

function PreviewFrame({ job, full = false }: { job: RepoPreviewJob; full?: boolean }) {
  const url = job.previewUrl ? safeCodePreviewUrl(job.previewUrl) : null;
  if (!url) return null;
  return (
    <iframe
      data-testid={TID.repoPreviewFrame}
      src={url}
      sandbox={REMOTE_SANDBOX}
      referrerPolicy="no-referrer"
      title={`${job.repository} web preview`}
      className={cn("w-full border-0 bg-white", full ? "h-full" : "h-[390px]")}
    />
  );
}

/** Pure receipt used by browser regressions and the live query wrapper. */
export const RepoPreviewCard = memo(function RepoPreviewCard({
  job,
  isRefreshing = false,
  statusUnavailable = false,
  readOnly = false,
  onRefresh,
  onCancel,
  onRebuild,
  actionBusy = false,
}: RepoPreviewCardProps) {
  const [showLogs, setShowLogs] = useState<boolean>(job.phase === "failed");
  const [expanded, setExpanded] = useState<boolean>(false);
  const copy = phaseCopy(job);
  const states = stepStates(job.phase);
  const previewUrl = job.previewUrl ? safeCodePreviewUrl(job.previewUrl) : null;
  const terminal = !ACTIVE_PHASES.has(job.phase);

  return (
    <div
      data-testid={TID.repoPreviewFlow}
      className="mb-3 overflow-hidden rounded-2xl border border-[#244451] bg-[#101E24] text-white shadow-[0_20px_60px_-40px_rgba(0,18,28,0.95)]"
    >
      <div className="border-b border-white/[0.08] bg-[radial-gradient(circle_at_0%_0%,rgba(42,178,210,0.2),transparent_45%),linear-gradient(135deg,rgba(255,255,255,0.04),transparent)] px-3.5 pb-3 pt-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-300/10">
            <CloudCog className={cn("h-4 w-4 text-cyan-200", ACTIVE_PHASES.has(job.phase) && "animate-pulse")} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm font-semibold tracking-[-0.01em] text-white/90">{copy.label}</p>
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em]",
                  ACTIVE_PHASES.has(job.phase) && "border-cyan-300/20 bg-cyan-300/[0.08] text-cyan-100",
                  job.phase === "ready" && "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200",
                  job.phase === "failed" && "border-rose-300/20 bg-rose-300/[0.08] text-rose-200",
                  (job.phase === "cancelled" || job.phase === "expired") && "border-white/10 bg-white/[0.04] text-white/50",
                )}
              >
                {job.phase}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-white/45">
              {job.repository} · {job.ref} · {job.commitSha.slice(0, 7)}
            </p>
            <p className="mt-1 text-[10px] text-white/35">{copy.detail}</p>
          </div>
          {!readOnly ? (
            <div className="flex shrink-0 items-center gap-1">
              {job.actionsUrl ? (
                <a
                  href={job.actionsUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open GitHub Actions run"
                  title="Open GitHub Actions run"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white/85"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : null}
              {onRefresh ? (
                <button
                  type="button"
                  onClick={onRefresh}
                  aria-label="Refresh repository preview"
                  title="Refresh status"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white/85"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
          <Step label="Source" state={states[0]} />
          <Step label="Install" state={states[1]} />
          <Step label="Build" state={states[2]} />
          <Step label="Preview" state={states[3]} />
        </div>
      </div>

      {job.phase === "ready" && previewUrl ? (
        <div>
          <div className="flex min-h-10 items-center gap-2 border-b border-white/[0.08] bg-white/[0.025] px-3">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-50" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-white/55">
              Rork edge preview · {expiryCopy(job.expiresAt)}
            </span>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Expand repository preview"
              title="Expand preview"
              className="flex h-7 w-7 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/85"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <PreviewFrame job={job} />
        </div>
      ) : (
        <div className="flex min-h-36 flex-col items-center justify-center gap-3 px-7 py-6 text-center">
          <span
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-2xl border",
              job.phase === "failed" ? "border-rose-300/20 bg-rose-300/[0.08]" : "border-white/10 bg-white/[0.04]",
            )}
          >
            {ACTIVE_PHASES.has(job.phase) ? (
              <Loader2 className="h-4 w-4 animate-spin text-cyan-200" />
            ) : job.phase === "failed" ? (
              <AlertTriangle className="h-4 w-4 text-rose-200" />
            ) : (
              <Box className="h-4 w-4 text-white/45" />
            )}
          </span>
          <div className="max-w-md">
            <p className="text-sm font-medium text-white/80">{copy.label}</p>
            <p className="mt-1 text-xs leading-relaxed text-white/40">{copy.detail}</p>
            {statusUnavailable ? (
              <p className="mt-2 text-[10px] text-amber-200/70">Live status is temporarily unavailable; the last durable state is shown.</p>
            ) : null}
          </div>
        </div>
      )}

      {(job.logs || (!readOnly && (terminal || ACTIVE_PHASES.has(job.phase)))) ? (
        <div className="border-t border-white/[0.08] bg-black/10">
          {job.logs ? (
            <button
              type="button"
              data-testid={TID.repoPreviewLogs}
              onClick={() => setShowLogs((value) => !value)}
              className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-[11px] text-white/45 transition-colors hover:bg-white/[0.03] hover:text-white/70"
            >
              <FileTerminal className="h-3.5 w-3.5" />
              <span>{showLogs ? "Hide build log" : "Show build log"}</span>
              <span className="ml-auto font-mono text-[9px] text-white/25">bounded · redacted</span>
            </button>
          ) : null}
          {showLogs && job.logs ? (
            <pre className="max-h-56 overflow-auto border-t border-white/[0.06] bg-[#091317] px-3 py-2.5 font-mono text-[10px] leading-relaxed text-white/55">
              {job.logs}
            </pre>
          ) : null}
          {!readOnly ? (
            <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-3 py-2.5">
              {ACTIVE_PHASES.has(job.phase) && onCancel ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid={TID.repoPreviewStop}
                  disabled={actionBusy}
                  onClick={onCancel}
                  className="h-8 gap-1.5 text-white/55 hover:bg-white/[0.06] hover:text-white"
                >
                  <Square className="h-3 w-3 fill-current" />
                  Stop
                </Button>
              ) : null}
              {terminal && onRebuild ? (
                <Button
                  type="button"
                  size="sm"
                  data-testid={TID.repoPreviewRebuild}
                  disabled={actionBusy}
                  onClick={onRebuild}
                  className="h-8 gap-1.5 bg-cyan-200 text-[#08202A] hover:bg-cyan-100"
                >
                  {actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                  Rebuild
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

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
    </div>
  );
});

/** Live status wrapper; the durable job remains recoverable after reload/tab close. */
export function RepoPreviewFlow({ initialJob, readOnly = false }: { initialJob: RepoPreviewJob; readOnly?: boolean }) {
  const { state, recordRepoPreview, updateRepoPreview } = useAgent();
  const queryClient = useQueryClient();
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const query = useQuery({
    queryKey: ["repo-preview", initialJob.id],
    queryFn: () => getRepoPreview(initialJob.id),
    initialData: initialJob,
    enabled: !readOnly,
    staleTime: 1_000,
    refetchInterval: (current) => {
      const job = current.state.data;
      return job && ACTIVE_PHASES.has(job.phase) ? 2_500 : false;
    },
    retry: 2,
  });
  const job = query.data ?? initialJob;
  const server = state.settings.mcpServers.find(
    (item) => item.enabled && (item.catalogId ?? item.id) === "github",
  );
  const conversationId = state.conversations.find((conversation) =>
    conversation.messages.some((message) => message.repoPreview?.id === initialJob.id),
  )?.id;

  useEffect(() => {
    if (job.phase !== initialJob.phase || job.expiresAt !== initialJob.expiresAt) {
      updateRepoPreview(job);
    }
  }, [initialJob.expiresAt, initialJob.phase, job, updateRepoPreview]);

  const resolveAuth = async (): Promise<string | undefined> => {
    if (!server) return undefined;
    try {
      return await resolveGitHubAuth(server);
    } catch {
      return undefined;
    }
  };

  const cancel = async (): Promise<void> => {
    setActionBusy(true);
    try {
      const next = await cancelRepoPreview(job.id, await resolveAuth());
      queryClient.setQueryData(["repo-preview", job.id], next);
      toast.success("Preview stopped");
    } catch (error) {
      toast.error("Could not stop the preview", { description: errorFromUnknown(error) });
    } finally {
      setActionBusy(false);
    }
  };

  const rebuild = async (): Promise<void> => {
    setActionBusy(true);
    try {
      const auth = await resolveAuth();
      if (!auth) throw new Error("Reconnect GitHub before rebuilding this repository.");
      const next = await startRepoPreview(
        {
          repository: job.repository,
          ref: job.ref,
          rootDirectory: job.rootDirectory,
          outputDirectory: job.outputDirectory,
        },
        auth,
      );
      recordRepoPreview(next, conversationId);
      toast.success("Fresh repository preview started", { description: `${job.repository}@${job.commitSha.slice(0, 7)}` });
    } catch (error) {
      toast.error("Could not rebuild the preview", { description: errorFromUnknown(error) });
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <RepoPreviewCard
      job={job}
      isRefreshing={query.isFetching}
      statusUnavailable={query.isError}
      readOnly={readOnly}
      onRefresh={() => void query.refetch()}
      onCancel={() => void cancel()}
      onRebuild={() => void rebuild()}
      actionBusy={actionBusy}
    />
  );
}
