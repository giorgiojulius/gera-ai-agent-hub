import {
  AlertTriangle,
  Check,
  CloudCog,
  ExternalLink,
  FolderGit2,
  GitPullRequest,
  Github,
  Loader2,
  Play,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAgent } from "@/hooks/use-agent";
import { errorFromUnknown } from "@/lib/errors";
import { resolveGitHubAuth } from "@/lib/github-native";
import {
  RepoPreviewApiError,
  inspectRepoPreview,
  installRepoPreviewRunner,
  startRepoPreview,
  type RepoPreviewInput,
  type RepoPreviewInstallResult,
} from "@/lib/repo-preview";
import { TID } from "@/lib/testids";
import type { McpServerConfig, RepoPreviewInspection } from "@/lib/types";
import { cn } from "@/lib/utils";

type RepoLaunchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: string;
  conversationId: string;
  server: McpServerConfig;
};

const SETUP_TOOLS = ["create_branch", "put_file", "create_pull"] as const;

function frameworkLabel(value: RepoPreviewInspection["framework"]): string {
  const labels: Record<RepoPreviewInspection["framework"], string> = {
    vite: "Vite",
    next: "Next.js export",
    astro: "Astro",
    nuxt: "Nuxt static",
    sveltekit: "SvelteKit",
    remix: "Remix",
    "react-scripts": "Create React App",
    angular: "Angular",
    static: "Static HTML",
    unknown: "Custom web build",
  };
  return labels[value];
}

function statusTone(inspection: RepoPreviewInspection): string {
  if (!inspection.projectFound) return "border-amber-300/25 bg-amber-300/[0.08] text-amber-100";
  if (inspection.runner !== "ready") return "border-sky-300/25 bg-sky-300/[0.08] text-sky-100";
  return "border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-100";
}

