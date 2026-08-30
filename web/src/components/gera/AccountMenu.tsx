import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronsUpDown, LogOut, Settings2, ShieldCheck } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";

import { DiagnosticsDialog } from "@/components/gera/DiagnosticsDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccessStatus } from "@/lib/access";
import { subscribeDiagnostics, syncDiagnostics, unseenDiagnosticsCount } from "@/lib/diagnostics";

/**
 * Account dropdown: identity, studio settings, the admin panel link, sign out.
 * `icon` renders the avatar button (header); `row` the full-width footer row
 * docked at the bottom of the sidebar, opening upward.
 */
export function AccountMenu({ variant = "icon" }: { variant?: "icon" | "row" }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState<boolean>(false);
  const unseen = useSyncExternalStore(subscribeDiagnostics, unseenDiagnosticsCount);

  useEffect(() => {
    // Pull the cloud journal once so the badge also covers other devices.
    void syncDiagnostics();
  }, []);

  const statusQuery = useQuery({
    queryKey: ["access-status", user?.id ?? "anon"],
    queryFn: fetchAccessStatus,
    enabled: user !== null,
  });

  if (!user) {
    return null;
  }

  const isAdmin = statusQuery.data?.role === "admin";
  const initial = (user.name?.trim().charAt(0) ?? user.email.charAt(0) ?? "?").toUpperCase();
  const displayName = user.name?.trim() || user.email.split("@")[0];
  const isRow = variant === "row";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {isRow ? (
            <button
              type="button"
              aria-label="Account"
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-foreground/5 data-[state=open]:bg-foreground/5"
            >
              <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ember/15 text-xs font-semibold text-ember">
                {user.picture ? (
                  <img src={user.picture} alt="" className="h-full w-full rounded-full object-cover" />
                ) : (
                  initial
                )}
                {unseen > 0 ? (
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-destructive ring-2 ring-[#F5EFF3]" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{displayName}</span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Account"
              className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-ember/15 text-sm font-semibold text-ember shadow-sm transition-colors hover:bg-ember/25"
            >
              {user.picture ? (
                <img src={user.picture} alt="" className="h-full w-full rounded-full object-cover" />
              ) : (
                initial
              )}
              {unseen > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-background" />
              ) : null}
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={isRow ? "top" : "bottom"}
          align={isRow ? "start" : "end"}
          sideOffset={8}
          className="w-60 rounded-2xl border-border/70"
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium">{user.name ?? "Signed in"}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate("/settings")} className="gap-2 rounded-xl">
            <Settings2 className="h-4 w-4" />
            Settings
          </DropdownMenuItem>
          {isAdmin ? (
            <DropdownMenuItem onClick={() => navigate("/admin")} className="gap-2 rounded-xl">
              <ShieldCheck className="h-4 w-4" />
              Admin panel
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => setDiagnosticsOpen(true)} className="gap-2 rounded-xl">
            <Activity className="h-4 w-4" />
            Diagnostics
            {unseen > 0 ? (
              <span className="ml-auto rounded-full bg-destructive/15 px-1.5 text-[10px] font-semibold leading-4 text-destructive">
                {unseen}
              </span>
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={signOut} className="gap-2 rounded-xl">
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DiagnosticsDialog open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} />
    </>
  );
}
