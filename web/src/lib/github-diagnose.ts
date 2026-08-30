import { githubOrgAccessUrl, type GitHubViewer } from "@/lib/github-device";

/**
 * Repo-access diagnostics — the "why can't Gera see my private repo" probe.
 *
 * Listing repositories and reading their contents are separate authorization
 * contours: a credential can list SOME repos while GitHub answers 404 for the
 * one the user cares about, because GitHub deliberately hides private repos
 * it refuses (404, never 403, to avoid confirming they exist). This module
 * probes both contours for one repository and maps the result matrix to a
 * plain-language verdict with the concrete fix.
 *
 * All probes run in the browser against api.github.com (CORS `*`), so the
 * credential never leaves the machine.
 */

const GITHUB_API = "https://api.github.com";

export type RepoTarget = { owner: string; repo: string };

/**
 * Accepts "owner/repo", "owner/repo.git", a github.com URL (https or ssh),
 * with any tail after the repo name. Anything else is null.
 */
export function parseRepoTarget(input: string): RepoTarget | null {
  const text = input.trim();
  if (!text) {
    return null;
  }
  const fromUrl = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i.exec(text);
  if (fromUrl) {
    return { owner: fromUrl[1], repo: fromUrl[2] };
  }
  const plain = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(text);
  if (plain) {
    return { owner: plain[1], repo: plain[2] };
  }
  return null;
}

/** Raw outcome of probing one repository with one credential. */
export type RepoProbe = {
  /** HTTP status of GET /repos/{owner}/{repo} — the metadata contour. */
  metadataStatus: number;
  /** HTTP status of the contents probe, or null when metadata already failed. */
  contentsStatus: number | null;
  /** Repo size in KB from metadata (0 usually means an empty repository). */
  size: number | null;
  /** X-GitHub-SSO header when GitHub sent one (SAML-protected orgs). */
  sso: string | null;
  /** GitHub's error body message, when present (rate limit / IP allow list). */
  message: string | null;
};

function gh(auth: string, path: string): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    headers: { Authorization: auth, Accept: "application/vnd.github+json" },
  });
}

/**
 * Probes the two access contours for one repository: metadata first, then —
 * only when metadata answers — the contents listing. Network errors throw;
 * HTTP refusals are data, not errors.
 */
export async function probeRepoAccess(auth: string, target: RepoTarget): Promise<RepoProbe> {
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  const meta = await gh(auth, `/repos/${owner}/${repo}`);
  let sso = meta.headers.get("x-github-sso");
  let size: number | null = null;
  let message: string | null = null;
  if (meta.ok) {
    const body = (await meta.json().catch(() => null)) as { size?: unknown } | null;
    size = typeof body?.size === "number" ? body.size : null;
  } else {
    const body = (await meta.json().catch(() => null)) as { message?: unknown } | null;
    message = typeof body?.message === "string" ? body.message : null;
  }
  let contentsStatus: number | null = null;
  if (meta.ok) {
    const contents = await gh(auth, `/repos/${owner}/${repo}/contents?per_page=1`);
    contentsStatus = contents.status;
    sso = sso ?? contents.headers.get("x-github-sso");
    const text = await contents.text().catch(() => "");
    if (!contents.ok && !message) {
      try {
        const body = JSON.parse(text) as { message?: unknown };
        message = typeof body.message === "string" ? body.message : null;
      } catch {
        // Non-JSON refusal — status still drives the verdict.
      }
    }
  }
  return { metadataStatus: meta.status, contentsStatus, size, sso, message };
}

/**
 * Organizations visible to this credential (an org missing here has not
 * approved the OAuth app). Null = could not list (e.g. fine-grained token
 * without org permissions) — "unknown", not "none".
 */
export async function fetchVisibleOrgLogins(auth: string): Promise<string[] | null> {
  try {
    const response = await gh(auth, "/user/orgs?per_page=100");
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Array<{ login?: unknown }>;
    if (!Array.isArray(body)) {
      return null;
    }
    return body
      .map((org) => (typeof org.login === "string" ? org.login : ""))
      .filter((login) => login.length > 0);
  } catch {
    return null;
  }
}

export type RepoAccessVerdict = {
  kind:
    | "ok"
    | "empty"
    | "contents"
    | "scope"
    | "own-missing"
    | "org-hidden"
    | "org-approval"
    | "sso"
    | "unauthorized"
    | "forbidden"
    | "unknown";
  title: string;
  detail: string;
  /** External page where the fix lives, when there is one. */
  action: { label: string; url: string } | null;
  /** Honest probe trace: who was checked and what GitHub answered. */
  checked: string;
};

/** Pulls the authorize URL out of an X-GitHub-SSO header ("required; url=…"). */
function ssoUrl(header: string): string | null {
  const match = /url=([^;,\s]+)/.exec(header);
  return match ? match[1] : null;
}

const ORG_ACCESS_FALLBACK = "https://github.com/settings/applications";
const FINE_GRAINED_TOKENS = "https://github.com/settings/tokens?type=beta";

/**
 * Maps one probe to a verdict. Pure — every branch is unit-tested against
 * the matrix from the access-contours research: SSO first, then the
 * metadata-200 family, then explicit refusals, then the 404 family where
 * GitHub hides what the credential cannot see.
 */
