// Platform-neutral contract for launching GitHub web repositories through
// Gera's Rork backend. The Worker owns auth, lifecycle and R2 delivery; a tiny
// repository workflow supplies isolated build compute without receiving any
// Gera/Rork credential.

export const REPO_PREVIEW_RUNNER_VERSION = 1;
export const REPO_PREVIEW_WORKFLOW_PATH = ".github/workflows/gera-web-preview.yml";
export const REPO_PREVIEW_TTL_MS = 24 * 60 * 60_000;
export const REPO_PREVIEW_TOKEN_TTL_MS = 45 * 60_000;
export const REPO_PREVIEW_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const REPO_PREVIEW_MAX_FILES = 1_000;
export const REPO_PREVIEW_MAX_LOG_CHARS = 120_000;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_REF_PATTERN = /^[A-Za-z0-9._/-]{1,180}$/;
const PREVIEW_ID_PATTERN = /^[a-f0-9]{24}\.[A-Za-z0-9_-]{32,64}\.[a-f0-9]{24}$/;

export type RepoPreviewPhase =
  | "queued"
  | "installing"
  | "building"
  | "packaging"
  | "uploading"
  | "ready"
  | "failed"
  | "cancelled"
  | "expired";

export type RepoPreviewFramework =
  | "vite"
  | "next"
  | "astro"
  | "nuxt"
  | "sveltekit"
  | "remix"
  | "react-scripts"
  | "angular"
  | "static"
  | "unknown";

export type RepoPreviewPackageManager = "bun" | "pnpm" | "yarn" | "npm" | "none";

export type RepoPreviewManifestFile = {
  path: string;
  offset: number;
  size: number;
};

export type RepoPreviewManifest = {
  version: 1;
  entry: string;
  files: RepoPreviewManifestFile[];
};

export type RepoPreviewDetection = {
  framework: RepoPreviewFramework;
  packageManager: RepoPreviewPackageManager;
  projectFound: boolean;
};

export type RepoPreviewInspection = RepoPreviewDetection & {
  repository: string;
  defaultBranch: string;
  ref: string;
  commitSha: string;
  rootDirectory: string;
  outputDirectory?: string;
  rootSuggestions: string[];
  runner: "ready" | "missing" | "outdated";
  runnerVersion?: number;
};

export type RepoPreviewJob = {
  id: string;
  repository: string;
  ref: string;
  commitSha: string;
  rootDirectory: string;
  outputDirectory?: string;
  framework: RepoPreviewFramework;
  packageManager: RepoPreviewPackageManager;
  phase: RepoPreviewPhase;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  previewUrl?: string;
  actionsUrl?: string;
  setupPullRequestUrl?: string;
  logs?: string;
  error?: string;
};

/** Strict owner/repo parsing used before any GitHub request. */
export function parseRepoPreviewRepository(value: unknown): { owner: string; repo: string; fullName: string } | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^([^/]+)\/([^/]+)$/.exec(value.trim());
  if (!match || !OWNER_PATTERN.test(match[1]) || !REPO_PATTERN.test(match[2]) || match[2] === "." || match[2] === "..") {
    return null;
  }
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

/** A ref is data for GitHub's API, never a shell fragment. */
export function normalizeRepoPreviewRef(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const ref = value.trim();
  return SAFE_REF_PATTERN.test(ref) && !ref.includes("..") && !ref.startsWith("/") && !ref.endsWith("/")
    ? ref
    : undefined;
}

/** Keeps monorepo/output paths relative and unable to leave the checkout. */
export function normalizeRepoPreviewDirectory(value: unknown, fallback = "."): string | null {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!raw || raw === ".") {
    return ".";
  }
  const parts = raw.split("/");
  if (
    raw.length > 220 ||
    raw.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))
  ) {
    return null;
  }
  return parts.join("/");
}

export function isRepoPreviewId(value: string): boolean {
  return PREVIEW_ID_PATTERN.test(value);
}

