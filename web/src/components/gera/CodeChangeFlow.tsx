import {
  AlertTriangle,
  Braces,
  Check,
  CircleDashed,
  ExternalLink,
  FileCode2,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Loader2,
  Maximize2,
  MonitorPlay,
  Play,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { ArtifactLightbox } from "@/components/gera/artifacts/ArtifactShell";
import { safeCodePreviewUrl } from "@/lib/code-changes";
import { TID } from "@/lib/testids";
import type { CodeChangeFile, CodeChangeState, CodePreview } from "@/lib/types";
import { cn } from "@/lib/utils";

const HTML_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";
const REMOTE_SANDBOX = `${HTML_SANDBOX} allow-same-origin`;

type WorkbenchTab = "changes" | "preview";
type StepState = "waiting" | "running" | "done" | "error";

function previewValue(preview: CodePreview | undefined): { html?: string; url?: string } | null {
  if (!preview) {
    return null;
  }
  if (preview.kind === "html") {
    return preview.html.trim() ? { html: preview.html } : null;
  }
  const url = safeCodePreviewUrl(preview.url);
  return url ? { url } : null;
}

function statusCopy(flow: CodeChangeState): { label: string; detail: string } {
  const count = flow.files.length;
  if (flow.status === "running") {
    return {
      label: count > 0 ? "Editing code" : "Preparing changes",
      detail: count > 0 ? `${count} ${count === 1 ? "file" : "files"} in progress` : "Setting up the working branch",
    };
  }
  if (flow.status === "error") {
    return { label: "Changes need attention", detail: `${count} ${count === 1 ? "file" : "files"} captured` };
  }
  return { label: "Changes ready", detail: `${count} ${count === 1 ? "file" : "files"} changed` };
}

function phaseIcon(state: StepState): LucideIcon {
  if (state === "running") {
    return Loader2;
  }
  if (state === "done") {
    return Check;
  }
  if (state === "error") {
    return X;
  }
  return CircleDashed;
}

function Phase({ label, state }: { label: string; state: StepState }) {
  const Icon = phaseIcon(state);
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.11em]",
        state === "done" && "text-emerald-300",
        state === "running" && "text-amber-300",
        state === "error" && "text-rose-300",
        state === "waiting" && "text-white/35",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          state === "done" && "border-emerald-400/30 bg-emerald-400/10",
          state === "running" && "border-amber-300/30 bg-amber-300/10",
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

function fileActionLabel(file: CodeChangeFile): string {
  return file.action === "create"
    ? "new"
    : file.action === "delete"
      ? "deleted"
      : file.action === "patch"
        ? "patched"
        : "modified";
}

function FileStatusIcon({ file }: { file: CodeChangeFile }) {
  if (file.status === "running") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300" />;
  }
  if (file.status === "error") {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-300" />;
  }
  return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-emerald-300" />;
}