export function diagnoseRepoAccess(input: {
  viewer: GitHubViewer;
  orgs: string[] | null;
  target: RepoTarget;
  probe: RepoProbe;
}): RepoAccessVerdict {
  const { viewer, orgs, target, probe } = input;
  const full = `${target.owner}/${target.repo}`;
  const scopeNote =
    viewer.scopes !== null ? ` (scopes: ${viewer.scopes.length > 0 ? viewer.scopes.join(", ") : "none"})` : "";
  const checked = `Checked as @${viewer.login}${scopeNote} — repo HTTP ${probe.metadataStatus}${
    probe.contentsStatus !== null ? `, contents HTTP ${probe.contentsStatus}` : ""
  }.`;

  if (probe.sso) {
    const url = ssoUrl(probe.sso);
    return {
      kind: "sso",
      title: "SSO authorization required",
      detail: `GitHub answered with a SAML SSO challenge for ${target.owner}. The credential must be authorized for that organization: for sign-in tokens, sign in again and authorize the org on GitHub's page; for pasted tokens, use "Configure SSO" next to the token in GitHub settings.`,
      action: url ? { label: "Authorize on GitHub", url } : null,
      checked,
    };
  }

  if (probe.metadataStatus === 200) {
    if (probe.contentsStatus === 200) {
      return {
        kind: "ok",
        title: "Access looks good",
        detail: `This credential reads ${full}: repository metadata and file contents both answer. If a run still can't see it, the block is elsewhere — send the run's exact error.`,
        action: null,
        checked,
      };
    }
    if (probe.contentsStatus === 404 && probe.size === 0) {
      return {
        kind: "empty",
        title: "Repo reachable — but empty",
        detail: `Metadata answers and GitHub reports size 0 with no readable contents — an empty repository looks exactly like this. Access itself is fine.`,
        action: null,
        checked,
      };
    }
    if (probe.contentsStatus === 404) {
      return {
        kind: "contents",
        title: "Metadata only — contents hidden",
        detail: `The credential sees that ${full} exists, but file contents answer 404. That is the fine-grained-token gap: the token lacks "Contents: Read" or the repo is outside its repository selection. Fix the token on GitHub, or sign in with GitHub instead.`,
        action: { label: "Fine-grained tokens on GitHub", url: FINE_GRAINED_TOKENS },
        checked,
      };
    }
    return {
      kind: "unknown",
      title: "Inconclusive",
      detail: `Metadata answers but the contents probe returned HTTP ${probe.contentsStatus ?? "—"}. Try again; if it persists, check the token on GitHub.`,
      action: null,
      checked,
    };
  }

  if (probe.metadataStatus === 401) {
    return {
      kind: "unauthorized",
      title: "GitHub rejected the credential (401)",
      detail: "The token expired or was revoked. Sign in with GitHub again on the MCP page, or paste a fresh token.",
      action: null,
      checked,
    };
  }

  if (probe.metadataStatus === 403) {
    return {
      kind: "forbidden",
      title: "GitHub refused (403)",
      detail: `${probe.message ? `GitHub says: "${probe.message}". ` : ""}Typical causes: API rate limit, or an organization IP allow list that does not include this network.`,
      action: null,
      checked,
    };
  }

  if (probe.metadataStatus === 404) {
    if (viewer.scopes !== null && !viewer.scopes.includes("repo")) {
      return {
        kind: "scope",
        title: 'Token lacks the "repo" scope',
        detail: `Private repositories are invisible to this credential — GitHub answers 404 without confirming they exist. Sign in with GitHub again (the sign-in requests "repo"), or paste a token that carries it.`,
        action: null,
        checked,
      };
    }
    const ownerLc = target.owner.toLowerCase();
    if (ownerLc === viewer.login.toLowerCase()) {
      if (viewer.scopes === null) {
        return {
          kind: "own-missing",
          title: "Repo not in the token's selection",
          detail: `404 for a repository under your own account (@${viewer.login}). This looks like a fine-grained token whose Repository access does not include ${target.repo} — edit the token's selection on GitHub, or sign in with GitHub.`,
          action: { label: "Fine-grained tokens on GitHub", url: FINE_GRAINED_TOKENS },
          checked,
        };
      }
      return {
        kind: "own-missing",
        title: "404 under your own account",
        detail: `The credential carries "repo" and ${target.owner} is your account, yet GitHub says 404 — the name is probably off (renamed or moved repo), or it lives under a different account.`,
        action: null,
        checked,
      };
    }
    if (orgs !== null && orgs.some((org) => org.toLowerCase() === ownerLc)) {
      return {
        kind: "org-hidden",
        title: "Organization visible, repo hidden",
        detail: `The credential sees the ${target.owner} organization, but ${full} answers 404 — the name may be off, your GitHub account may lack access to this specific repository, or a fine-grained token excludes it.`,
        action: null,
        checked,
      };
    }
    const orgAccess = githubOrgAccessUrl() ?? ORG_ACCESS_FALLBACK;
    if (orgs !== null) {
      return {
        kind: "org-approval",
        title: `${target.owner} is not visible to this credential`,
        detail: `GitHub answers 404 and no organization named ${target.owner} is visible to this token. If it is an organization, it has not approved this workspace's GitHub app yet — open the approval page, find ${target.owner} and press Request/Grant (an org owner may need to confirm). If it is another user's private repo you collaborate on, double-check the exact name.`,
        action: { label: "Review org access", url: orgAccess },
        checked,
      };
    }
    return {
      kind: "unknown",
      title: "GitHub answers 404",
      detail: `The credential cannot see ${full} — GitHub hides private repos it refuses instead of admitting they exist. Typical causes: the owner organization has not approved this app, a fine-grained token excludes the repo, or the name is off.`,
      action: { label: "Review org access", url: orgAccess },
      checked,
    };
  }

  return {
    kind: "unknown",
    title: "Inconclusive",
    detail: `Unexpected answer — repo probe returned HTTP ${probe.metadataStatus}. Try again; if it persists, check the token on GitHub.`,
    action: null,
    checked,
  };
}
