import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AtSign,
  Hourglass,
  Loader2,
  MailPlus,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Swords,
  UserRoundX,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ArenaStudio } from "@/components/gera/ArenaStudio";
import { DiagnosticsJournal } from "@/components/gera/DiagnosticsJournal";
import { StudioPageHero, StudioPageShell } from "@/components/gera/StudioPageShell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  accessStats,
  dismissRequest,
  fetchAccessOverview,
  fetchAccessStatus,
  filterAccessOverview,
  inviteEmail,
  revokeInvite,
  setAccessRole,
  sortInvites,
  type AccessOverview,
  type InviteEntry,
  type RequestEntry,
} from "@/lib/access";
import { cn } from "@/lib/utils";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Who invited this member, in plain words. */
function invitedByLabel(entry: InviteEntry): string {
  if (!entry.invitedBy || entry.invitedBy === "seed") {
    return "seeded";
  }
  if (entry.invitedBy.startsWith("domain:")) {
    return `auto · ${entry.invitedBy.slice(7)}`;
  }
  return `by ${entry.invitedBy}`;
}

type AdminTab = "people" | "arena" | "diagnostics";

const ADMIN_TABS: { id: AdminTab; label: string; icon: typeof Users }[] = [
  { id: "people", label: "People", icon: Users },
  { id: "arena", label: "Arena", icon: Swords },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];

function normalizeTab(raw: string | null): AdminTab {
  return raw === "arena" || raw === "diagnostics" ? raw : "people";
}

/**
 * Full-page admin control room: members/roles/invites, the model arena
 * (usage standings + blind duels), and the error journal — one page,
 * three sections, deep-linkable via ?tab=.
 */
export default function AdminPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = normalizeTab(searchParams.get("tab"));
  const statusQuery = useQuery({
    queryKey: ["access-status", user?.id ?? "anon"],
    queryFn: fetchAccessStatus,
    enabled: user !== null,
  });

  return (
    <StudioPageShell active="admin">
      <StudioPageHero
        title="Admin"
        subtitle="The workspace control room — members, roles and the waitlist; live model standings and blind duels; and the error journal."
      />
      {statusQuery.isPending ? (
        <div className="mt-8 flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : statusQuery.data?.role === "admin" ? (
        <>
          <nav
            aria-label="Admin sections"
            className="mt-6 flex w-fit items-center gap-0.5 rounded-full border border-border/70 bg-foreground/[0.04] p-0.5"
          >
            {ADMIN_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={tab === item.id ? "page" : undefined}
                onClick={() => setSearchParams(item.id === "people" ? {} : { tab: item.id }, { replace: true })}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                  tab === item.id ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <item.icon className={cn("h-3.5 w-3.5", tab === item.id && "text-ember")} />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="mt-6">
            {tab === "people" ? <AdminPanel selfEmail={statusQuery.data.email} /> : null}
            {tab === "arena" ? <ArenaSection /> : null}
            {tab === "diagnostics" ? <DiagnosticsSection /> : null}
          </div>
        </>
      ) : (
        <div className="mt-8">
          <AdminsOnly />
        </div>
      )}
    </StudioPageShell>
  );
}

function ArenaSection() {
  return (
    <div>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Standings build themselves from every member's real usage — each turn reports model, outcome, token
        counts and media units, never message content. Blind duels stay for manual quality checks.
      </p>
      <ArenaStudio />
    </div>
  );
}

function DiagnosticsSection() {
  return (
    <section className="gera-card overflow-hidden rounded-3xl">
      <div className="border-b border-border/60 px-4 py-3.5 sm:px-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-ember" />
          Error journal
        </h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          API failures, run crashes and uncaught errors from your account — synced across your devices,
          visible only to you. Members see their own journal from the account menu.
        </p>
      </div>
      <DiagnosticsJournal frame="page" />
    </section>
  );
}

function AdminsOnly() {
  const navigate = useNavigate();
  return (
    <div className="gera-card mx-auto max-w-md rounded-3xl p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ember/15 text-ember">
        <ShieldCheck className="h-5 w-5" />
      </div>
      <h2 className="mt-3 font-display text-xl tracking-tight">Admins only</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        This page manages invites and roles, so it's limited to admins. If you need access, ask one to promote you.
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => navigate("/")}
        className="mt-5 h-10 rounded-full border-border/70 px-5"
      >
        Back to chat
      </Button>
    </div>
  );
}

