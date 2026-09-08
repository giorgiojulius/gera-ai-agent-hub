import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronDown,
  Coins,
  Compass,
  Copy,
  Download,
  Globe,
  ListTree,
  Loader2,
  PenLine,
  Pencil,
  Search,
  Sparkles,
  Telescope,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CodeChangeFlow } from "@/components/gera/CodeChangeFlow";
import { RepoPreviewFlow } from "@/components/gera/RepoPreviewFlow";
import { RunPauseCard } from "@/components/gera/RunPauseCard";
import { ExecutionOutcomeCard } from "@/components/gera/ExecutionOutcomeCard";
import { JuliusPanel } from "@/components/gera/JuliusPanel";
import { MediaAudioCard, MediaImageCard, MediaImageGrid, MediaVideoCard } from "@/components/gera/VaultMedia";
import { ToolCallMedia } from "@/components/gera/ToolCallMedia";
import { MarkdownBody } from "@/components/gera/Markdown";
import { SparkMark } from "@/components/gera/Spark";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAgent } from "@/hooks/use-agent";
import { useAutoGrow } from "@/hooks/use-autogrow";
import { estimateAnswerCost, estimateMediaCost } from "@/lib/arena";
import { isCodeMutationToolName } from "@/lib/code-changes";
import { downloadOrOpenMedia } from "@/lib/media-actions";
import { buildMessageTimeline, summarizeToolLabels, TOOL_GROUP_COLLAPSE_AT } from "@/lib/message-timeline";
import { findModel, formatUsd, modelShortName } from "@/lib/models";
import { TID } from "@/lib/testids";
import type { ChatMessage, ResearchSource, ResearchState, ResearchStep, ResearchStepKind, ToolCallRecord, TurnUsage } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Deferred-mode MCP meta functions — the row names the server and tool from the arguments. */
const MCP_SEARCH_TOOL = "mcp_search_tools";
const MCP_CALL_TOOL = "mcp_call_tool";

function parseToolArgs(call: ToolCallRecord): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // arguments still streaming — show the action without detail
    return {};
  }
}

/**
 * Human-readable label for a tool call row. SelfSurf calls render as a
 * browsing trail ("SelfSurf · open example.com") instead of raw tool names;
 * deferred MCP calls render as "MCP · server · tool" so they read exactly like
 * a natively armed tool.
 */
export function describeToolCall(call: ToolCallRecord): { name: string; detail?: string; surf: boolean } {
  if (call.name === MCP_SEARCH_TOOL || call.name === MCP_CALL_TOOL) {
    const args = parseToolArgs(call);
    const server = typeof args.serverId === "string" && args.serverId ? args.serverId : "";
    if (call.name === MCP_CALL_TOOL) {
      const tool = typeof args.toolName === "string" && args.toolName ? args.toolName : "…";
      return { name: "MCP", detail: `${server || "?"} · ${tool}`, surf: false };
    }
    const query = typeof args.query === "string" ? args.query.slice(0, 60) : "";
    return {
      name: "MCP",
      detail: `${server || "all servers"} · search${query ? ` “${query}”` : ""}`,
      surf: false,
    };
  }
  if (!call.name.startsWith("surf_")) {
    return { name: call.name, surf: false };
  }
  const args = parseToolArgs(call);
  const host = (value: unknown): string => {
    const raw = String(value ?? "");
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
    } catch {
      return raw.slice(0, 60);
    }
  };
  switch (call.name) {
    case "surf_open":
      return { name: "SelfSurf", detail: `open ${host(args.url)}`, surf: true };
    case "surf_follow":
      return { name: "SelfSurf", detail: `follow ${String(args.link ?? "").slice(0, 60)}`, surf: true };
    case "surf_submit":
      return { name: "SelfSurf", detail: `submit form ${String(args.form ?? "").slice(0, 12)}`, surf: true };
    case "surf_back":
      return { name: "SelfSurf", detail: "back", surf: true };
    case "surf_find":
      return { name: "SelfSurf", detail: `find “${String(args.query ?? "").slice(0, 40)}”`, surf: true };
    default:
      return { name: call.name, surf: true };
  }
}