async function previewIdentityHmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Signs the public id before it is allowed to address a Durable Object. */
export async function signRepoPreviewId(ownerKey: string, nonce: string, secret: string): Promise<string> {
  if (!/^[a-f0-9]{24}$/.test(ownerKey) || !/^[A-Za-z0-9_-]{32,64}$/.test(nonce) || !secret) {
    throw new Error("invalid_preview_identity");
  }
  const unsigned = `${ownerKey}.${nonce}`;
  return `${unsigned}.${(await previewIdentityHmac(secret, unsigned)).slice(0, 24)}`;
}

/** Rejects fabricated ids before they can allocate persistent DO storage. */
export async function verifyRepoPreviewId(id: string, secret: string): Promise<boolean> {
  if (!isRepoPreviewId(id) || !secret) return false;
  const lastDot = id.lastIndexOf(".");
  const unsigned = id.slice(0, lastDot);
  const provided = id.slice(lastDot + 1);
  const expected = (await previewIdentityHmac(secret, unsigned)).slice(0, 24);
  let difference = provided.length ^ expected.length;
  for (let index = 0; index < Math.min(provided.length, expected.length); index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Framework/package-manager inference from immutable repository metadata. */
export function detectRepoPreviewProject(
  packageJsonText: string | null,
  repositoryPaths: string[],
): RepoPreviewDetection {
  const paths = new Set(repositoryPaths.map((path) => path.replace(/^\.\//, "")));
  const packageManager: RepoPreviewPackageManager = paths.has("bun.lock") || paths.has("bun.lockb")
    ? "bun"
    : paths.has("pnpm-lock.yaml")
      ? "pnpm"
      : paths.has("yarn.lock")
        ? "yarn"
        : packageJsonText
          ? "npm"
          : "none";
  if (!packageJsonText) {
    return {
      framework: paths.has("index.html") ? "static" : "unknown",
      packageManager,
      projectFound: paths.has("index.html"),
    };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(JSON.parse(packageJsonText) as unknown);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return { framework: "unknown", packageManager, projectFound: false };
  }
  const dependencies = {
    ...(record(parsed.dependencies) ?? {}),
    ...(record(parsed.devDependencies) ?? {}),
  };
  const has = (name: string): boolean => typeof dependencies[name] === "string";
  const framework: RepoPreviewFramework = has("vite")
    ? "vite"
    : has("next")
      ? "next"
      : has("astro")
        ? "astro"
        : has("nuxt")
          ? "nuxt"
          : has("@sveltejs/kit")
            ? "sveltekit"
            : has("@remix-run/react")
              ? "remix"
              : has("react-scripts")
                ? "react-scripts"
                : has("@angular/core")
                  ? "angular"
                  : paths.has("index.html")
                    ? "static"
                    : "unknown";
  return { framework, packageManager, projectFound: true };
}

/** Extracts the installed runner marker without trusting the workflow body. */
export function repoPreviewRunnerVersion(source: string | null): number | undefined {
  const match = source?.match(/^# gera-web-preview-runner: (\d+)$/m);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A marker is informational; dispatch requires byte-equivalent canonical workflow code. */
export function repoPreviewWorkflowMatches(source: string | null): boolean {
  if (!source) return false;
  const normalized = (value: string): string => value.replace(/\r\n/g, "\n").trimEnd();
  return normalized(source) === normalized(repoPreviewWorkflowSource());
}

const PREVIEW_ARTIFACT_EXTENSIONS = new Set([
  "html", "htm", "css", "js", "mjs", "cjs", "json", "webmanifest", "xml", "txt", "csv",
  "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico",
  "woff", "woff2", "ttf", "otf", "wasm",
  "mp3", "wav", "ogg", "m4a", "mp4", "webm", "mov",
  "pdf", "glb", "gltf", "usdz", "bin",
]);
const PREVIEW_ARTIFACT_BLOCKED_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "tsconfig.json", "jsconfig.json", "config.json", "secrets.json", "credentials.json", "service-account.json",
  "wrangler.json", "wrangler.jsonc", "wrangler.toml",
]);

function isSensitiveArtifactName(name: string): boolean {
  const lower = name.toLowerCase();
  return PREVIEW_ARTIFACT_BLOCKED_NAMES.has(lower) ||
    /(?:^|\.)config\.(?:js|mjs|cjs|ts|json|jsonc|toml|yaml|yml)$/.test(lower) ||
    /^(?:ts|js)config(?:\.[a-z0-9_-]+)?\.json$/.test(lower) ||
    /(?:^|[-_.])(?:secret|secrets|credential|credentials|service-account)(?:[-_.]|$)/.test(lower);
}

/** Only browser-deliverable artifact paths can enter the public capability. */
export function isRepoPreviewArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 500 || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  const parts = value.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || part.includes("\0")) ||
    isSensitiveArtifactName(parts[parts.length - 1])
  ) {
    return false;
  }
  const extension = parts[parts.length - 1].toLowerCase().split(".").pop() ?? "";
  return PREVIEW_ARTIFACT_EXTENSIONS.has(extension);
}

function safeManifestPath(value: unknown): string | null {
  return isRepoPreviewArtifactPath(value) ? value.split("/").join("/") : null;
}

/** Validates the tar index before any offset can become an R2 Range request. */
export function normalizeRepoPreviewManifest(value: unknown, archiveBytes: number): RepoPreviewManifest | null {
  const raw = record(value);
  if (
    !raw ||
    raw.version !== 1 ||
    !Number.isInteger(archiveBytes) ||
    archiveBytes <= 0 ||
    archiveBytes > REPO_PREVIEW_MAX_ARCHIVE_BYTES ||
    !Array.isArray(raw.files) ||
    raw.files.length === 0 ||
    raw.files.length > REPO_PREVIEW_MAX_FILES
  ) {
    return null;
  }
  const files: RepoPreviewManifestFile[] = [];
  const seen = new Set<string>();
  for (const item of raw.files) {
    const file = record(item);
    const path = safeManifestPath(file?.path);
    const offset = file?.offset;
    const size = file?.size;
    if (
      !file ||
      !path ||
      seen.has(path) ||
      typeof offset !== "number" ||
      typeof size !== "number" ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > archiveBytes
    ) {
      return null;
    }
    seen.add(path);
    files.push({ path, offset, size });
  }
  const entry = safeManifestPath(raw.entry) ?? "index.html";
  if (!seen.has(entry)) {
    return null;
  }
  return { version: 1, entry, files };
}

/** MIME is derived from the validated path, never accepted from the workflow. */
export function repoPreviewContentType(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const values: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    cjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    webmanifest: "application/manifest+json",
    txt: "text/plain; charset=utf-8",
    wasm: "application/wasm",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
  };
  return values[extension] ?? "application/octet-stream";
}

/** Makes root-relative build assets resolve inside one preview's path namespace. */
export function rewriteRepoPreviewHtml(html: string, previewPrefix: string): string {
  const prefix = previewPrefix.endsWith("/") ? previewPrefix : `${previewPrefix}/`;
  const rewritten = html.replace(
    /\b(src|href|poster|action)=(['"])\/(?!\/)([^'"]*)\2/gi,
    (_full, attribute: string, quote: string, path: string) => `${attribute}=${quote}${prefix}${path}${quote}`,
  );
  const base = `<base href="${prefix}">`;
  if (/<head(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${base}`);
  }
  return `${base}${rewritten}`;
}

/** Build logs are useful evidence, but credential-shaped output is never persisted. */
export function redactRepoPreviewLog(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})\b/g, "[redacted-token]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|signature|auth)=)[^&\s]+/gi, "$1[redacted]")
    .slice(-REPO_PREVIEW_MAX_LOG_CHARS);
}

/** Auditable bounded workflow installed through a PR in the selected repo. */
export function repoPreviewWorkflowSource(): string {
  return `# gera-web-preview-runner: ${REPO_PREVIEW_RUNNER_VERSION}
name: Gera web preview
run-name: Gera web preview

on:
  workflow_dispatch:
    inputs:
      preview_id:
        description: Gera preview id
        required: true
        type: string
      commit_sha:
        description: Immutable source commit
        required: true
        type: string
      root_directory:
        description: Web project root
        required: true
        default: .
        type: string
      output_directory:
        description: Optional build output directory
        required: false
        default: ""
        type: string
      callback_url:
        description: Gera backend callback origin
        required: true
        type: string

permissions:
  contents: read
  id-token: write

jobs:
  preview:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Mark runner started
        continue-on-error: true
        shell: bash
        env:
          CALLBACK_URL: \${{ inputs.callback_url }}
          PREVIEW_ID: \${{ inputs.preview_id }}
        run: |
          OIDC_TOKEN="$(curl --fail --silent --show-error \
            -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=gera-repo-preview" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"
          printf '{}' | curl --fail --silent --show-error \
            -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/json" --data-binary @- \
            "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/started"

      - name: Check out immutable source
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: \${{ inputs.commit_sha }}
          persist-credentials: false
          fetch-depth: 1

      - name: Set up Node
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: "22"

      - name: Set up Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: "1.3.9"

      - name: Install, build and package
        id: build
        shell: bash
        env:
          CALLBACK_URL: \${{ inputs.callback_url }}
          PREVIEW_ID: \${{ inputs.preview_id }}
          ROOT_DIRECTORY: \${{ inputs.root_directory }}
          REQUESTED_OUTPUT: \${{ inputs.output_directory }}
        run: |
          set +e
          LOG_FILE="$RUNNER_TEMP/gera-preview.log"
          gera_oidc() {
            curl --fail --silent --show-error \
              -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
              "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=gera-repo-preview" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])'
          }
          notify_phase() {
            OIDC_TOKEN="$(gera_oidc)" || return 0
            printf '{"phase":"%s"}' "$1" | curl --silent --show-error \
              -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/json" --data-binary @- \
              "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/phase" >/dev/null || true
          }
          {
            set -euo pipefail
            case "$ROOT_DIRECTORY" in
              /*|*".."*) echo "Unsafe root directory."; exit 2 ;;
            esac
            PROJECT_DIR="$GITHUB_WORKSPACE"
            if [ "$ROOT_DIRECTORY" != "." ]; then PROJECT_DIR="$GITHUB_WORKSPACE/$ROOT_DIRECTORY"; fi
            if [ ! -d "$PROJECT_DIR" ]; then echo "Project root not found: $ROOT_DIRECTORY"; exit 2; fi
            cd "$PROJECT_DIR"
            PREVIEW_BASE="/repo-preview/$PREVIEW_ID/"

            if [ -f package.json ]; then
              notify_phase installing
              corepack enable || true
              if [ -f bun.lock ] || [ -f bun.lockb ]; then
                PACKAGE_MANAGER=bun
                bun install --frozen-lockfile
              elif [ -f pnpm-lock.yaml ]; then
                PACKAGE_MANAGER=pnpm
                PACKAGE_MANAGER_SPEC="$(node -p 'require("./package.json").packageManager || ""')"
                if [[ "$PACKAGE_MANAGER_SPEC" == pnpm@* ]]; then corepack prepare "$PACKAGE_MANAGER_SPEC" --activate; else corepack prepare pnpm@9.15.9 --activate; fi
                pnpm install --frozen-lockfile
              elif [ -f yarn.lock ]; then
                PACKAGE_MANAGER=yarn
                PACKAGE_MANAGER_SPEC="$(node -p 'require("./package.json").packageManager || ""')"
                if [[ "$PACKAGE_MANAGER_SPEC" == yarn@* ]]; then corepack prepare "$PACKAGE_MANAGER_SPEC" --activate; else corepack prepare yarn@1.22.22 --activate; fi
                yarn install --immutable || yarn install --frozen-lockfile
              elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
                PACKAGE_MANAGER=npm
                npm ci
              else
                PACKAGE_MANAGER=npm
                npm install
              fi

              if node -e 'const p=require("./package.json"); process.exit(p.scripts && p.scripts.build ? 0 : 1)'; then
                notify_phase building
                if node -e 'const p=require("./package.json"); const d={...(p.dependencies||{}),...(p.devDependencies||{})}; process.exit(d.vite ? 0 : 1)'; then
                  case "$PACKAGE_MANAGER" in
                    bun) bun run build -- --base="$PREVIEW_BASE" ;;
                    pnpm) pnpm run build -- --base="$PREVIEW_BASE" ;;
                    yarn) yarn build --base="$PREVIEW_BASE" ;;
                    *) npm run build -- --base="$PREVIEW_BASE" ;;
                  esac
                else
                  export PUBLIC_URL="$PREVIEW_BASE"
                  export BASE_URL="$PREVIEW_BASE"
                  case "$PACKAGE_MANAGER" in
                    bun) bun run build ;;
                    pnpm) pnpm run build ;;
                    yarn) yarn build ;;
                    *) npm run build ;;
                  esac
                fi
              elif [ ! -f index.html ]; then
                echo "package.json has no build script and the project root has no index.html."
                exit 3
              fi
            elif [ ! -f index.html ]; then
              echo "No package.json or index.html found in $ROOT_DIRECTORY."
              exit 3
            fi

            notify_phase packaging
            export REQUESTED_OUTPUT
            OUTPUT_DIR="$(python3 - <<'PY'
          import os
          from pathlib import Path
          root = Path.cwd()
          requested = os.environ.get("REQUESTED_OUTPUT", "").strip().strip("/")
          candidates = [requested] if requested else ["dist", "build", "out", ".output/public", "public", "."]
          for candidate in candidates:
              if not candidate:
                  continue
              path = (root / candidate).resolve()
              try:
                  path.relative_to(root.resolve())
              except ValueError:
                  continue
              if path.is_dir() and (path / "index.html").is_file():
                  print(path)
                  raise SystemExit(0)
          for parent in (root / "dist", root / "build", root / "out"):
              if parent.is_dir():
                  for index in sorted(parent.glob("**/index.html")):
                      if len(index.relative_to(parent).parts) <= 4:
                          print(index.parent.resolve())
                          raise SystemExit(0)
          raise SystemExit("Build completed, but no static index.html output was found. Set the output directory explicitly.")
          PY
            )"
            export OUTPUT_DIR
            python3 - <<'PY'
          import json
          import os
          import tarfile
          from pathlib import Path
          root = Path(os.environ["OUTPUT_DIR"]).resolve()
          tar_path = Path(os.environ["RUNNER_TEMP"]) / "gera-preview.tar"
          manifest_path = Path(os.environ["RUNNER_TEMP"]) / "gera-preview-manifest.json"
          files = []
          allowed_extensions = {
              ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".webmanifest", ".xml", ".txt", ".csv",
              ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
              ".woff", ".woff2", ".ttf", ".otf", ".wasm",
              ".mp3", ".wav", ".ogg", ".m4a", ".mp4", ".webm", ".mov",
              ".pdf", ".glb", ".gltf", ".usdz", ".bin",
          }
          blocked_names = {
              "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
              "tsconfig.json", "jsconfig.json", "config.json", "secrets.json", "credentials.json", "service-account.json",
              "wrangler.json", "wrangler.jsonc", "wrangler.toml",
          }
          def sensitive_name(name):
              lower = name.lower()
              return (
                  lower in blocked_names
                  or ".config." in lower
                  or (lower.startswith(("tsconfig.", "jsconfig.")) and lower.endswith(".json"))
                  or any(marker in f"-{lower.replace('_', '-').replace('.', '-')}-" for marker in ("-secret-", "-secrets-", "-credential-", "-credentials-", "-service-account-"))
              )
          for path in sorted(root.rglob("*")):
              if path.is_symlink() or not path.is_file() or path.suffix.lower() not in allowed_extensions:
                  continue
              relative_path = path.relative_to(root)
              if any(part.startswith(".") for part in relative_path.parts) or sensitive_name(path.name):
                  continue
              relative = relative_path.as_posix()
              files.append((path, relative))
          if not files or len(files) > 1000:
              raise SystemExit(f"Preview output has {len(files)} files; expected 1..1000.")
          if not any(relative == "index.html" for _, relative in files):
              raise SystemExit("Preview output has no root index.html.")
          if sum(path.stat().st_size for path, _ in files) > 50 * 1024 * 1024:
              raise SystemExit("Preview output exceeds 50 MiB.")
          with tarfile.open(tar_path, "w", format=tarfile.GNU_FORMAT) as archive:
              for path, relative in files:
                  archive.add(path, arcname=relative, recursive=False)
          with tarfile.open(tar_path, "r") as archive:
              entries = [
                  {"path": member.name, "offset": member.offset_data, "size": member.size}
                  for member in archive.getmembers()
                  if member.isfile()
              ]
          if tar_path.stat().st_size > 50 * 1024 * 1024:
              raise SystemExit("Packaged preview exceeds 50 MiB.")
          manifest_path.write_text(json.dumps({"version": 1, "entry": "index.html", "files": entries}), encoding="utf-8")
          print(f"Packaged {len(entries)} files ({tar_path.stat().st_size} bytes).")
          PY
          } > >(tee "$LOG_FILE") 2>&1
          EXIT_CODE=$?
          echo "exit_code=$EXIT_CODE" >> "$GITHUB_OUTPUT"
          exit 0

      - name: Upload preview to Rork
        id: upload
        if: steps.build.outputs.exit_code == '0'
        shell: bash
        env:
          CALLBACK_URL: \${{ inputs.callback_url }}
          PREVIEW_ID: \${{ inputs.preview_id }}
        run: |
          OIDC_TOKEN="$(curl --fail --silent --show-error \
            -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=gera-repo-preview" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"
          printf '{"phase":"uploading"}' | curl --fail --silent --show-error \
            -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/json" --data-binary @- \
            "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/phase"
          curl --fail --silent --show-error -X PUT \
            -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/x-tar" \
            --data-binary @"$RUNNER_TEMP/gera-preview.tar" \
            "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/archive"
          curl --fail --silent --show-error -X PUT \
            -H "Authorization: Bearer $UPLOAD_TOKEN" -H "Content-Type: application/json" \
            --data-binary @"$RUNNER_TEMP/gera-preview-manifest.json" \
            "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/manifest"

      - name: Upload bounded build log
        if: always()
        continue-on-error: true
        shell: bash
        env:
          CALLBACK_URL: \${{ inputs.callback_url }}
          PREVIEW_ID: \${{ inputs.preview_id }}
        run: |
          OIDC_TOKEN="$(curl --fail --silent --show-error \
            -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=gera-repo-preview" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"
          touch "$RUNNER_TEMP/gera-preview.log"
          tail -c 120000 "$RUNNER_TEMP/gera-preview.log" | curl --fail --silent --show-error -X PUT \
            -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: text/plain; charset=utf-8" --data-binary @- \
            "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/logs"

      - name: Finalize preview
        if: always()
        shell: bash
        env:
          CALLBACK_URL: \${{ inputs.callback_url }}
          PREVIEW_ID: \${{ inputs.preview_id }}
          BUILD_CODE: \${{ steps.build.outputs.exit_code }}
          UPLOAD_OUTCOME: \${{ steps.upload.outcome }}
        run: |
          OIDC_TOKEN="$(curl --fail --silent --show-error \
            -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=gera-repo-preview" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"
          if [ "$BUILD_CODE" = "0" ] && [ "$UPLOAD_OUTCOME" = "success" ]; then
            STATUS=success
            MESSAGE="Static preview is ready."
          else
            STATUS=failed
            MESSAGE="Install, build, packaging, or upload failed. Open the bounded log in Gera."
          fi
          printf '{"status":"%s","message":"%s"}' "$STATUS" "$MESSAGE" | curl --fail --silent --show-error \
            -H "Authorization: Bearer $OIDC_TOKEN" -H "Content-Type: application/json" --data-binary @- \
            "$CALLBACK_URL/repo-preview-hook/$PREVIEW_ID/complete"
          if [ "$STATUS" != "success" ]; then exit 1; fi
`;
}