export function RepoLaunchDialog({ open, onOpenChange, repository, conversationId, server }: RepoLaunchDialogProps) {
  const { recordRepoPreview } = useAgent();
  const navigate = useNavigate();
  const [rootDirectory, setRootDirectory] = useState<string>(".");
  const [outputDirectory, setOutputDirectory] = useState<string>("");
  const [ref, setRef] = useState<string>("");
  const [inspection, setInspection] = useState<RepoPreviewInspection | null>(null);
  const [setup, setSetup] = useState<RepoPreviewInstallResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [installing, setInstalling] = useState<boolean>(false);
  const [launching, setLaunching] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const canInstall = useMemo(
    () => SETUP_TOOLS.every((tool) => !(server.disabledTools ?? []).includes(tool)),
    [server.disabledTools],
  );

  const input = useCallback((): RepoPreviewInput => ({
    repository,
    ref: ref.trim() || undefined,
    rootDirectory: rootDirectory.trim() || ".",
    outputDirectory: outputDirectory.trim() || undefined,
  }), [outputDirectory, ref, repository, rootDirectory]);

  const inspect = useCallback(async (showSpinner = true): Promise<RepoPreviewInspection | null> => {
    if (!repository) return null;
    if (showSpinner) setLoading(true);
    setError("");
    try {
      const auth = await resolveGitHubAuth(server);
      const result = await inspectRepoPreview(input(), auth);
      setInspection(result);
      setRef((current) => current || result.ref);
      setSetup(null);
      return result;
    } catch (cause) {
      setInspection(null);
      setError(errorFromUnknown(cause));
      return null;
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [input, repository, server]);

  useEffect(() => {
    if (!open || !repository) return;
    let cancelled = false;
    setRootDirectory(".");
    setOutputDirectory("");
    setRef("");
    setSetup(null);
    setInspection(null);
    setError("");
    setLoading(true);
    void resolveGitHubAuth(server)
      .then((auth) => inspectRepoPreview({ repository, rootDirectory: "." }, auth))
      .then((result) => {
        if (cancelled) return;
        setInspection(result);
        setRef(result.ref);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorFromUnknown(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repository, server]);

  const install = async (): Promise<void> => {
    setInstalling(true);
    setError("");
    try {
      const auth = await resolveGitHubAuth(server);
      const result = await installRepoPreviewRunner(input(), auth);
      setSetup(result);
      setInspection(result.inspection);
      if (result.ready) {
        toast.success("Repository runner is ready");
      } else {
        toast.success("Setup PR created", { description: "Merge it once, then launch previews from any commit." });
      }
    } catch (cause) {
      setError(errorFromUnknown(cause));
    } finally {
      setInstalling(false);
    }
  };

  const launch = async (): Promise<void> => {
    setLaunching(true);
    setError("");
    try {
      const auth = await resolveGitHubAuth(server);
      const latest = await inspectRepoPreview(input(), auth);
      setInspection(latest);
      if (latest.runner !== "ready") {
        throw new RepoPreviewApiError("runner_setup_required", 428, latest);
      }
      if (!latest.projectFound) {
        throw new Error("No runnable package.json or index.html was found at this project root.");
      }
      const job = await startRepoPreview(input(), auth);
      recordRepoPreview(job, conversationId);
      toast.success("Repository launch started", {
        description: `${job.repository}@${job.commitSha.slice(0, 7)} · the preview keeps running if this tab closes.`,
      });
      onOpenChange(false);
    } catch (cause) {
      if (cause instanceof RepoPreviewApiError && cause.inspection) {
        setInspection(cause.inspection);
      }
      setError(errorFromUnknown(cause));
    } finally {
      setLaunching(false);
    }
  };

  const runnerNeedsSetup = inspection?.runner !== "ready";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID.repoLaunchDialog}
        className="max-h-[min(92svh,46rem)] overflow-y-auto border-[#2E4750] bg-[#101B20] p-0 text-white sm:max-w-xl"
      >
        <div className="overflow-hidden rounded-2xl">
          <div className="border-b border-white/[0.08] bg-[radial-gradient(circle_at_10%_0%,rgba(55,190,215,0.2),transparent_48%)] px-5 pb-4 pt-5">
            <DialogHeader className="pr-8 text-left">
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10">
                <CloudCog className="h-5 w-5 text-cyan-200" />
              </div>
              <DialogTitle className="text-xl text-white">Run this web repository</DialogTitle>
              <DialogDescription className="text-xs leading-relaxed text-white/45">
                Gera checks out one immutable commit, builds it on an isolated runner, and serves the static output from Rork edge storage for 24 hours.
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="space-y-4 px-5 py-4">
            <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 py-2.5">
              <Github className="h-4 w-4 shrink-0 text-white/55" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-white/85">{repository}</span>
              {inspection?.commitSha ? (
                <span className="rounded-md bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-white/40">
                  {inspection.commitSha.slice(0, 7)}
                </span>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Branch, tag or SHA</span>
                <Input
                  value={ref}
                  onChange={(event) => setRef(event.target.value)}
                  placeholder={inspection?.defaultBranch ?? "default branch"}
                  className="border-white/10 bg-black/20 text-white placeholder:text-white/25"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Project root</span>
                <Input
                  value={rootDirectory}
                  onChange={(event) => setRootDirectory(event.target.value)}
                  placeholder="."
                  className="border-white/10 bg-black/20 font-mono text-xs text-white placeholder:text-white/25"
                />
              </label>
            </div>

            <label className="block space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
                Output directory <span className="normal-case tracking-normal text-white/25">· optional</span>
              </span>
              <Input
                value={outputDirectory}
                onChange={(event) => setOutputDirectory(event.target.value)}
                placeholder="Auto-detect dist, build, out, .output/public…"
                className="border-white/10 bg-black/20 font-mono text-xs text-white placeholder:text-white/25"
              />
            </label>

            {inspection?.rootSuggestions && inspection.rootSuggestions.length > 1 ? (
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Detected app roots</p>
                <div className="flex flex-wrap gap-1.5">
                  {inspection.rootSuggestions.map((root) => (
                    <button
                      key={root}
                      type="button"
                      onClick={() => setRootDirectory(root)}
                      className={cn(
                        "rounded-lg border px-2 py-1 font-mono text-[10px] transition-colors",
                        root === rootDirectory
                          ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100"
                          : "border-white/10 bg-white/[0.03] text-white/45 hover:text-white/75",
                      )}
                    >
                      {root}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {loading ? (
              <div className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-3 text-xs text-white/45">
                <Loader2 className="h-4 w-4 animate-spin text-cyan-200" />
                Inspecting source, lockfile and runner…
              </div>
            ) : inspection ? (
              <div className={cn("rounded-xl border px-3 py-3", statusTone(inspection))}>
                <div className="flex items-start gap-2.5">
                  {inspection.projectFound && inspection.runner === "ready" ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">
                      {!inspection.projectFound
                        ? "No web entry found at this root"
                        : inspection.runner === "ready"
                          ? `${frameworkLabel(inspection.framework)} · ${inspection.packageManager}`
                          : inspection.runner === "missing"
                            ? "One-time runner setup required"
                            : "Runner update required"}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed opacity-65">
                      {!inspection.projectFound
                        ? "Pick a detected app root or enter the directory that contains package.json / index.html."
                        : inspection.runner === "ready"
                          ? `Ready to build ${inspection.ref} at ${inspection.rootDirectory}.`
                          : "Gera installs a small read-only workflow through a reviewable pull request. Merge it once; future launches do not modify code."}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {runnerNeedsSetup && inspection?.projectFound ? (
              <div className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-white/80">Safe setup, explicit review</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                      The PR grants only <code className="text-white/55">contents: read</code>. Builds receive no Gera/Rork keys or repository secrets; only a short-lived upload capability bound to this preview artifact.
                    </p>
                    {setup?.pullRequestUrl ? (
                      <a
                        href={setup.pullRequestUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold text-cyan-200 hover:text-cyan-100"
                      >
                        <GitPullRequest className="h-3.5 w-3.5" />
                        Review and merge setup PR
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : canInstall ? (
                      <Button
                        type="button"
                        size="sm"
                        data-testid={TID.repoLaunchInstall}
                        disabled={installing}
                        onClick={() => void install()}
                        className="mt-2 h-8 bg-cyan-200 text-[#08202A] hover:bg-cyan-100"
                      >
                        {installing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <GitPullRequest className="mr-1.5 h-3.5 w-3.5" />}
                        Create setup PR
                      </Button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => navigate(`/mcp?server=${encodeURIComponent(server.id)}`)}
                        className="mt-2 text-[11px] font-semibold text-cyan-200 hover:text-cyan-100"
                      >
                        Enable GitHub write tools to create the setup PR →
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="rounded-xl border border-rose-300/20 bg-rose-300/[0.07] px-3 py-2.5 text-[11px] leading-relaxed text-rose-100">
                {error}
              </div>
            ) : null}

            <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5 text-center">
              <div>
                <FolderGit2 className="mx-auto h-3.5 w-3.5 text-cyan-200/70" />
                <p className="mt-1 text-[9px] uppercase tracking-[0.1em] text-white/30">immutable source</p>
              </div>
              <div>
                <ShieldCheck className="mx-auto h-3.5 w-3.5 text-cyan-200/70" />
                <p className="mt-1 text-[9px] uppercase tracking-[0.1em] text-white/30">no secret injection</p>
              </div>
              <div>
                <CloudCog className="mx-auto h-3.5 w-3.5 text-cyan-200/70" />
                <p className="mt-1 text-[9px] uppercase tracking-[0.1em] text-white/30">24h Rork URL</p>
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-white/[0.08] bg-black/10 px-5 py-3.5 sm:items-center">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="text-white/50 hover:bg-white/[0.05] hover:text-white"
            >
              Cancel
            </Button>
            {!inspection || !inspection.projectFound || runnerNeedsSetup ? (
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={() => void inspect()}
                className="border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/[0.07] hover:text-white"
              >
                {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Check again
              </Button>
            ) : null}
            <Button
              type="button"
              data-testid={TID.repoLaunchStart}
              disabled={loading || launching || !inspection?.projectFound || runnerNeedsSetup}
              onClick={() => void launch()}
              className="bg-cyan-200 text-[#08202A] hover:bg-cyan-100"
            >
              {launching ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4 fill-current" />}
              Launch preview
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