export function MessageList({
  messages,
  streaming,
  readOnly = false,
  conversationId,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  /** Shared/public rendering: no edit-and-resend, no Julius winner picking. */
  readOnly?: boolean;
  /** Thread id — needed to answer elicitation cards of a live run. */
  conversationId?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      {messages.map((message, index) => {
        const isLast = index === messages.length - 1;
        return (
          <MessageBubble
            key={message.id}
            message={message}
            streaming={streaming && isLast && message.role === "assistant"}
            busy={streaming}
            readOnly={readOnly}
            conversationId={conversationId}
          />
        );
      })}
    </div>
  );
}

/**
 * Fullest citation list for [n] pills. Persistence caps message.sources to
 * keep localStorage small, but the research trail and the Julius shared list
 * keep every source — after a reload, high markers like [37] must still
 * resolve into pills instead of decaying to plain text.
 */
function citationSourcesOf(message: ChatMessage): ResearchSource[] {
  const lists = [message.sources ?? [], message.research?.sources ?? [], message.julius?.sources ?? []];
  return lists.reduce((best, list) => (list.length > best.length ? list : best), lists[0]);
}

function MessageBubble({
  message,
  streaming,
  busy,
  readOnly,
  conversationId,
}: {
  message: ChatMessage;
  streaming: boolean;
  busy: boolean;
  readOnly: boolean;
  conversationId?: string;
}) {
  if (message.role === "user") {
    return <UserBubble message={message} busy={busy} readOnly={readOnly} />;
  }

  const citationSources = citationSourcesOf(message);
  const ordinaryToolCalls = message.codeChanges
    ? (message.toolCalls ?? []).filter((call) => !isCodeMutationToolName(call.name))
    : message.toolCalls ?? [];

  return (
    <div className="flex gap-3" data-testid={TID.messageAssistant}>
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card shadow-sm">
        <SparkMark className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        {message.servedBy ? (
          <div className="mb-2">
            <span
              title={`The picked model was unavailable for this reply — the gateway answered with ${message.servedBy} instead.`}
              className="inline-flex items-center gap-1 rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-medium text-gold"
            >
              <TriangleAlert className="h-3 w-3" />
              answered by {modelShortName(message.servedBy)}
            </span>
          </div>
        ) : null}
        {message.toolPlan && message.toolPlan.length > 0 ? (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <Sparkles className="h-3 w-3 text-ember" />
              Auto tools
            </span>
            {message.toolPlan.map((label) => (
              <span key={label} className="rounded-full bg-ember/10 px-2 py-0.5 text-[11px] text-ember">
                {label}
              </span>
            ))}
          </div>
        ) : null}
        {message.research ? <ResearchCard research={message.research} /> : null}
        {message.julius ? (
          <JuliusPanel
            julius={message.julius}
            messageId={message.id}
            hasFinalContent={Boolean(message.content)}
            readOnly={readOnly}
          />
        ) : null}
        {message.codeChanges ? <CodeChangeFlow flow={message.codeChanges} /> : null}
        {message.repoPreview ? <RepoPreviewFlow initialJob={message.repoPreview} readOnly={readOnly} /> : null}
        {!readOnly && conversationId && streaming && message.pauses && message.pauses.length > 0
          ? message.pauses.map((request) => (
              <RunPauseCard key={request.id} request={request} conversationId={conversationId} />
            ))
          : null}
        <ReplyTimeline
          content={message.content}
          calls={ordinaryToolCalls}
          streaming={streaming}
          sources={citationSources}
          thinking={streaming && message.research?.status !== "running" && !message.julius && !message.repoPreview}
        />
        {message.images && message.images.length > 0 ? (
          <MediaImageGrid images={message.images} className="mt-3" />
        ) : null}
        {message.videos && message.videos.length > 0 ? (
          <div className="mt-3 space-y-3">
            {message.videos.map((src, videoIndex) => (
              <MediaVideoCard
                key={`${src.slice(0, 48)}-${videoIndex}`}
                src={src}
                downloadName={`gera-video-${videoIndex + 1}`}
                className="w-full max-w-[540px] rounded-2xl border border-border"
              />
            ))}
          </div>
        ) : null}
        {message.audioUrl ? (
          <MediaAudioCard className="mt-3" src={message.audioUrl} downloadName="gera-audio" />
        ) : null}
        {!streaming && message.execution ? <ExecutionOutcomeCard outcome={message.execution} /> : null}
        {message.interrupted && !streaming && !message.pending && !readOnly ? (
          <InterruptedNotice message={message} busy={busy} />
        ) : null}
        {!streaming && citationSources.length > 0 ? <SourcesStrip sources={citationSources} /> : null}
        {!streaming && message.content ? (
          <div className="-ml-1.5 mt-1.5 flex items-center gap-0.5">
            <CopyButton text={message.content} />
            {message.usage ? <UsageChip usage={message.usage} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The reply in reading order: the prose the model wrote, then the batch of
 * tool calls it led to, then the prose that followed. The commentary written
 * before a call is part of the answer and stays exactly where it was said —
 * never a wall of rows above a lone final paragraph.
 */
function ReplyTimeline({
  content,
  calls,
  streaming,
  sources,
  thinking,
}: {
  content: string;
  calls: ToolCallRecord[];
  streaming: boolean;
  sources: ResearchSource[];
  /** Streaming with no other live indicator (research trail, Julius, preview) on screen. */
  thinking: boolean;
}) {
  const timeline = useMemo(() => buildMessageTimeline(content, calls), [content, calls]);
  const last = timeline[timeline.length - 1];
  // Dots only while nothing visible is in motion: no text streaming in and no tool spinning.
  const showDots =
    thinking && (!last || (last.kind === "tools" && !last.calls.some((call) => call.status === "running")));
  return (
    <>
      {timeline.map((segment, index) =>
        segment.kind === "text" ? (
          <div key={segment.id} data-testid={TID.messageText}>
            <MarkdownBody text={segment.text} streaming={streaming && index === timeline.length - 1} sources={sources} />
          </div>
        ) : (
          <ToolCallGroup key={segment.id} calls={segment.calls} />
        ),
      )}
      {showDots ? <TypingDots /> : null}
    </>
  );
}

/** "MCP · deepwiki · ask_question" / "mcp_github_get_job_logs" — the label a row shows, for headers and summaries. */
function toolLabel(call: ToolCallRecord): string {
  const view = describeToolCall(call);
  return view.detail ? `${view.name} · ${view.detail}` : view.name;
}

function hasToolMedia(call: ToolCallRecord): boolean {
  return (call.images?.length ?? 0) > 0 || (call.files?.length ?? 0) > 0;
}

function ToolStatusIcon({ status, className }: { status: ToolCallRecord["status"]; className?: string }) {
  if (status === "running") {
    return <Loader2 className={cn("h-3.5 w-3.5 shrink-0 animate-spin text-ember", className)} />;
  }
  if (status === "error") {
    return <Wrench className={cn("h-3.5 w-3.5 shrink-0 text-destructive", className)} />;
  }
  return <Check className={cn("h-3.5 w-3.5 shrink-0 text-gold", className)} />;
}

/**
 * One batch of calls issued at the same point of the reply. Up to three calls
 * list as rows; a longer batch (eight log fetches in a row) collapses into a
 * single summary row — count, distinct tools with repeat counts, the call in
 * flight — so the commentary around it stays the thing the eye lands on.
 * Media a call returned stays visible even while the rows are folded.
 */
function ToolCallGroup({ calls }: { calls: ToolCallRecord[] }) {
  const collapsible = calls.length >= TOOL_GROUP_COLLAPSE_AT;
  const [open, setOpen] = useState<boolean>(false);
  const expanded = !collapsible || open;
  const running = calls.filter((call) => call.status === "running");
  const failed = calls.filter((call) => call.status === "error").length;
  const status: ToolCallRecord["status"] = running.length > 0 ? "running" : failed > 0 ? "error" : "done";
  const mediaCalls = calls.filter(hasToolMedia);
  return (
    <div
      data-testid={TID.messageToolGroup}
      className="my-3 overflow-hidden rounded-xl border border-border/70 bg-card text-xs shadow-sm first:mt-0"
    >
      {collapsible ? (
        <button
          type="button"
          data-testid={TID.messageToolGroupToggle}
          aria-expanded={expanded}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-foreground/[0.03]"
        >
          <ToolStatusIcon status={status} />
          <span className="shrink-0 font-medium">{calls.length} tool calls</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {running.length > 0 ? `now · ${toolLabel(running[0])}` : summarizeToolLabels(calls.map(toolLabel))}
          </span>
          <span className={cn("ml-auto shrink-0 text-muted-foreground", status === "running" && "animate-pulse")}>
            {status === "running" ? "running" : failed > 0 ? `${failed} failed` : "done"}
          </span>
          <ChevronDown
            className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
          />
        </button>
      ) : null}
      {expanded ? (
        <div className={cn("flex flex-col", collapsible && "border-t border-border/60")}>
          {calls.map((call, index) => (
            <ToolCallRow key={call.id} call={call} divided={index > 0} />
          ))}
        </div>
      ) : mediaCalls.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border/60 px-3 py-2">
          {mediaCalls.map((call) => (
            <ToolCallMedia key={call.id} images={call.images} files={call.files} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolCallRow({ call, divided }: { call: ToolCallRecord; divided: boolean }) {
  const view = describeToolCall(call);
  const media = hasToolMedia(call);
  return (
    <div
      data-testid={TID.messageToolCall}
      className={cn("flex gap-2 px-3 py-2", media ? "flex-col" : "items-center", divided && "border-t border-border/60")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ToolStatusIcon status={call.status} />
        {view.surf ? <Compass className="h-3.5 w-3.5 shrink-0 text-ember" /> : null}
        <span className="shrink-0 font-medium">{view.name}</span>
        {view.detail ? <span className="min-w-0 truncate text-muted-foreground">{view.detail}</span> : null}
        <span className={cn("ml-auto shrink-0 text-muted-foreground", call.status === "running" && "animate-pulse")}>
          {call.status === "running" ? "running" : call.status === "error" ? "failed" : "done"}
        </span>
      </div>
      {media ? <ToolCallMedia images={call.images} files={call.files} /> : null}
    </div>
  );
}

/**
 * An unresolved saved reply is not proof that a reload stopped the server.
 * Wait for boot reconciliation before offering an explicit continuation.
 * Text partials offer Continue — the reply picks up in the same bubble;
 * empty turns offer Retry. Julius panels with usable candidates recover
 * through their own pick UI, so they get the marker without a button.
 */
function InterruptedNotice({ message, busy }: { message: ChatMessage; busy: boolean }) {
  const { resumeInterrupted, retryInterrupted, isRecoveringRuns, runRecoveryRetrySeconds, recheckServerRuns } = useAgent();
  const hasText = message.content.trim().length > 0;
  const julius = message.julius;
  const juliusRecovers = Boolean(julius && (julius.status === "choice" || julius.status === "done"));
  const action: "continue" | "retry" | null = juliusRecovers
    ? null
    : julius
      ? "retry"
      : hasText
        ? "continue"
        : "retry";
  return (
    <div
      data-testid={TID.messageRecoveryNotice}
      role="status"
      className={cn("mt-2.5 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs", isRecoveringRuns ? "border-border bg-muted/30" : "border-ember/30 bg-ember/5")}
    >
      {isRecoveringRuns
        ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        : <AlertCircle className="h-3.5 w-3.5 shrink-0 text-ember" />}
      <span className="min-w-0 flex-1 text-muted-foreground">
        {isRecoveringRuns
          ? runRecoveryRetrySeconds != null
            ? `Connection unavailable. Retrying status in ${runRecoveryRetrySeconds}s — your draft is preserved.`
            : "Checking saved run status… Your draft is preserved."
          : hasText
            ? "Completion wasn't confirmed. This saved reply may be incomplete."
            : "Completion wasn't confirmed. No reply is available in this saved turn."}
      </span>
      {!busy && (!isRecoveringRuns || runRecoveryRetrySeconds != null) ? (
        <button
          data-testid={TID.messageRecoveryCheck}
          type="button"
          onClick={recheckServerRuns}
          className="shrink-0 rounded-full border border-border px-3 py-1 font-medium transition-colors hover:bg-muted"
        >
          Check now
        </button>
      ) : null}
      {action && !busy && !isRecoveringRuns ? (
        <button
          data-testid={TID.messageRecoveryAction}
          type="button"
          onClick={() =>
            action === "continue" ? resumeInterrupted(message.id) : retryInterrupted(message.id)
          }
          className="shrink-0 rounded-full bg-foreground px-3 py-1 font-medium text-background transition-opacity hover:opacity-90"
        >
          {action === "continue" ? "Continue" : "Retry"}
        </button>
      ) : null}
    </div>
  );
}

/** User bubble with copy and edit-and-resend controls. */
function UserBubble({ message, busy, readOnly }: { message: ChatMessage; busy: boolean; readOnly: boolean }) {
  const { editMessage } = useAgent();
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");
  // The edit box grows with the draft (smoothly, via the height transition)
  // and scrolls past its cap — long messages stay fully reviewable.
  const editRef = useAutoGrow(draft, 320);
  const hasFiles = (message.attachments?.length ?? 0) > 0;

  const submitEdit = () => {
    const text = draft.trim();
    if (!text && !hasFiles) {
      return;
    }
    setEditing(false);
    editMessage(message.id, text);
  };

  return (
    <div className={cn("group ml-auto max-w-[85%] sm:max-w-[72%]", editing && "w-full")} data-testid={TID.messageUser}>
      {message.attachments && message.attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap justify-end gap-2">
          {message.attachments.map((file) =>
            file.mime.startsWith("image/") && file.dataUrl ? (
              <MediaImageCard
                key={file.id}
                src={file.dataUrl}
                alt={file.name}
                downloadName={file.name}
                caption={file.name}
                hideActions
                className="h-20 w-20 rounded-xl border border-border/60"
                imgClassName="h-20 w-20 object-cover"
              />
            ) : file.dataUrl ? (
              <button
                key={file.id}
                type="button"
                onClick={() => void downloadOrOpenMedia(file.dataUrl, file.name)}
                title={`Download ${file.name}`}
                className="flex items-center gap-1.5 rounded-lg bg-foreground/10 px-2 py-1 text-[11px] transition-colors hover:bg-foreground/20"
              >
                <Download className="h-3 w-3" />
                <span className="max-w-40 truncate">{file.name}</span>
              </button>
            ) : (
              <span key={file.id} className="rounded-lg bg-foreground/10 px-2 py-1 text-[11px]">
                {file.name}
              </span>
            ),
          )}
        </div>
      ) : null}
      {editing ? (
        <div className="rounded-3xl rounded-br-md border border-border bg-card p-2 shadow-sm">
          <textarea
            ref={editRef}
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitEdit();
              } else if (event.key === "Escape") {
                setEditing(false);
              }
            }}
            rows={2}
            className="min-h-[60px] w-full resize-none bg-transparent px-2 py-1.5 text-[15px] leading-relaxed outline-none transition-[height] duration-200 ease-out motion-reduce:transition-none"
          />
          <div className="flex items-center justify-end gap-1.5 px-1 pb-0.5">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitEdit}
              disabled={!draft.trim() && !hasFiles}
              className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap rounded-3xl rounded-br-md bg-foreground px-4 py-3 text-[15px] leading-relaxed text-background shadow-sm">
          {message.content}
        </div>
      )}
      {editing ? null : (
        <div className="mt-1 flex items-center justify-end gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
          <CopyButton text={message.content} />
          {busy || readOnly ? null : (
            <ActionIconButton
              label="Edit & resend"
              onClick={() => {
                setDraft(message.content);
                setEditing(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </ActionIconButton>
          )}
        </div>
      )}
    </div>
  );
}

/** Copies text to the clipboard and flashes a check for a moment. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState<boolean>(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      fallbackCopy(text);
    }
    setCopied(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <ActionIconButton label={copied ? "Copied" : "Copy"} onClick={() => { void handleCopy(); }}>
      {copied ? <Check className="h-3.5 w-3.5 text-gold" /> : <Copy className="h-3.5 w-3.5" />}
    </ActionIconButton>
  );
}

function ActionIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 10_000) {
    return `${Math.round(count / 1000)}K`;
  }
  if (count >= 1_000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return String(count);
}

/** One display row inside the run-cost popover. */
type UsageChipRow = {
  key: string;
  name: string;
  detail: string;
  cost: number | undefined;
  tag?: string;
};

function tokenDetail(tokens: { prompt: number; completion: number; calls: number; cached?: number; reasoning?: number }): string {
  const inPart = `${formatTokens(tokens.prompt)} in${tokens.cached ? ` (${formatTokens(tokens.cached)} cached)` : ""}`;
  const outPart = `${formatTokens(tokens.completion)} out${tokens.reasoning ? ` (${formatTokens(tokens.reasoning)} think)` : ""}`;
  return `${inPart} · ${outPart} · ${tokens.calls}×`;
}

function mediaDetail(tally: { images?: number; videoSeconds?: number; speechChars?: number }): string {
  const parts: string[] = [];
  if (tally.images) {
    parts.push(tally.images === 1 ? "1 image" : `${tally.images} images`);
  }
  if (tally.videoSeconds) {
    parts.push(`${tally.videoSeconds}s video`);
  }
  if (tally.speechChars) {
    parts.push(`${formatTokens(tally.speechChars)} chars TTS`);
  }
  return parts.join(" · ");
}

/**
 * Price tag for the whole run. Tokens are metered locally from every LLM call
 * of the turn (chat + router + research + Julius); media generation is billed
 * per asset; the dollar figure prices everything at the gateway's current
 * list rates — an estimate, not a bill. Provider-cached input is priced at
 * the cache-read rate when the provider reported it.
 */
function UsageChip({ usage }: { usage: TurnUsage }) {
  const { models } = useAgent();
  const answerRows: UsageChipRow[] = Object.entries(usage.byModel)
    .map(([modelId, tokens]) => {
      const model = findModel(models, modelId);
      return {
        key: `llm:${modelId}`,
        name: model?.name ?? modelId,
        detail: tokenDetail(tokens),
        cost: estimateAnswerCost(model, tokens),
        sortTokens: tokens.prompt + tokens.completion,
      };
    })
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.sortTokens - a.sortTokens);
  const mediaRows: UsageChipRow[] = Object.entries(usage.media ?? {}).map(([modelId, tally]) => {
    const model = findModel(models, modelId);
    return {
      key: `media:${modelId}`,
      name: model?.name ?? modelId,
      detail: mediaDetail(tally),
      cost: estimateMediaCost(model, tally),
      tag: "media",
    };
  });
  const serviceRows: UsageChipRow[] = Object.entries(usage.serviceByModel ?? {}).map(([modelId, tokens]) => {
    const model = findModel(models, modelId);
    return {
      key: `svc:${modelId}`,
      name: model?.name ?? modelId,
      detail: tokenDetail(tokens),
      cost: estimateAnswerCost(model, tokens),
      tag: "service",
    };
  });
  const rows: UsageChipRow[] = [...answerRows, ...mediaRows, ...serviceRows];
  const pricedCost = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const hasPrice = rows.some((row) => row.cost != null);
  const unpriced = rows.filter((row) => row.cost == null).length;
  const totalTokens = usage.prompt + usage.completion;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Run cost"
          aria-label="Run cost"
          className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Coins className="h-3.5 w-3.5" />
          {hasPrice ? `≈${formatUsd(pricedCost)}` : `${formatTokens(totalTokens)} tok`}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-80 rounded-2xl border-border/70 p-0">
        <div className="border-b border-border/60 px-3.5 py-2.5">
          <p className="text-sm font-medium">Run cost</p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {formatTokens(usage.prompt)} in · {formatTokens(usage.completion)} out · {usage.calls}{" "}
            {usage.calls === 1 ? "call" : "calls"}
          </p>
        </div>
        <div className="max-h-64 overflow-y-auto px-3.5 py-1.5">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <span className="truncate">{row.name}</span>
                  {row.tag ? (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {row.tag}
                    </span>
                  ) : null}
                </p>
                <p className="text-[11px] tabular-nums text-muted-foreground">{row.detail}</p>
              </div>
              <span className="shrink-0 text-xs tabular-nums">
                {row.cost != null ? `≈${formatUsd(row.cost)}` : "—"}
              </span>
            </div>
          ))}
        </div>
        <p className="border-t border-border/60 px-3.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Estimate from gateway list prices
          {unpriced > 0 ? ` · ${unpriced} row${unpriced > 1 ? "s" : ""} without a listed rate` : ""}. Media is
          priced per asset (images, video seconds, TTS characters); cached input uses the provider's cache-read
          rate when reported. “Service” = internal helpers: tool router, research planner, titles.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function fallbackCopy(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  try {
    document.execCommand("copy");
  } catch {
    // clipboard unavailable in this context
  }
  document.body.removeChild(area);
}

/**
 * Systemic citations: these chips come from tool calls that actually ran this
 * turn — the list is collected by the tool layer, not written by the model.
 */
function SourcesStrip({ sources }: { sources: ResearchSource[] }) {
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        <Globe className="h-3 w-3 text-ember" />
        Sources · {sources.length}
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {sources.map((source, index) => {
          let domain = source.url;
          try {
            domain = new URL(source.url).hostname.replace(/^www\./, "");
          } catch {
            // keep the raw URL as label
          }
          const favicon = faviconUrl(source.url);
          return (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              title={source.title && source.title !== source.url ? source.title : source.url}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm transition-colors hover:border-ember/40 hover:text-foreground"
            >
              <span className="font-semibold text-ember">{index + 1}</span>
              {favicon ? (
                <img
                  src={favicon}
                  alt=""
                  loading="lazy"
                  className="h-3.5 w-3.5 rounded-sm"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              ) : null}
              <span className="max-w-[150px] truncate">{domain}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

const STEP_ICON: Record<ResearchStepKind, LucideIcon> = {
  plan: ListTree,
  search: Search,
  read: BookOpen,
  browse: Compass,
  synthesize: PenLine,
};

function faviconUrl(url: string): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  } catch {
    return "";
  }
}

function ResearchStepRow({ step }: { step: ResearchStep }) {
  const Icon = STEP_ICON[step.kind];
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon className="h-3.5 w-3.5 shrink-0 text-ember/80" />
      <span className="min-w-0 flex-1 truncate">
        {step.label}
        {step.detail ? <span className="ml-1.5 text-muted-foreground">{step.detail}</span> : null}
      </span>
      {step.status === "running" ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-ember" />
      ) : step.status === "error" ? (
        <AlertCircle className="h-3 w-3 shrink-0 text-destructive/70" />
      ) : (
        <Check className="h-3 w-3 shrink-0 text-gold" />
      )}
    </div>
  );
}

/** Grok-style research trail: live steps while running, compact summary after. */
function ResearchCard({ research }: { research: ResearchState }) {
  const running = research.status === "running";
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? running;
  const [, setTick] = useState<number>(0);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const seconds = Math.max(0, Math.round(((research.finishedAt ?? Date.now()) - research.startedAt) / 1000));
  const searchCount = research.steps.filter((step) => step.kind === "search").length;
  const browseCount = research.steps.filter((step) => step.kind === "browse").length;
  const currentStep = running ? [...research.steps].reverse().find((step) => step.status === "running") : undefined;
  const summary = running
    ? currentStep?.label ?? "Working…"
    : research.status === "error"
      ? `Stopped · ${research.sources.length} sources`
      : `${research.sources.length} sources · ${searchCount} searches${browseCount > 0 ? ` · ${browseCount} browsed` : ""} · ${seconds}s`;

  return (
    <div className="mb-3 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <Telescope className={cn("h-4 w-4 shrink-0 text-ember", running && "animate-pulse")} />
        <span className="shrink-0 text-sm font-medium">Deep research</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs text-muted-foreground", running && "animate-pulse")}>
          {summary}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3.5 py-2.5">
          <div className="flex flex-col gap-1.5">
            {research.steps.map((step) => (
              <ResearchStepRow key={step.id} step={step} />
            ))}
          </div>
          {research.sources.length > 0 ? (
            <div className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2.5">
              <div className="flex -space-x-1.5">
                {research.sources.slice(0, 10).map((source) => {
                  const src = faviconUrl(source.url);
                  return src ? (
                    <img
                      key={source.url}
                      src={src}
                      alt=""
                      loading="lazy"
                      className="h-5 w-5 rounded-full border border-card bg-card object-cover"
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  ) : null;
                })}
              </div>
              <span className="text-[11px] text-muted-foreground">
                {research.sources.length} sources
                {research.sources.length > 10 ? ` · +${research.sources.length - 10} more` : ""}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TypingDots() {
  // mt-1 + h-8 mirrors the avatar circle so the label + dots sit on its vertical center.
  return (
    <div className="mt-1 flex h-8 items-center gap-2">
      <span className="gera-thinking-label text-[13px] font-medium">Gera is thinking</span>
      <span className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember [animation-delay:-0.2s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember [animation-delay:-0.1s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember" />
      </span>
    </div>
  );
}
