import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  pollGitHubDeviceToken,
  startGitHubDeviceFlow,
  type GitHubDeviceSession,
} from "@/lib/github-device";

/**
 * GitHub device-flow sign-in: shows the one-time code, opens
 * github.com/login/device, and polls until the member authorizes. GitHub
 * refuses dynamic client registration, so this uses the workspace's own
 * registered OAuth app — the same pattern VS Code uses.
 */
export function GitHubSignInDialog({
  open,
  onOpenChange,
  onSignedIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignedIn: () => void;
}) {
  const [session, setSession] = useState<GitHubDeviceSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [attempt, setAttempt] = useState<number>(0);

  useEffect(() => {
    if (!open) {
      setSession(null);
      setError(null);
      setCopied(false);
      return;
    }
    let cancelled = false;
    const isCancelled = () => cancelled;
    void (async () => {
      try {
        const started = await startGitHubDeviceFlow();
        if (isCancelled()) {
          return;
        }
        setSession(started);
        const ok = await pollGitHubDeviceToken(started, isCancelled);
        if (ok && !isCancelled()) {
          onSignedIn();
        }
      } catch (err) {
        if (!isCancelled()) {
          setError(err instanceof Error ? err.message : "GitHub sign-in failed.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, attempt, onSignedIn]);

  async function copyCode() {
    if (!session) {
      return;
    }
    try {
      await navigator.clipboard.writeText(session.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable — the code stays visible to type by hand.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Sign in with GitHub</DialogTitle>
          <DialogDescription>
            GitHub doesn't let apps register themselves for OAuth, so Gera uses this workspace's own
            GitHub OAuth app with the device flow — the same pattern VS Code uses. Enter the code on
            GitHub to authorize.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-destructive">{error}</p>
            <Button
              size="sm"
              className="h-8 rounded-full"
              onClick={() => {
                setError(null);
                setSession(null);
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : session ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={copyCode}
              className="w-full rounded-2xl border border-border/70 bg-card py-4 text-center font-mono text-2xl tracking-[0.3em] transition-colors hover:border-ember/50"
              title="Copy code"
            >
              {copied ? (
                <span className="flex items-center justify-center gap-2 text-base text-emerald-700">
                  <Check className="h-4 w-4" /> Copied
                </span>
              ) : (
                session.userCode
              )}
            </button>
            <Button
              className="w-full gap-1.5 rounded-full"
              onClick={() => window.open(session.verificationUri, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open github.com/login/device
            </Button>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              Waiting for authorization — this closes automatically once GitHub confirms.
            </p>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Requesting a code from GitHub…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
