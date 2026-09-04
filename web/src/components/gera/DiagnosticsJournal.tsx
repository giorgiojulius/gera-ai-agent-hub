import { CheckCircle2, ClipboardCopy, Trash2 } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import {
  bundleLabel,
  clearDiagnostics,
  listDiagnostics,
  markDiagnosticsSeen,
  subscribeDiagnostics,
  syncDiagnostics,
  type DiagnosticEntry,
} from "@/lib/diagnostics";
import { VaultStatusLine } from "@/components/gera/VaultStatusLine";
import { cn } from "@/lib/utils";

const SCOPE_STYLE: Record<string, string> = {
  api: "bg-ember/10 text-ember",
  chat: "bg-destructive/10 text-destructive",
  app: "bg-foreground/10 text-foreground",
  promise: "bg-muted text-muted-foreground",
  mcp: "bg-ember/10 text-ember",
};

function timeLabel(at: number): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function buildReport(entries: DiagnosticEntry[]): string {
  const lines = entries.map((entry) => {
    const head = `- [${new Date(entry.at).toISOString()}] ${entry.scope}: ${entry.message}`;
    return entry.detail ? `${head}\n  ${entry.detail.replace(/\n/g, "\n  ")}` : head;
  });
  const env =
    typeof navigator === "undefined"
      ? ""
      : `\nbundle: ${bundleLabel()}\nbrowser: ${navigator.userAgent}\npage: ${typeof location === "undefined" ? "" : location.pathname}`;
  return `Gera diagnostics — ${new Date().toISOString()}${env}\n${lines.join("\n")}`;
}

async function copyText(text: string, okMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMessage);
  } catch {
    toast.error("Could not copy — clipboard unavailable");
  }
}

/**
 * The account error journal: API failures, run crashes, uncaught errors —
 * synced with the cloud journal, visible only to this account. Shared by the
 * account-menu dialog and the admin panel's Diagnostics tab.
 */
export function DiagnosticsJournal({ frame }: { frame: "dialog" | "page" }) {
  const entries = useSyncExternalStore(subscribeDiagnostics, listDiagnostics);

  useEffect(() => {
    void syncDiagnostics(); // refresh from the account journal on mount
  }, []);

  useEffect(() => {
    markDiagnosticsSeen();
  }, [entries]);

  const copyReport = () => copyText(buildReport(entries), "Report copied");
  const copyEntry = (entry: DiagnosticEntry) =>
    copyText(
      `[${new Date(entry.at).toISOString()}] ${entry.scope}: ${entry.message}${entry.detail ? `\n${entry.detail}` : ""}\nbundle: ${bundleLabel()}`,
      "Entry copied",
    );

  const padX = frame === "dialog" ? "px-5" : "px-4 sm:px-5";

  if (entries.length === 0) {
    return (
      <>
        <VaultStatusLine className={cn("border-b border-border/50 py-2.5", padX)} />
        <div className={cn("flex flex-col items-center gap-2 py-14 text-center", padX)}>
          <CheckCircle2 className="h-9 w-9 text-gold" />
          <p className="text-sm font-medium">All clear</p>
          <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
            No errors recorded. If something breaks, it shows up here the moment it happens.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <VaultStatusLine className={cn("border-b border-border/50 py-2.5", padX)} />
      <div className={cn("overflow-y-auto", frame === "dialog" ? "max-h-[55vh]" : "max-h-[65vh]")}>
        {entries.map((entry) => (
          <div key={entry.id} className={cn("border-b border-border/50 py-3 last:border-b-0", padX)}>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  SCOPE_STYLE[entry.scope] ?? "bg-muted text-muted-foreground",
                )}
              >
                {entry.scope}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{timeLabel(entry.at)}</span>
            </div>
            <p className="mt-1.5 break-words text-sm leading-snug">{entry.message}</p>
            {entry.detail ? (
              <details className="mt-1.5">
                <summary className="flex cursor-pointer select-none items-center gap-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                  <span>Details</span>
                  <button
                    type="button"
                    aria-label="Copy this entry"
                    onClick={(event) => {
                      event.preventDefault();
                      void copyEntry(entry);
                    }}
                    className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <ClipboardCopy className="h-3 w-3" />
                    Copy
                  </button>
                </summary>
                <pre className="mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {entry.detail}
                </pre>
              </details>
            ) : null}
          </div>
        ))}
      </div>
      <div className={cn("flex items-center justify-between gap-2 border-t border-border/60 py-3", padX)}>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={`Running bundle: ${bundleLabel()}`}>
          {entries.length} {entries.length === 1 ? "entry" : "entries"} · account journal · {bundleLabel()}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              void copyReport();
            }}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy report
          </button>
          <button
            type="button"
            onClick={() => {
              clearDiagnostics();
              toast.success("Diagnostics cleared");
            }}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>
        </div>
      </div>
    </>
  );
}
