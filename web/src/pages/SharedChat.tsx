import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Globe, Link2Off } from "lucide-react";
import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";

import { MessageList } from "@/components/gera/MessageList";
import { SparkMark } from "@/components/gera/Spark";
import { Button } from "@/components/ui/button";
import { fetchSharedChat } from "@/lib/shares";

/**
 * Public read-only view of a shared thread. Deliberately outside the
 * AccessGate: anyone with the link can read — no account, no invite.
 */
const SharedChat = () => {
  const { shareId } = useParams<{ shareId: string }>();

  const query = useQuery({
    queryKey: ["gera-share", shareId],
    queryFn: () => fetchSharedChat(shareId ?? ""),
    enabled: Boolean(shareId),
    staleTime: Infinity,
    retry: 1,
  });

  useEffect(() => {
    if (query.data) {
      document.title = `${query.data.title} — Gera AI`;
    }
    return () => {
      document.title = "Gera AI";
    };
  }, [query.data]);

  const sharedWhen = query.data
    ? new Date(query.data.updatedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";

  return (
    <div className="relative flex h-svh flex-col overflow-hidden">
      <div className="gera-atmosphere pointer-events-none absolute inset-0" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border/70 bg-background/70 px-3 py-2.5 backdrop-blur-xl sm:px-5">
          <Link to="/" className="flex shrink-0 items-center gap-2" aria-label="Gera home">
            <SparkMark className="h-6 w-6" />
            <span className="font-brand text-[19px] font-semibold leading-none tracking-tight">Gera</span>
          </Link>
          <span className="ml-1 rounded-full border border-border/70 bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground">
            Shared chat
          </span>
          <div className="ml-auto">
            <Button asChild className="h-9 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90">
              <Link to="/">
                Open Gera
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {query.isLoading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <SparkMark className="h-9 w-9 animate-pulse" />
              <p className="text-sm text-muted-foreground">Loading shared chat…</p>
            </div>
          ) : query.isError || !query.data ? (
            <div className="flex h-full items-center justify-center px-4">
              <div className="w-full max-w-sm rounded-3xl border border-border/70 bg-card p-6 text-center shadow-sm">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-ember/10">
                  <Link2Off className="h-5 w-5 text-ember" />
                </div>
                <h1 className="mt-3 font-display text-lg tracking-tight">This link doesn't work anymore</h1>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  It's invalid or was revoked by its owner. Ask them for a fresh link — or start your own
                  thread.
                </p>
                <Button asChild className="mt-4 h-9 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90">
                  <Link to="/">Open Gera</Link>
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="mx-auto w-full max-w-3xl px-4 pt-8">
                <h1 className="font-display text-2xl tracking-tight">{query.data.title}</h1>
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Globe className="h-3.5 w-3.5 text-ember" />
                  Public snapshot · {sharedWhen} · read-only
                </p>
              </div>
              <MessageList messages={query.data.snapshot.messages} streaming={false} readOnly />
              <div className="mx-auto w-full max-w-3xl px-4 pb-10">
                <div className="flex flex-col items-center gap-3 rounded-3xl border border-border/70 bg-card p-5 text-center shadow-sm sm:flex-row sm:text-left">
                  <SparkMark className="h-8 w-8 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-brand text-base font-semibold tracking-tight">Built with Gera</p>
                    <p className="text-sm text-muted-foreground">
                      Chat, deep research and a council of models — in one hub.
                    </p>
                  </div>
                  <Button asChild className="h-9 shrink-0 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90">
                    <Link to="/">
                      Try Gera
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SharedChat;
