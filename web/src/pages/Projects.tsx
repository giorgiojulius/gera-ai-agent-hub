// Projects — team spaces: admin-owned agent profiles for any job (repo guide,
// support desk, researcher, release engineer…) plus Slack-style channels with
// threads and unread badges. Members use the agents; owner/admins configure.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FolderKanban, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { StudioPageHero, StudioPageShell } from "@/components/gera/StudioPageShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { createProject, listProjects, type ProjectRole } from "@/lib/projects";
import { TID } from "@/lib/testids";

const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export default function ProjectsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>("");

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
  });

  const createMutation = useMutation({
    mutationFn: () => createProject(name.trim(), user?.name ?? ""),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setCreateOpen(false);
      setName("");
      navigate(`/projects/${created.id}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not create the project");
    },
  });

  const projects = projectsQuery.data ?? [];

  return (
    <StudioPageShell active="projects">
      <StudioPageHero
        title="Projects"
        subtitle="Team spaces with admin-run agents and channels. Admins publish agent profiles — instructions, model, exact tool access — for any job: code, support, research, writing. The team mentions them in threads; only admins can edit."
        action={
          <Button
            data-testid={TID.projectCreate}
            onClick={() => setCreateOpen(true)}
            className="h-10 gap-1.5 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
          >
            <Plus className="h-4 w-4" />
            New project
          </Button>
        }
      />

      <div className="mt-8">
        {projectsQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-3xl border border-border/70 bg-card p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading projects…
          </div>
        ) : projectsQuery.isError ? (
          <div className="rounded-3xl border border-border/70 bg-card p-6 text-sm text-muted-foreground">
            Could not load projects.{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => void projectsQuery.refetch()}
            >
              Retry
            </button>
          </div>
        ) : projects.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                data-testid={TID.projectCard}
                onClick={() => navigate(`/projects/${project.id}`)}
                className="gera-card group flex items-center gap-3.5 rounded-3xl p-4 text-left transition-transform hover:-translate-y-0.5 sm:p-5"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-ember/10">
                  <FolderKanban className="h-5 w-5 text-ember" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{project.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {ROLE_LABEL[project.role]}
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="rounded-3xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              You become the owner. Invite teammates by email, appoint admins, and publish agent
              profiles the team can use — but never edit.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim().length > 0 && !createMutation.isPending) {
                createMutation.mutate();
              }
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name — e.g. Acme HQ"
              maxLength={60}
              className="h-10 rounded-xl"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                className="h-9 rounded-full px-4"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={name.trim().length === 0 || createMutation.isPending}
                className="h-9 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
              >
                {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </StudioPageShell>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="gera-card rounded-3xl p-8 text-center sm:p-12">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ember/10">
        <FolderKanban className="h-6 w-6 text-ember" />
      </span>
      <h2 className="mt-4 font-display text-2xl tracking-tight">No projects yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        A project is a shared space for your team. Admins publish agents for any job — a repo
        guide that can never commit, a support desk on the Intercom inbox, a live-web researcher —
        and everyone puts them to work in channel threads, together.
      </p>
      <Button
        onClick={onCreate}
        className="mt-5 h-10 gap-1.5 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
      >
        <Plus className="h-4 w-4" />
        Create your first project
      </Button>
    </div>
  );
}
