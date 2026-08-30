import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchGitHubViewer } from "@/lib/github-device";
import {
  diagnoseRepoAccess,
  fetchVisibleOrgLogins,
  parseRepoTarget,
  probeRepoAccess,
  type RepoAccessVerdict,
} from "@/lib/github-diagnose";
import { resolveGitHubAuth } from "@/lib/github-native";
import { errorFromUnknown } from "@/lib/errors";
import { TID } from "@/lib/testids";
import type { McpServerConfig } from "@/lib/types";

/**
 * "Can't see a private repo?" — the in-picker access probe. Listing repos and
 * reading one are separate authorization contours, and GitHub answers 404 for
 * private repos it hides, so a missing repo looks like it does not exist.
 * This block probes both contours for a named repo with the SAME credential
 * the picker and runs use, and says exactly which contour fails and where the
 * fix lives. The credential never leaves the browser.
 */
export function RepoAccessCheck({ server, seed }: { server: McpServerConfig; seed: string }) {
  const navigate = useNavigate();
  const [formOpen, setFormOpen] = useState<boolean>(false);
  const [value, setValue] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [verdict, setVerdict] = useState<RepoAccessVerdict | null>(null);

  const toggle = () => {
    if (!formOpen && !value.trim() && parseRepoTarget(seed)) {
      setValue(seed.trim());
    }
    setFormOpen((prev) => !prev);
  };

  const check = async () => {
    const target = parseRepoTarget(value);
    if (!target) {
      setVerdict(null);
      setError("Enter owner/repo or a github.com URL.");
      return;
    }
    setBusy(true);
    setError("");
    setVerdict(null);
    try {
      const auth = await resolveGitHubAuth(server);
      const [viewer, orgs] = await Promise.all([fetchGitHubViewer(auth), fetchVisibleOrgLogins(auth)]);
      const probe = await probeRepoAccess(auth, target);
      setVerdict(diagnoseRepoAccess({ viewer, orgs, target, probe }));
    } catch (err) {
      setError(errorFromUnknown(err));
    } finally {
      setBusy(false);
    }
  };

  const good = verdict !== null && (verdict.kind === "ok" || verdict.kind === "empty");
  const needsSignIn = verdict !== null && (verdict.kind === "scope" || verdict.kind === "unauthorized");

  return (
    <div className="space-y-2">
      <button
        type="button"
        data-testid={TID.composerRepoDiagnose}
        onClick={toggle}
        className="text-[11px] font-medium text-ember transition-opacity hover:opacity-80"
      >
        {formOpen ? "Hide access check" : "Can't see a private repo?"}
      </button>
      {formOpen ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy) {
                  event.preventDefault();
                  void check();
                }
              }}
              placeholder="owner/repo or GitHub URL"
              aria-label="Repository to check access for"
              className="h-8 min-w-0 flex-1 rounded-lg border border-border/70 bg-card px-2.5 text-xs outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => void check()}
              disabled={busy}
              className="h-8 shrink-0 rounded-lg bg-ember px-2.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Checking…" : "Check"}
            </button>
          </div>
          {busy ? (
            <p className="animate-pulse px-0.5 text-[11px] text-muted-foreground">
              Probing GitHub with the same credential the picker uses…
            </p>
          ) : null}
          {error ? <p className="px-0.5 text-[11px] leading-snug text-amber-700">{error}</p> : null}
          {verdict ? (
            <div
              data-testid={TID.composerRepoVerdict}
              className={`space-y-1 rounded-xl border px-2.5 py-2 ${
                good ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10"
              }`}
            >
              <p className={`text-[11px] font-semibold ${good ? "text-emerald-700" : "text-amber-700"}`}>
                {verdict.title}
              </p>
              <p className="text-[11px] leading-snug text-foreground/80">{verdict.detail}</p>
              <p className="text-[10px] leading-snug text-muted-foreground">{verdict.checked}</p>
              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                {verdict.action ? (
                  <a
                    href={verdict.action.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-medium text-ember transition-opacity hover:opacity-80"
                  >
                    {verdict.action.label} ↗
                  </a>
                ) : null}
                {needsSignIn ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/mcp?server=${server.id}`)}
                    className="text-[11px] font-medium text-ember transition-opacity hover:opacity-80"
                  >
                    Sign in on the MCP page…
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
