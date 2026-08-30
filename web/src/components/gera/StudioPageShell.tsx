import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, FolderKanban, NotebookPen, Plug, Settings2, ShieldCheck, Sparkles, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccessStatus } from "@/lib/access";
import { TID, studioPageTid, studioTabTid } from "@/lib/testids";
import { cn } from "@/lib/utils";

export type StudioPage =
  | "profiles"
  | "skills"
  | "projects"
  | "automations"
  | "hub"
  | "mcp"
  | "settings"
  | "admin";

const TABS: { id: StudioPage; label: string; icon: typeof Bot; path: string; adminOnly?: boolean }[] = [
  { id: "profiles", label: "Profiles", icon: Bot, path: "/profiles" },
  { id: "skills", label: "Skills", icon: Sparkles, path: "/skills" },
  { id: "projects", label: "Projects", icon: FolderKanban, path: "/projects" },
  { id: "automations", label: "Automations", icon: Zap, path: "/automations" },
  { id: "hub", label: "Hub", icon: NotebookPen, path: "/hub" },
  { id: "mcp", label: "MCP", icon: Plug, path: "/mcp" },
  { id: "settings", label: "Settings", icon: Settings2, path: "/settings" },
  { id: "admin", label: "Admin", icon: ShieldCheck, path: "/admin", adminOnly: true },
];

/**
 * Full-page shell for the workspace pages (Profiles, Automations, Hub, MCP,
 * Settings, Admin), Cursor-style: a sticky header with the way back to chat
 * plus segmented tabs to hop between pages, then a centered content column on
 * the app's warm atmosphere.
 */
export function StudioPageShell({
  active,
  children,
}: {
  active: StudioPage;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  // The admin tab is admin-only; the page itself gates deep links too.
  const statusQuery = useQuery({
    queryKey: ["access-status", user?.id ?? "anon"],
    queryFn: fetchAccessStatus,
    enabled: user !== null,
  });
  const isAdmin = statusQuery.data?.role === "admin";
  const tabs = TABS.filter((tab) => !tab.adminOnly || isAdmin || tab.id === active);

  return (
    <div className="gera-atmosphere flex min-h-dvh flex-col" data-testid={TID.studioShell}>
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Chat
          </button>
          <span className="h-4 w-px shrink-0 bg-border/80" aria-hidden />
          <div className="relative min-w-0">
            <nav
              aria-label="Workspace pages"
              className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-full border border-border/70 bg-foreground/[0.04] p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {tabs.map((tab) => (
                <PageTab
                  key={tab.id}
                  icon={tab.icon}
                  label={tab.label}
                  testId={studioTabTid(tab.id)}
                  active={active === tab.id}
                  onClick={() => navigate(tab.path)}
                />
              ))}
            </nav>
            {/* Mobile scroll hint: the strip overflows on narrow screens — the fade shows there's more to the right. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-px right-px w-7 rounded-r-full bg-gradient-to-l from-background to-transparent sm:hidden"
            />
          </div>
        </div>
      </header>
      <main data-testid={studioPageTid(active)} className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-8 sm:px-6 sm:pt-10">
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">{children}</div>
      </main>
    </div>
  );
}

function PageTab({
  icon: Icon,
  label,
  testId,
  active,
  onClick,
}: {
  icon: typeof Bot;
  label: string;
  testId: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors",
        active ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", active && "text-ember")} />
      {label}
    </button>
  );
}

/** Big editorial page heading with an optional right-aligned action. */
export function StudioPageHero({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="font-display text-4xl tracking-tight sm:text-5xl">{title}</h1>
        <p className="mt-2.5 max-w-xl text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Titled settings card for the editor forms. */
export function EditorSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="gera-card rounded-3xl p-4 sm:p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description ? (
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Floating sticky save bar pinned to the bottom of editor forms. */
export function EditorSaveBar({
  hint,
  saveLabel,
  disabled,
  onCancel,
  onSave,
}: {
  hint?: string;
  saveLabel: string;
  disabled?: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="sticky z-10 mt-6" style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}>
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur-xl sm:px-4">
        <p className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">{hint}</p>
        <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
          <Button size="sm" variant="ghost" className="h-9 rounded-full px-4" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-9 rounded-full bg-ember px-5 text-ember-foreground hover:bg-ember/90"
            onClick={onSave}
            disabled={disabled}
          >
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
