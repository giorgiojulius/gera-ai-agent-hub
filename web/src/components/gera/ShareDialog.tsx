import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Copy, Globe, Loader2, RefreshCw, Scissors, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAgent } from "@/hooks/use-agent";
import {
  createShare,
  listShares,
  revokeShare,
  shareErrorMessage,
  shareUrl,
  type ShareRecord,
} from "@/lib/shares";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      document.body.removeChild(area);
    }
  }
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Publish / update / revoke the public link of the active thread. A link is a
 * frozen snapshot readable by anyone — no Gera account needed on the viewer's
 * side — and it stays stable across updates.
 */
export function ShareDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { active, state } = useAgent();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState<boolean>(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const running = active ? state.runningIds.includes(active.id) : false;

  const sharesQuery = useQuery({
    queryKey: ["gera-shares"],
    queryFn: listShares,
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const existing = active ? (sharesQuery.data ?? []).find((item) => item.chatId === active.id) : undefined;

  const flashCopied = () => {
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  const handleCopy = async (id: string) => {
    if (await copyText(shareUrl(id))) {
      flashCopied();
    } else {
      toast.error("Could not copy — select the link manually.");
    }
  };

  const publish = useMutation({
    mutationFn: async () => {
      if (!active) {
        throw new Error("No chat selected.");
      }
      return createShare(active);
    },
    onSuccess: async (record: ShareRecord, _vars, _ctx) => {
      const isUpdate = Boolean(existing);
      queryClient.setQueryData<ShareRecord[]>(["gera-shares"], (prev) => {
        const rest = (prev ?? []).filter((item) => item.id !== record.id);
        return [record, ...rest];
      });
      if (await copyText(shareUrl(record.id))) {
        flashCopied();
        toast.success(isUpdate ? "Snapshot updated — link copied" : "Public link created & copied");
      } else {
        toast.success(isUpdate ? "Snapshot updated" : "Public link created");
      }
    },
    onError: (error: unknown) => toast.error(shareErrorMessage(error)),
  });

  const revoke = useMutation({
    mutationFn: async () => {
      if (!existing) {
        throw new Error("not_found");
      }
      await revokeShare(existing.id);
      return existing.id;
    },
    onSuccess: (id: string) => {
      queryClient.setQueryData<ShareRecord[]>(["gera-shares"], (prev) =>
        (prev ?? []).filter((item) => item.id !== id),
      );
      toast.success("Link revoked — the page is gone");
    },
    onError: (error: unknown) => toast.error(shareErrorMessage(error)),
  });

  const busy = publish.isPending || revoke.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border/70 bg-[#F5EFF3] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-lg tracking-tight">Share this chat</DialogTitle>
          <DialogDescription>
            Anyone with the link can read a frozen snapshot of this thread — no Gera account needed.
          </DialogDescription>
        </DialogHeader>

        {!active || active.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">Start a conversation first, then share it.</p>
        ) : sharesQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-card px-3.5 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-ember" />
            Checking existing links…
          </div>
        ) : existing ? (
          <div className="space-y-3">
            <div className="flex items-center gap-1.5 rounded-2xl border border-border/70 bg-card p-1.5 shadow-sm">
              <input
                readOnly
                value={shareUrl(existing.id)}
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[13px] outline-none"
              />
              <Button
                size="sm"
                className="h-8 shrink-0 gap-1.5 rounded-xl bg-foreground px-3 text-background hover:bg-foreground/90"
                onClick={() => void handleCopy(existing.id)}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-gold" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Snapshot from {formatWhen(existing.updatedAt)}. Messages sent after that stay private until you
              update.
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="h-9 flex-1 gap-2 rounded-full border-border/70 bg-card hover:bg-secondary/70"
                disabled={busy || running}
                onClick={() => publish.mutate()}
              >
                {publish.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Update snapshot
              </Button>
              <Button
                variant="ghost"
                className="h-9 gap-2 rounded-full px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy}
                onClick={() => revoke.mutate()}
              >
                {revoke.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Revoke
              </Button>
            </div>
            {running ? (
              <p className="text-[11px] text-muted-foreground">
                A run is still streaming — wait for it to finish before updating.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2 rounded-2xl border border-border/70 bg-card px-3.5 py-3 shadow-sm">
              <p className="flex items-start gap-2 text-[13px]">
                <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
                Creates a public read-only page — viewers don't need an account or invite.
              </p>
              <p className="flex items-start gap-2 text-[13px]">
                <Camera className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
                It's a snapshot of this moment. Update or revoke the link anytime.
              </p>
              <p className="flex items-start gap-2 text-[13px]">
                <Scissors className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
                Very heavy images or files may be trimmed to keep the page light.
              </p>
            </div>
            <Button
              className="h-10 w-full gap-2 rounded-full bg-ember text-ember-foreground hover:bg-ember/90"
              disabled={busy || running}
              onClick={() => publish.mutate()}
            >
              {publish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
              Create public link
            </Button>
            {running ? (
              <p className="text-center text-[11px] text-muted-foreground">
                A run is still streaming — wait for it to finish before sharing.
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
