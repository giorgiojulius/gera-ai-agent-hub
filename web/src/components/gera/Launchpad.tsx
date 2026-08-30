import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FolderKanban, Ghost, LayoutDashboard } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Composer } from "@/components/gera/Composer";
import { useAgent } from "@/hooks/use-agent";
import { fetchProjectOverview, listProjects, type ProjectListEntry, type ProjectScreen } from "@/lib/projects";
import { TID } from "@/lib/testids";
import type { CreateMode } from "@/lib/types";

const STARTERS: { label: string; prompt: string; mode: CreateMode }[] = [
  {
    label: "Search this week's AI news",
    prompt: "Search the latest AI model releases this week and summarize the three most important ones with sources.",
    mode: "chat",
  },
  {
    label: "Cinematic desert image",
    prompt: "A desert observatory at dusk, copper light on sandstone, 35mm film grain.",
    mode: "image",
  },
  {
    label: "Animate a neon jellyfish",
    prompt: "A bioluminescent jellyfish drifting through a dark ocean, neon cyan glow, slow camera push-in.",
    mode: "video",
  },
  {
    label: "Narrate a trailer line",
    prompt: "In a world where every idea ships overnight, one voice tells the story. This fall — nothing stays impossible.",
    mode: "audio",
  },
  {
    label: "Chart the EV market",
    prompt: "Search current global EV sales market share by automaker and draw a bar chart of the top six, with sources.",
    mode: "chat",
  },
  {
    label: "Landing page artifact",
    prompt:
      "Design a small landing page for a specialty coffee subscription as a live HTML artifact — warm palette, hero, three feature cards, pricing.",
    mode: "chat",
  },
];

/** Up to this many projects the strip flattens into project+screen clusters. */
const DIRECT_PROJECT_LIMIT = 2;
/** Screen segments shown per cluster — the project chip covers the rest. */
const SCREENS_PER_PROJECT = 3;
/** Plain project chips shown before the "All projects" tail takes over. */
const PROJECT_CHIP_LIMIT = 4;

export function Launchpad() {
  const { state, active, setMode, setInput } = useAgent();
  const incognito = active?.incognito === true;
  // Incognito is "off the record" — no workspace trails above the greeting.
  const showShortcuts = !incognito && state.settings.homeShortcuts;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-24 pt-10 sm:px-6 sm:pt-14" data-testid={TID.launchpad}>
      {showShortcuts ? <HomeShortcuts /> : null}
      <div className="mx-auto max-w-3xl text-center">
        {incognito ? (
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.3em] text-background">
            <Ghost className="h-3.5 w-3.5" />
            Incognito
          </p>
        ) : null}
        <h1 className="font-display text-[40px] leading-[1.04] tracking-tight sm:text-6xl">
          {incognito ? (
            "Off the record."
          ) : (
            <>
              <span className="font-brand font-semibold">Gera</span> is your best workspace.
            </>
          )}
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground sm:text-[15px]">
          {incognito
            ? "This thread lives only in this tab: no history, no account sync, no memories saved. Reload and it's gone."
            : "Every frontier model in one place — run deep research with cited reports, let the Julius council judge answers, and put your profiles and automations to work."}
        </p>
      </div>

      <div className="mx-auto mt-8 max-w-3xl">
        <Composer variant="hero" />
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {STARTERS.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setMode(item.mode);
                setInput(item.prompt);
              }}
              className="rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:border-ember/50 hover:text-ember"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Direct-navigation strip above the greeting. With one or two projects each
 * flattens into a segmented pill carrying its screen desks — one tap lands on
 * a desk. More projects collapse to plain chips plus "All projects". Hidden
 * while loading, failed, or empty, so the hero stays clean — no skeletons.
 */
function HomeShortcuts() {
  const navigate = useNavigate();
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
    staleTime: 120_000,
    retry: 1,
  });
  const projects = projectsQuery.data ?? [];
  const direct = projects.length > 0 && projects.length <= DIRECT_PROJECT_LIMIT;
  // Screens ride the project overview; fetched only for the flat 1-2 project
  // case. A failed overview quietly drops to a plain project chip.
  const screensQuery = useQuery({
    queryKey: ["home-shortcut-screens", projects.map((item) => item.id).join("|")],
    enabled: direct,
    staleTime: 120_000,
    retry: 1,
    queryFn: async (): Promise<ProjectScreen[][]> =>
      Promise.all(
        projects.map((item) =>
          fetchProjectOverview(item.id)
            .then((overview) => overview.screens)
            .catch(() => [] as ProjectScreen[]),
        ),
      ),
  });

  if (projects.length === 0) {
    return null;
  }

  return (
    <div
      data-testid={TID.homeShortcuts}
      className="mx-auto mb-8 max-w-3xl animate-in fade-in slide-in-from-top-1 duration-300"
    >
      <p className="text-center text-[10px] font-semibold uppercase tracking-[0.3em] text-muted-foreground/70">
        Shortcuts
      </p>
      <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
        {direct ? (
          projects.map((project, index) => (
            <ProjectShortcut
              key={project.id}
              project={project}
              screens={(screensQuery.data?.[index] ?? []).slice(0, SCREENS_PER_PROJECT)}
            />
          ))
        ) : (
          <>
            {projects.slice(0, PROJECT_CHIP_LIMIT).map((project) => (
              <ProjectShortcut key={project.id} project={project} screens={[]} />
            ))}
            <button
              type="button"
              onClick={() => navigate("/projects")}
              className="flex items-center gap-1 rounded-full border border-dashed border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-ember/50 hover:text-ember"
            >
              All projects
              <ArrowRight className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Segmented shortcut pill: the project chip plus one segment per screen desk. */
function ProjectShortcut({ project, screens }: { project: ProjectListEntry; screens: ProjectScreen[] }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-stretch overflow-hidden rounded-full border border-border/70 bg-card shadow-sm">
      <button
        type="button"
        onClick={() => navigate(`/projects/${project.id}`)}
        title={`Open ${project.name}`}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-ember/10 hover:text-ember"
      >
        <FolderKanban className="h-3.5 w-3.5 text-ember" aria-hidden />
        <span className="max-w-[9rem] truncate">{project.name}</span>
      </button>
      {screens.map((screen) => (
        <button
          key={screen.id}
          type="button"
          onClick={() => navigate(`/projects/${project.id}/screens/${screen.id}`)}
          title={`${project.name} · ${screen.name}`}
          className="flex items-center gap-1.5 border-l border-border/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-ember/10 hover:text-ember"
        >
          {screen.emoji ? (
            <span className="text-[13px] leading-none" aria-hidden>
              {screen.emoji}
            </span>
          ) : (
            <LayoutDashboard className="h-3.5 w-3.5" aria-hidden />
          )}
          <span className="max-w-[8rem] truncate">{screen.name}</span>
        </button>
      ))}
    </div>
  );
}
