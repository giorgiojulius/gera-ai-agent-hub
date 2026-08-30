import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, Copy, Maximize2, X, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Shared light card frame for rich artifacts (charts, diagrams, previews). */
export function ArtifactShell({
  icon: Icon,
  title,
  badge,
  actions,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  badge?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "gera-artifact my-3 overflow-hidden rounded-2xl border border-border/80 bg-card shadow-[0_1px_2px_rgba(35,20,28,0.04),0_14px_36px_-28px_rgba(35,20,28,0.3)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/70 bg-foreground/[0.03] px-3.5 py-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-ember" />
        <span className="min-w-0 truncate text-xs font-medium">{title}</span>
        {badge ? (
          <span className="shrink-0 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {badge}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</div>
      </div>
      {children}
    </div>
  );
}

export function ShellIconButton({
  icon: Icon,
  label,
  onClick,
  active = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
        active ? "bg-ember/10 text-ember" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/** Header button opening the artifact fullscreen — same treatment images get. */
export function ShellExpandButton({ onClick }: { onClick: () => void }) {
  return <ShellIconButton icon={Maximize2} label="Fullscreen" onClick={onClick} />;
}

/**
 * Fullscreen viewer for artifacts (charts, diagrams, maps, previews, code):
 * dark blurred backdrop, one big stage panel, Esc / backdrop click to close.
 */
export function ArtifactLightbox({
  open,
  onOpenChange,
  icon: Icon,
  title,
  badge,
  dark = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: LucideIcon;
  title: string;
  badge?: string;
  /** Dark stage for code-like content. */
  dark?: boolean;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/85 backdrop-blur-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[60] flex flex-col p-3 outline-none duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 sm:p-6"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              onOpenChange(false);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <div className="mx-auto flex h-full w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xl">
            <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-foreground/[0.03] px-4 py-2.5">
              <Icon className="h-4 w-4 shrink-0 text-ember" />
              <span className="min-w-0 truncate text-sm font-medium">{title}</span>
              {badge ? (
                <span className="shrink-0 rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {badge}
                </span>
              ) : null}
              <DialogPrimitive.Close
                aria-label="Close"
                className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
            <div className={cn("min-h-0 flex-1 overflow-auto", dark ? "bg-[#1F161C]" : "bg-card")}>{children}</div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ShellCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState<boolean>(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable — ignore
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy"
      aria-label="Copy"
      className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