function AdminPanel({ selfEmail }: { selfEmail: string }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ["access-overview"],
    queryFn: fetchAccessOverview,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["access-overview"] });
  };

  const inviteMutation = useMutation({
    mutationFn: inviteEmail,
    onSuccess: (_, target) => {
      toast.success(`Invited ${target}`);
      setEmail("");
      invalidate();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not send the invite"),
  });

  const revokeMutation = useMutation({
    mutationFn: revokeInvite,
    onSuccess: (_, target) => {
      toast.success(`Revoked ${target}`);
      invalidate();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not revoke the invite"),
  });

  const roleMutation = useMutation({
    mutationFn: ({ email: target, role }: { email: string; role: "admin" | "member" }) => setAccessRole(target, role),
    onSuccess: (_, { email: target, role }) => {
      toast.success(role === "admin" ? `${target} is now an admin` : `${target} is now a member`);
      invalidate();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not change the role"),
  });

  const dismissMutation = useMutation({
    mutationFn: dismissRequest,
    onSuccess: (_, target) => {
      toast.success(`Dismissed ${target}`);
      invalidate();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not dismiss the request"),
  });

  if (overview.isPending) {
    return (
      <div className="flex justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (overview.isError) {
    return (
      <div className="gera-card mx-auto max-w-md rounded-3xl p-8 text-center">
        <h2 className="font-display text-xl tracking-tight">Can't load the registry</h2>
        <p className="mt-1.5 text-sm text-destructive">
          {overview.error instanceof Error ? overview.error.message : "Something went wrong."}
        </p>
        <Button
          type="button"
          onClick={() => void overview.refetch()}
          className="mt-5 h-10 gap-2 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
        >
          <RefreshCw className="h-4 w-4" />
          Try again
        </Button>
      </div>
    );
  }

  const data: AccessOverview = overview.data;
  const stats = accessStats(data);
  const filtered = filterAccessOverview(data, search);
  const members = sortInvites(filtered.invites);
  const pending = filtered.requests.filter((entry) => entry.status === "pending");
  const dismissed = filtered.requests.filter((entry) => entry.status === "dismissed");
  const searching = search.trim().length > 0;

  const trimmed = email.trim().toLowerCase();
  const canInvite = EMAIL_PATTERN.test(trimmed) && !inviteMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={Users} label="Members" value={stats.members} />
        <StatTile icon={ShieldCheck} label="Admins" value={stats.admins} />
        <StatTile icon={Hourglass} label="Waiting" value={stats.waiting} accent={stats.waiting > 0} />
        <StatTile icon={AtSign} label="Auto-invited" value={stats.autoInvited} />
      </div>

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <form
          className="flex flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canInvite) {
              inviteMutation.mutate(trimmed);
            }
          }}
        >
          <Input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Invite by email…"
            type="email"
            className="h-10 rounded-full border-border/70 bg-card px-4"
          />
          <Button
            type="submit"
            disabled={!canInvite}
            className="h-10 shrink-0 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90"
          >
            {inviteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailPlus className="h-4 w-4" />}
            Invite
          </Button>
        </form>
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search people…"
            className="h-10 rounded-full border-border/70 bg-card pl-9 pr-4"
          />
        </div>
      </div>

      <section className="gera-card rounded-3xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold">
          Waiting for invite <span className="text-muted-foreground">· {pending.length}</span>
        </h2>
        {pending.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
            {searching ? "No waitlist matches for this search." : "No one is waiting right now."}
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {pending.map((entry) => (
              <WaitlistRow
                key={entry.email}
                entry={entry}
                onInvite={() => inviteMutation.mutate(entry.email)}
                onDismiss={() => dismissMutation.mutate(entry.email)}
                busy={inviteMutation.isPending || dismissMutation.isPending}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="gera-card rounded-3xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold">
          Members <span className="text-muted-foreground">· {members.length}</span>
        </h2>
        {members.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
            No member matches for this search.
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {members.map((entry) => (
              <MemberRow
                key={entry.email}
                entry={entry}
                isSelf={entry.email === selfEmail}
                onRole={(role) => roleMutation.mutate({ email: entry.email, role })}
                onRevoke={() => setRevokeTarget(entry.email)}
                busy={roleMutation.isPending}
              />
            ))}
          </ul>
        )}
      </section>

      {dismissed.length > 0 ? (
        <section className="gera-card rounded-3xl p-4 sm:p-5">
          <h2 className="text-sm font-semibold">
            Dismissed <span className="text-muted-foreground">· {dismissed.length}</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Kept for the record — inviting someone from here still works.
          </p>
          <ul className="mt-3 space-y-1.5">
            {dismissed.map((entry) => (
              <li
                key={entry.email}
                className="flex items-center gap-2 rounded-2xl border border-border/60 bg-background px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-muted-foreground">{entry.email}</p>
                  {entry.name || entry.note ? (
                    <p className="break-words text-xs text-muted-foreground/80">
                      {[entry.name, entry.note].filter(Boolean).join(" — ")}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => inviteMutation.mutate(entry.email)}
                  disabled={inviteMutation.isPending}
                  className="h-8 shrink-0 rounded-full border-border/70 px-3 text-xs"
                >
                  Invite
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <AlertDialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent className="rounded-3xl border-border/70">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revokeTarget}?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose access on their next request. You can always invite them back later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (revokeTarget) {
                  revokeMutation.mutate(revokeTarget);
                }
                setRevokeTarget(null);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="gera-card rounded-3xl p-4">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className={`mt-1.5 font-display text-3xl tabular-nums tracking-tight ${accent && value > 0 ? "text-ember" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function WaitlistRow({
  entry,
  onInvite,
  onDismiss,
  busy,
}: {
  entry: RequestEntry;
  onInvite: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const detail = [entry.name, entry.note].filter(Boolean).join(" — ");
  return (
    <li className="flex items-start gap-2 rounded-2xl border border-border/60 bg-background px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.email}</p>
        <p className="break-words text-xs text-muted-foreground">
          {detail || "No note"} <span className="text-muted-foreground/60">· {formatDate(entry.createdAt)}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="sm"
          onClick={onInvite}
          disabled={busy}
          className="h-8 rounded-full bg-ember px-3 text-xs text-ember-foreground hover:bg-ember/90"
        >
          Invite
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          title="Dismiss request"
          aria-label={`Dismiss ${entry.email}`}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

function MemberRow({
  entry,
  isSelf,
  onRole,
  onRevoke,
  busy,
}: {
  entry: InviteEntry;
  isSelf: boolean;
  onRole: (role: "admin" | "member") => void;
  onRevoke: () => void;
  busy: boolean;
}) {
  const isAdmin = entry.role === "admin";
  const isAuto = entry.invitedBy?.startsWith("domain:") ?? false;
  return (
    <li className="flex items-center gap-2 rounded-2xl border border-border/60 bg-background px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.email}</p>
        <p className="truncate text-xs text-muted-foreground">
          Invited {formatDate(entry.createdAt)} · {invitedByLabel(entry)}
        </p>
      </div>
      {isSelf ? (
        <Badge variant="secondary" className="shrink-0 rounded-full text-[10px]">
          You
        </Badge>
      ) : null}
      {isAdmin ? (
        <Badge variant="secondary" className="shrink-0 gap-1 rounded-full text-[10px]">
          <ShieldCheck className="h-3 w-3" />
          Admin
        </Badge>
      ) : null}
      {!isSelf ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Manage ${entry.email}`}
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 rounded-2xl border-border/70">
            {isAdmin ? (
              <DropdownMenuItem disabled={busy} onClick={() => onRole("member")} className="gap-2 rounded-xl">
                <ShieldOff className="h-4 w-4" />
                Make member
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={busy} onClick={() => onRole("admin")} className="gap-2 rounded-xl">
                <ShieldCheck className="h-4 w-4" />
                Make admin
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={isAdmin || isAuto}
              onClick={onRevoke}
              className="gap-2 rounded-xl text-destructive focus:text-destructive"
            >
              <UserRoundX className="h-4 w-4" />
              {isAuto ? "Auto-invited — can't revoke" : isAdmin ? "Demote before revoking" : "Revoke access"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}