function DiffPane({ file }: { file: CodeChangeFile }) {
  const lines = useMemo(() => (file.patch ?? "").split("\n"), [file.patch]);
  return (
    <div className="min-w-0 overflow-hidden bg-[#181418]">
      <div className="flex min-h-10 items-center gap-2 border-b border-white/[0.07] px-3">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#D7A46D]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/75">{file.path}</span>
        <span className="shrink-0 font-mono text-[10px] text-emerald-300">+{file.additions}</span>
        <span className="shrink-0 font-mono text-[10px] text-rose-300">−{file.deletions}</span>
      </div>
      {file.error ? (
        <div className="border-b border-rose-300/10 bg-rose-400/[0.08] px-3 py-2 text-[11px] leading-relaxed text-rose-200">
          {file.error}
        </div>
      ) : null}
      {file.patch ? (
        <div className="max-h-[360px] overflow-auto py-2 font-mono text-[11px] leading-[1.65]">
          {lines.map((line, index) => {
            const marker = line.startsWith("@@");
            const added = !marker && line.startsWith("+");
            const deleted = !marker && line.startsWith("-");
            return (
              <div
                key={`${index}-${line.slice(0, 20)}`}
                className={cn(
                  "grid min-w-max grid-cols-[34px_minmax(0,1fr)] px-2",
                  added && "bg-emerald-400/[0.09] text-emerald-100",
                  deleted && "bg-rose-400/[0.09] text-rose-100",
                  marker && "my-1 bg-sky-400/[0.07] text-sky-200/70",
                  !added && !deleted && !marker && "text-white/55",
                )}
              >
                <span className="select-none text-center text-white/25">
                  {marker ? "··" : added ? "+" : deleted ? "−" : ""}
                </span>
                <span className="whitespace-pre pr-4">{marker ? line.slice(2) : line.slice(1)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-36 items-center justify-center px-5 text-center text-xs text-white/40">
          {file.status === "running" ? "The file diff is arriving…" : "No textual diff is available for this file."}
        </div>
      )}
      {file.truncated ? (
        <p className="border-t border-white/[0.06] px-3 py-1.5 text-[10px] text-white/35">
          Large diff — showing a bounded preview.
        </p>
      ) : null}
    </div>
  );
}

function ChangesPanel({
  flow,
  selectedId,
  onSelect,
}: {
  flow: CodeChangeState;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected = flow.files.find((file) => file.id === selectedId) ?? flow.files[0];
  if (!selected) {
    return (
      <div className="flex min-h-44 flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-amber-300/20 bg-amber-300/[0.08]">
          <GitBranch className="h-4 w-4 animate-pulse text-amber-300" />
        </span>
        <div>
          <p className="text-sm font-medium text-white/80">Working branch is being prepared</p>
          <p className="mt-1 text-xs text-white/40">Files will appear here as soon as the first write begins.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="grid min-h-0 sm:grid-cols-[190px_minmax(0,1fr)]">
      <div className="max-h-40 overflow-y-auto border-b border-white/[0.07] bg-white/[0.025] p-1.5 sm:max-h-[412px] sm:border-b-0 sm:border-r">
        {flow.files.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => onSelect(file.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
              selected.id === file.id ? "bg-white/[0.08]" : "hover:bg-white/[0.045]",
            )}
          >
            <FileStatusIcon file={file} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[11px] text-white/75">{file.path.split("/").pop()}</span>
              <span className="block truncate text-[9px] uppercase tracking-[0.1em] text-white/30">
                {fileActionLabel(file)}
              </span>
            </span>
            {file.status !== "running" ? (
              <span className="shrink-0 font-mono text-[9px] text-white/35">+{file.additions}/−{file.deletions}</span>
            ) : null}
          </button>
        ))}
      </div>
      <DiffPane file={selected} />
    </div>
  );
}

function PreviewFrame({ preview, full = false }: { preview: CodePreview; full?: boolean }) {
  const runnable = previewValue(preview);
  if (!runnable) {
    return null;
  }
  return (
    <iframe
      data-testid={TID.codeChangePreview}
      src={runnable.url}
      srcDoc={runnable.html}
      sandbox={runnable.url ? REMOTE_SANDBOX : HTML_SANDBOX}
      referrerPolicy="no-referrer"
      title={preview.kind === "url" ? "Live deployment preview" : "Code preview"}
      className={cn("w-full border-0 bg-white", full ? "h-full" : "h-[390px]")}
    />
  );
}

function PreviewPanel({
  flow,
  onExpand,
}: {
  flow: CodeChangeState;
  onExpand: () => void;
}) {
  const runnable = previewValue(flow.preview);
  if (!flow.preview || !runnable) {
    return (
      <div className="flex min-h-[250px] flex-col items-center justify-center gap-3 px-7 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04]">
          {flow.status === "running" ? (
            <Loader2 className="h-4 w-4 animate-spin text-amber-300" />
          ) : (
            <MonitorPlay className="h-4 w-4 text-white/45" />
          )}
        </span>
        <div className="max-w-sm">
          <p className="text-sm font-medium text-white/80">
            {flow.status === "running" ? "Looking for a runnable preview" : "No runnable preview was found"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/40">
            {flow.status === "running"
              ? "A committed HTML page or a deployment URL will start here automatically."
              : "The diff is ready. HTML edits run locally; hosted apps appear when the deployment provider returns a preview URL."}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex min-h-10 items-center gap-2 border-b border-white/[0.07] bg-white/[0.025] px-3">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-50" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-white/55">
          Preview running · {flow.preview.label}
        </span>
        {flow.preview.kind === "url" && runnable.url ? (
          <a
            href={runnable.url}
            target="_blank"
            rel="noreferrer"
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white/85"
          >
            Open
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand code preview"
          title="Expand preview"
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/85"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <PreviewFrame preview={flow.preview} />
    </div>
  );
}

/** Cursor-style code workbench: live files/diffs, verification, PR, and runnable preview. */
export const CodeChangeFlow = memo(function CodeChangeFlow({ flow }: { flow: CodeChangeState }) {
  const [selectedId, setSelectedId] = useState<string | null>(flow.files[0]?.id ?? null);
  const [manualTab, setManualTab] = useState<WorkbenchTab | null>(null);
  const [expanded, setExpanded] = useState<boolean>(false);
  const runnable = previewValue(flow.preview);
  const pullRequestUrl = flow.pullRequestUrl ? safeCodePreviewUrl(flow.pullRequestUrl) : null;
  const validationUrl = flow.validation?.url ? safeCodePreviewUrl(flow.validation.url) : null;
  const activeTab: WorkbenchTab = manualTab ?? (runnable && flow.status !== "running" ? "preview" : "changes");
  const copy = statusCopy(flow);
  const fileFailed = flow.files.some((file) => file.status === "error");
  const fileRunning = flow.files.some((file) => file.status === "running");
  const branchState: StepState = flow.branch ? "done" : flow.status === "running" ? "running" : "waiting";
  const editState: StepState = fileFailed ? "error" : fileRunning || flow.status === "running" ? "running" : flow.files.length > 0 ? "done" : "waiting";
  const checkState: StepState = flow.validation
    ? flow.validation.status === "passed"
      ? "done"
      : flow.validation.status === "failed"
        ? "error"
        : flow.validation.status === "running"
          ? "running"
          : "done"
    : flow.status === "running"
      ? "waiting"
      : "waiting";
  const previewState: StepState = runnable ? "done" : flow.status === "running" ? "running" : "waiting";

  useEffect(() => {
    if (selectedId && flow.files.some((file) => file.id === selectedId)) {
      return;
    }
    setSelectedId(flow.files[0]?.id ?? null);
  }, [flow.files, selectedId]);

  return (
    <div
      data-testid={TID.codeChangeFlow}
      className="mb-3 overflow-hidden rounded-2xl border border-[#3B3038] bg-[#211A1F] text-white shadow-[0_18px_55px_-38px_rgba(25,8,18,0.9)]"
    >
      <div className="border-b border-white/[0.07] bg-[radial-gradient(circle_at_0%_0%,rgba(155,76,111,0.2),transparent_42%),linear-gradient(135deg,rgba(255,255,255,0.035),transparent)] px-3.5 pb-3 pt-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#B7688D]/25 bg-[#B7688D]/10">
            <Braces className={cn("h-4 w-4 text-[#E8A9C6]", flow.status === "running" && "animate-pulse")} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm font-semibold tracking-[-0.01em] text-white/90">{copy.label}</p>
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em]",
                  flow.status === "running" && "border-amber-300/20 bg-amber-300/[0.08] text-amber-200",
                  flow.status === "done" && "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200",
                  flow.status === "error" && "border-rose-300/20 bg-rose-300/[0.08] text-rose-200",
                )}
              >
                {flow.status === "running" ? "live" : flow.status}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-white/40">
              {flow.repository ? `${flow.repository}${flow.branch ? ` · ${flow.branch}` : ""}` : copy.detail}
            </p>
          </div>
          {pullRequestUrl ? (
            <a
              href={pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[10px] font-medium text-white/65 transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              PR
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
          <Phase label="Branch" state={branchState} />
          <Phase label="Changes" state={editState} />
          <Phase label="Checks" state={checkState} />
          <Phase label="Preview" state={previewState} />
        </div>
      </div>

      <div className="flex h-11 items-center gap-1 border-b border-white/[0.07] px-2.5">
        <button
          type="button"
          data-testid={TID.codeChangeChangesTab}
          onClick={() => setManualTab("changes")}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium transition-colors",
            activeTab === "changes" ? "bg-white/[0.09] text-white/90" : "text-white/40 hover:text-white/70",
          )}
        >
          <FileDiff className="h-3.5 w-3.5" />
          Changes
          <span className="rounded-full bg-white/[0.07] px-1.5 py-px font-mono text-[9px] text-white/45">{flow.files.length}</span>
        </button>
        <button
          type="button"
          data-testid={TID.codeChangePreviewTab}
          onClick={() => setManualTab("preview")}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium transition-colors",
            activeTab === "preview" ? "bg-white/[0.09] text-white/90" : "text-white/40 hover:text-white/70",
          )}
        >
          <Play className="h-3.5 w-3.5" />
          Preview
          {runnable ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> : null}
        </button>
        {flow.validation ? (
          <a
            href={validationUrl ?? undefined}
            target={validationUrl ? "_blank" : undefined}
            rel={validationUrl ? "noreferrer" : undefined}
            className={cn(
              "ml-auto flex min-w-0 items-center gap-1.5 truncate px-1 text-[10px]",
              flow.validation.status === "passed" && "text-emerald-300/75",
              flow.validation.status === "failed" && "text-rose-300/75",
              flow.validation.status === "running" && "text-amber-300/75",
              flow.validation.status === "unknown" && "text-white/35",
              !validationUrl && "pointer-events-none",
            )}
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{flow.validation.label}</span>
          </a>
        ) : null}
      </div>

      {activeTab === "changes" ? (
        <ChangesPanel flow={flow} selectedId={selectedId} onSelect={setSelectedId} />
      ) : (
        <PreviewPanel flow={flow} onExpand={() => setExpanded(true)} />
      )}

      {flow.preview && runnable ? (
        <ArtifactLightbox
          open={expanded}
          onOpenChange={setExpanded}
          icon={MonitorPlay}
          title="Code preview"
          badge={flow.preview.kind === "url" ? "live" : "sandbox"}
        >
          <PreviewFrame preview={flow.preview} full />
        </ArtifactLightbox>
      ) : null}
    </div>
  );
});
