import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hourglass, Loader2, LogOut, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { SparkMark } from "@/components/gera/Spark";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccessStatus, submitAccessRequest } from "@/lib/access";

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09L2.18 7.07C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.86-3c-1.08.72-2.45 1.16-3.42 1.16-2.86 0-5.29-1.93-6.16-4.53l-3.66 2.84C3.99 20.53 7.7 23 12 23z"
      />
    </svg>
  );
}

function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path d="M17.05 20.28c-.98.95-2.05.86-3.08.38-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.38C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

function GateShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-svh flex-col items-center justify-center overflow-hidden px-4">
      <div className="gera-atmosphere pointer-events-none absolute inset-0" />
      <div className="relative z-10 w-full max-w-sm">{children}</div>
    </div>
  );
}

function GateCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-3xl border border-border/70 bg-card p-7 shadow-[0_2px_4px_rgba(35,20,28,0.05),0_44px_90px_-48px_rgba(122,46,80,0.5)]">
      {children}
    </div>
  );
}

/**
 * Invite-only gate: sign in with Google/Apple, then the backend decides —
 * invited unlocks the app, everyone else lands on the waitlist.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const { user, isLoading, isSigningIn, error, signIn, signOut, clearError } = useAuth();
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string>("");

  const statusQuery = useQuery({
    queryKey: ["access-status", user?.id ?? "anon"],
    queryFn: fetchAccessStatus,
    enabled: user !== null,
    refetchInterval: (query) => (query.state.data?.status === "invited" ? false : 15_000),
  });

  const requestMutation = useMutation({
    mutationFn: submitAccessRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["access-status"] });
    },
  });

  if (isLoading) {
    return (
      <GateShell>
        <div className="flex flex-col items-center gap-3">
          <SparkMark className="h-10 w-10 animate-pulse" />
        </div>
      </GateShell>
    );
  }

  if (!user) {
    return (
      <GateShell>
        <GateCard>
          <div className="flex flex-col items-center gap-1.5 text-center">
            <SparkMark className="h-11 w-11" />
            <h1 className="mt-2 font-brand text-3xl font-semibold tracking-tight">Gera</h1>
            <p className="text-sm text-muted-foreground">Agents, research and creation — in one place.</p>
          </div>
          {error ? (
            <div className="mt-5 flex items-start justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span className="min-w-0 break-words">{error}</span>
              <button type="button" onClick={clearError} className="shrink-0 underline">
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="mt-6 flex flex-col gap-2.5">
            <Button
              type="button"
              variant="outline"
              disabled={isSigningIn}
              onClick={() => void signIn("google")}
              className="h-11 w-full gap-2.5 rounded-full border-border/70 bg-background"
            >
              {isSigningIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <GoogleGlyph />}
              Continue with Google
            </Button>
            <Button
              type="button"
              disabled={isSigningIn}
              onClick={() => void signIn("apple")}
              className="h-11 w-full gap-2.5 rounded-full bg-foreground text-background hover:bg-foreground/90"
            >
              {isSigningIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <AppleGlyph />}
              Continue with Apple
            </Button>
          </div>
          <p className="mt-5 text-center text-xs text-muted-foreground">
            Gera is invite-only. Sign in to request access.
          </p>
        </GateCard>
      </GateShell>
    );
  }

  if (statusQuery.isPending) {
    return (
      <GateShell>
        <div className="flex flex-col items-center gap-3">
          <SparkMark className="h-10 w-10 animate-pulse" />
          <p className="text-sm text-muted-foreground">Checking access…</p>
        </div>
      </GateShell>
    );
  }

  if (statusQuery.isError) {
    return (
      <GateShell>
        <GateCard>
          <div className="flex flex-col items-center gap-2 text-center">
            <SparkMark className="h-10 w-10" />
            <h2 className="mt-1 font-display text-xl tracking-tight">Can’t check access</h2>
            <p className="text-sm text-muted-foreground">
              {statusQuery.error instanceof Error ? statusQuery.error.message : "Something went wrong."}
            </p>
          </div>
          <div className="mt-5 flex flex-col gap-2">
            <Button
              type="button"
              onClick={() => void statusQuery.refetch()}
              className="h-10 w-full gap-2 rounded-full bg-ember text-ember-foreground hover:bg-ember/90"
            >
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
            <Button type="button" variant="ghost" onClick={signOut} className="h-10 w-full gap-2 rounded-full">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </GateCard>
      </GateShell>
    );
  }

  const status = statusQuery.data;

  if (status.status === "invited") {
    return <>{children}</>;
  }

  if (status.status === "pending") {
    return (
      <GateShell>
        <GateCard>
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ember/15 text-ember">
              <Hourglass className="h-5 w-5" />
            </div>
            <h2 className="mt-1 font-display text-2xl tracking-tight">You’re on the list</h2>
            <p className="text-sm text-muted-foreground">
              Your request is in. The moment <span className="font-medium text-foreground">{status.email}</span> gets
              an invite, Gera unlocks automatically.
            </p>
          </div>
          <div className="mt-6 flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void statusQuery.refetch()}
              disabled={statusQuery.isFetching}
              className="h-10 w-full gap-2 rounded-full border-border/70"
            >
              <RefreshCw className={statusQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Check again
            </Button>
            <Button type="button" variant="ghost" onClick={signOut} className="h-10 w-full gap-2 rounded-full">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </GateCard>
      </GateShell>
    );
  }

  return (
    <GateShell>
      <GateCard>
        <div className="flex flex-col items-center gap-2 text-center">
          <SparkMark className="h-11 w-11" />
          <h2 className="mt-1 font-display text-2xl tracking-tight">Gera is invite-only</h2>
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{status.email}</span> — request access and
            you’ll get in as soon as you’re approved.
          </p>
        </div>
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Tell us a little about yourself (optional)"
          maxLength={500}
          className="mt-5 min-h-20 resize-none rounded-2xl border-border/70 bg-background"
        />
        {requestMutation.isError ? (
          <p className="mt-2 text-sm text-destructive">
            {requestMutation.error instanceof Error ? requestMutation.error.message : "Could not send the request."}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-2">
          <Button
            type="button"
            onClick={() => requestMutation.mutate(note.trim())}
            disabled={requestMutation.isPending}
            className="h-10 w-full gap-2 rounded-full bg-ember text-ember-foreground hover:bg-ember/90"
          >
            {requestMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Request access
          </Button>
          <Button type="button" variant="ghost" onClick={signOut} className="h-10 w-full gap-2 rounded-full">
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </GateCard>
    </GateShell>
  );
}
