// Project members: invite by email, roles (owner / admin / member), leave.
// Honest note: project membership does not grant Gera access — the email
// still needs an app invite (Admin → Invites) to sign in at all.
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, LogOut, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addProjectMember,
  removeProjectMember,
  setProjectMemberRole,
  type ProjectMember,
  type ProjectRole,
} from "@/lib/projects";

export function MembersPanel({
  projectId,
  members,
  meEmail,
  myRole,
}: {
  projectId: string;
  members: ProjectMember[];
  meEmail: string;
  myRole: ProjectRole;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canManage = myRole === "owner" || myRole === "admin";
  const [email, setEmail] = useState<string>("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState<boolean>(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["project", projectId] });

  const add = async () => {
    const target = email.trim().toLowerCase();
    if (!target || busy) {
      return;
    }
    setBusy(true);
    try {
      const added = await addProjectMember(projectId, target, role);
      await refresh();
      setEmail("");
      if (added.invited === false) {
        toast.warning(
          "Added to the project — but this email has no Gera invite yet, so they can't sign in until an admin grants one (Admin → Invites).",
          { duration: 8000 },
        );
      } else {
        toast.success("Member added");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add the member");
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (target: string, nextRole: "member" | "admin") => {
    try {
      await setProjectMemberRole(projectId, target, nextRole);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the role");
    }
  };

  const remove = async (target: string) => {
    const leaving = target === meEmail;
    const prompt = leaving
      ? "Leave this project?"
      : `Remove ${target} from the project?`;
    if (!window.confirm(prompt)) {
      return;
    }
    try {
      await removeProjectMember(projectId, target);
      if (leaving) {
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
        navigate("/projects");
        return;
      }
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the member");
    }
  };

  return (
    <div>
      <h2 className="font-display text-2xl tracking-tight">Members</h2>
      <p className="mt-1 max-w-lg text-sm leading-relaxed text-muted-foreground">
        Everyone here sees all channels and can talk to the agents. The owner and admins run the
        admin panel — agent profiles, channels and members; only the owner can delete the project.
      </p>

      {canManage ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
          className="mt-5 flex flex-wrap items-center gap-2"
        >
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="teammate@company.com"
            className="h-10 w-full rounded-xl sm:w-64"
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
            className="h-10 rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-foreground/25"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <Button
            type="submit"
            disabled={email.trim().length === 0 || busy}
            className="h-10 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Add
          </Button>
        </form>
      ) : null}

      <div className="gera-card mt-5 divide-y divide-border/60 rounded-3xl">
        {members.map((member) => {
          const isMe = member.email === meEmail;
          const isOwner = member.role === "owner";
          return (
            <div key={member.email} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-xs font-semibold text-muted-foreground">
                {(member.name || member.email).slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member.name || member.email.split("@")[0]}
                  {isMe ? <span className="ml-1.5 text-xs text-muted-foreground">(you)</span> : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">{member.email}</p>
              </div>
              {isOwner ? (
                <span className="shrink-0 rounded-full bg-foreground px-2.5 py-1 text-[11px] font-medium text-background">
                  Owner
                </span>
              ) : canManage ? (
                <select
                  value={member.role}
                  onChange={(event) =>
                    void changeRole(member.email, event.target.value === "admin" ? "admin" : "member")
                  }
                  className="h-8 shrink-0 rounded-lg border border-input bg-background px-2 text-xs outline-none"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              ) : (
                <span className="shrink-0 rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-medium capitalize text-muted-foreground">
                  {member.role}
                </span>
              )}
              {isMe && !isOwner ? (
                <button
                  type="button"
                  title="Leave project"
                  onClick={() => void remove(member.email)}
                  className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              ) : canManage && !isOwner && !isMe ? (
                <button
                  type="button"
                  title="Remove from project"
                  onClick={() => void remove(member.email)}
                  className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Heads up: project membership doesn't grant access to Gera itself — a teammate also needs an
        app invite (Admin → Invites) to sign in.
      </p>
    </div>
  );
}
