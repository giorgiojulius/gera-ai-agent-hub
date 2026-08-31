import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  ExternalLink,
  FileText,
  MinusCircle,
  ShieldCheck,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react";

import { TID } from "@/lib/testids";
import type { ExecutionOutcome, ExecutionOutcomeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

type StatusView = {
  label: string;
  Icon: LucideIcon;
  shell: string;
  icon: string;
  pill: string;
};

const STATUS_VIEW: Record<ExecutionOutcomeStatus, StatusView> = {
  completed: {
    label: "Ready",
    Icon: CheckCircle2,
    shell: "border-emerald-500/25 bg-emerald-500/[0.045]",
    icon: "text-emerald-600",
    pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  needs_review: {
    label: "Needs review",
    Icon: UserRoundCheck,
    shell: "border-amber-500/30 bg-amber-500/[0.055]",
    icon: "text-amber-600",
    pill: "bg-amber-500/12 text-amber-800 dark:text-amber-300",
  },
  blocked: {
    label: "Blocked",
    Icon: CircleSlash2,
    shell: "border-orange-500/30 bg-orange-500/[0.055]",
    icon: "text-orange-600",
    pill: "bg-orange-500/12 text-orange-800 dark:text-orange-300",
  },
  no_change: {
    label: "No material change",
    Icon: MinusCircle,
    shell: "border-border/70 bg-muted/35",
    icon: "text-muted-foreground",
    pill: "bg-foreground/[0.06] text-muted-foreground",
  },
  error: {
    label: "Error",
    Icon: AlertTriangle,
    shell: "border-destructive/30 bg-destructive/[0.045]",
    icon: "text-destructive",
    pill: "bg-destructive/10 text-destructive",
  },
};

function ownerLabel(outcome: ExecutionOutcome): string {
  if (outcome.handoff.kind === "gera") {
    return "Gera";
  }
  if (outcome.handoff.ownerName) {
    return outcome.handoff.ownerName;
  }
  return outcome.handoff.kind === "member" ? "Project member" : "Requester";
}

/** Compact execution receipt shared by chat, project channels, and screen assistant. */
export function ExecutionOutcomeCard({
  outcome,
  className,
}: {
  outcome: ExecutionOutcome;
  className?: string;
}) {
  const view = STATUS_VIEW[outcome.status];
  const verified = outcome.evidence.filter((item) => item.status === "verified").length;
  return (
    <details
      data-testid={TID.executionOutcome}
      className={cn(
        "group mt-3 overflow-hidden rounded-2xl border shadow-[0_10px_30px_-24px_rgba(0,0,0,0.45)]",
        view.shell,
        className,
      )}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-background/70 shadow-sm">
          <view.Icon className={cn("h-4 w-4", view.icon)} />
        </span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em]", view.pill)}>
          {view.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/80">{outcome.summary}</span>
        <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">
          {verified} proof{verified === 1 ? "" : "s"}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>

      <div className="space-y-3 border-t border-border/50 px-3 py-3">
        {outcome.artifacts.length > 0 ? (
          <section aria-label="Artifacts">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              <FileText className="h-3 w-3" />
              Artifact{outcome.artifacts.length === 1 ? "" : "s"}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {outcome.artifacts.map((artifact) => {
                const label = (
                  <>
                    <span className="max-w-[260px] truncate">{artifact.label}</span>
                    {artifact.url ? <ExternalLink className="h-3 w-3 shrink-0" /> : null}
                  </>
                );
                const classes =
                  "inline-flex min-h-7 items-center gap-1.5 rounded-lg border border-border/60 bg-background/70 px-2 py-1 text-[11px] font-medium";
                return artifact.url ? (
                  <a
                    key={artifact.id}
                    href={artifact.url}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(classes, "transition-colors hover:border-ember/40 hover:text-ember")}
                  >
                    {label}
                  </a>
                ) : (
                  <span key={artifact.id} className={classes}>
                    {label}
                  </span>
                );
              })}
            </div>
          </section>
        ) : null}

        {outcome.evidence.length > 0 ? (
          <section aria-label="Evidence">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              <ShieldCheck className="h-3 w-3" />
              Evidence
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              {outcome.evidence.map((evidence) => {
                const row = (
                  <>
                    {evidence.status === "verified" ? (
                      <Check className="h-3 w-3 shrink-0 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{evidence.label}</span>
                    {evidence.url ? <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
                  </>
                );
                const classes =
                  "flex min-h-7 items-center gap-1.5 rounded-lg bg-background/55 px-2 py-1 text-[11px] text-foreground/75";
                return evidence.url ? (
                  <a
                    key={evidence.id}
                    href={evidence.url}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(classes, "transition-colors hover:text-ember")}
                  >
                    {row}
                  </a>
                ) : (
                  <div key={evidence.id} className={classes}>
                    {row}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="rounded-xl border border-border/55 bg-background/55 px-2.5 py-2" aria-label="Handoff">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
            {outcome.handoff.kind === "gera" ? <Bot className="h-3 w-3" /> : <UserRoundCheck className="h-3 w-3" />}
            Next owner · {ownerLabel(outcome)}
          </p>
          <p className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-foreground/80">
            <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-ember" />
            {outcome.handoff.nextStep}
          </p>
          {outcome.handoff.unblockRequest ? (
            <p className="mt-1.5 rounded-lg bg-orange-500/10 px-2 py-1.5 text-xs leading-relaxed text-orange-900 dark:text-orange-200">
              Needed: {outcome.handoff.unblockRequest}
            </p>
          ) : null}
        </section>

        {outcome.validation === "downgraded" && outcome.validationReason ? (
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            Strict validation: {outcome.validationReason}
          </p>
        ) : null}
      </div>
    </details>
  );
}
