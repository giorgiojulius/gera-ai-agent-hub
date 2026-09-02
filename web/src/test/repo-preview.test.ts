import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

import {
  REPO_PREVIEW_MAX_ARCHIVE_BYTES,
  detectRepoPreviewProject,
  isRepoPreviewAccessToken,
  isRepoPreviewArtifactPath,
  isRepoPreviewStagingKey,
  isRepoPreviewWebEntry,
  normalizeRepoPreviewArchiveCommit,
  normalizeRepoPreviewArchiveLength,
  normalizeRepoPreviewDirectory,
  normalizeRepoPreviewManifest,
  normalizeRepoPreviewRef,
  parseRepoPreviewRepository,
  rankRepoPreviewRoots,
  redactRepoPreviewLog,
  repoPreviewArchiveBaseKey,
  repoPreviewArchiveFailureMessage,
  repoPreviewContentSecurityPolicy,
  repoPreviewContentType,
  repoPreviewPublicPrefix,
  repoPreviewRootIsWorkspaceShell,
  repoPreviewRorkWebRoot,
  repoPreviewRunnerVersion,
  repoPreviewSafeRouteLabel,
  repoPreviewStagingKey,
  repoPreviewStorageUnavailableMessage,
  repoPreviewWorkflowMatches,
  repoPreviewWorkflowRunMatches,
  repoPreviewWorkflowSource,
  signRepoPreviewId,
  verifyRepoPreviewId,
  repoPreviewSandboxShim,
  rewriteRepoPreviewHtml,
} from "../../../functions/repo-preview-shared";
import {
  authorizeGitHubPreviewClaims,
  verifyGitHubActionsOidc,
  type GitHubOidcClaims,
} from "../../../functions/github-oidc";
import { stripRepoPreviewCapabilities } from "../../../functions/share-safety";
import { normalizeRepoPreviewInspection, normalizeRepoPreviewJob } from "@/lib/repo-preview";
import { buildShareSnapshot } from "@/lib/shares";
import type { Conversation, RepoPreviewJob } from "@/lib/types";

describe("repository preview contract", () => {
  it("signs public ids so fabricated values cannot allocate backend shards", async () => {
    const secret = "test-preview-secret";
    const id = await signRepoPreviewId("a".repeat(24), "b".repeat(32), secret);
    expect(await verifyRepoPreviewId(id, secret)).toBe(true);
    const tampered = `${id.slice(0, -1)}${id.endsWith("0") ? "1" : "0"}`;
    expect(await verifyRepoPreviewId(tampered, secret)).toBe(false);
    expect(await verifyRepoPreviewId(`${"a".repeat(24)}.${"b".repeat(32)}.${"c".repeat(24)}`, secret)).toBe(false);
    const access = "d".repeat(48);
    expect(isRepoPreviewAccessToken(access)).toBe(true);
    expect(repoPreviewPublicPrefix(id, access)).toBe(`/repo-preview/${id}/${access}/`);
    expect(repoPreviewPublicPrefix(id, "too-short")).toBeNull();
  });

  it("keeps repositories, refs and monorepo paths out of traversal and shell syntax", () => {
    expect(parseRepoPreviewRepository("acme/site.v2")).toEqual({
      owner: "acme",
      repo: "site.v2",
      fullName: "acme/site.v2",
    });
    expect(parseRepoPreviewRepository("acme/site/extra")).toBeNull();
    expect(normalizeRepoPreviewDirectory("apps/web/")).toBe("apps/web");
    expect(normalizeRepoPreviewDirectory("../private")).toBeNull();
    expect(normalizeRepoPreviewDirectory("/etc")).toBeNull();
    expect(normalizeRepoPreviewRef("feature/web-preview")).toBe("feature/web-preview");
    expect(normalizeRepoPreviewRef("main; curl bad.example")).toBeUndefined();
  });

  it("detects common web stacks and their lockfile without executing repository code", () => {
    expect(
      detectRepoPreviewProject(
        JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "latest" } }),
        ["package.json", "bun.lock", "index.html"],
      ),
    ).toEqual({ framework: "vite", packageManager: "bun", projectFound: true });
    expect(detectRepoPreviewProject(null, ["index.html", "style.css"])).toEqual({
      framework: "static",
      packageManager: "none",
      projectFound: true,
    });
    expect(detectRepoPreviewProject(null, ["README.md"])).toEqual({
      framework: "unknown",
      packageManager: "none",
      projectFound: false,
    });
  });

  // Gera's own repository shape: rork.json at the root, the Vite app in web/,
  // the Worker in functions/ and no runnable root package.json.
  const rorkWorkspacePaths = [
    "rork.json",
    ".gitignore",
    ".rork/plans/plan.md",
    "functions/package.json",
    "functions/index.ts",
    "web/package.json",
    "web/bun.lock",
    "web/index.html",
    "web/vite.config.ts",
    "web/public/robots.txt",
    "web/src/main.tsx",
    "web/e2e/index.html",
    "web/node_modules/vite/package.json",
  ];

  it("reads the web app root from a Rork workspace's rork.json and ignores other frameworks", () => {
    const rorkJson = JSON.stringify({
      apps: [
        { name: "Functions", path: "functions", framework: "cloudflare" },
        { name: "Gera AI", path: "web/", framework: "web" },
      ],
    });
    expect(repoPreviewRorkWebRoot(rorkJson)).toBe("web");
    expect(repoPreviewRorkWebRoot(JSON.stringify({ apps: [{ path: "expo", framework: "expo" }] }))).toBeNull();
    expect(repoPreviewRorkWebRoot(JSON.stringify({ apps: [{ path: "../escape", framework: "web" }] }))).toBeNull();
    expect(repoPreviewRorkWebRoot(JSON.stringify({ apps: [{ framework: "web" }] }))).toBe(".");
    expect(repoPreviewRorkWebRoot("{not json")).toBeNull();
    expect(repoPreviewRorkWebRoot(null)).toBeNull();
  });

  it("ranks the web folder above the Worker and never proposes output or dependency folders", () => {
    const ranked = rankRepoPreviewRoots(rorkWorkspacePaths);
    expect(ranked[0]).toBe("web");
    expect(ranked).toContain("functions");
    expect(ranked.indexOf("web")).toBeLessThan(ranked.indexOf("functions"));
    expect(ranked).not.toContain("web/node_modules/vite");
    expect(ranked).not.toContain("web/public");
    expect(ranked).not.toContain(".rork/plans");
    expect(ranked).not.toContain(".");

    expect(rankRepoPreviewRoots(["package.json", "apps/api/package.json", "apps/site/package.json", "apps/site/index.html"]))
      .toEqual(["apps/site", ".", "apps/api"]);
    expect(rankRepoPreviewRoots(["packages/ui/package.json", "dist/index.html", "build/index.html"]))
      .toEqual(["packages/ui"]);
  });

  it("treats workspace shells as non-buildable roots but respects a real root build", () => {
    expect(repoPreviewRootIsWorkspaceShell(null, rorkWorkspacePaths)).toBe(true);
    expect(repoPreviewRootIsWorkspaceShell(null, ["README.md"])).toBe(true);
    expect(
      repoPreviewRootIsWorkspaceShell(JSON.stringify({ workspaces: ["apps/*"], scripts: { build: "turbo run build" } }), [
        "package.json",
      ]),
    ).toBe(true);
    expect(repoPreviewRootIsWorkspaceShell(JSON.stringify({ scripts: { build: "webpack" } }), ["package.json", "turbo.json"]))
      .toBe(true);
    expect(repoPreviewRootIsWorkspaceShell(JSON.stringify({ scripts: { test: "vitest" } }), ["package.json"])).toBe(true);
    expect(repoPreviewRootIsWorkspaceShell(JSON.stringify({ scripts: { build: "webpack" } }), ["package.json"])).toBe(false);

    expect(isRepoPreviewWebEntry({ framework: "vite", packageManager: "bun", projectFound: true })).toBe(true);
    expect(isRepoPreviewWebEntry({ framework: "static", packageManager: "none", projectFound: true })).toBe(true);
    expect(isRepoPreviewWebEntry({ framework: "unknown", packageManager: "npm", projectFound: true })).toBe(false);
    expect(
      isRepoPreviewWebEntry(
        detectRepoPreviewProject(JSON.stringify({ dependencies: { hono: "4" } }), ["package.json", "index.ts"]),
      ),
    ).toBe(false);
  });

  it("keeps the resolved root source and defaults it for older backends", () => {
    const base = {
      repository: "acme/gera",
      defaultBranch: "main",
      ref: "main",
      commitSha: "c".repeat(40),
      rootSuggestions: ["web", "functions"],
      runner: "ready",
      framework: "vite",
      packageManager: "bun",
      projectFound: true,
    };
    expect(normalizeRepoPreviewInspection({ ...base, rootDirectory: "web", rootSource: "rork.json" })).toMatchObject({
      rootDirectory: "web",
      rootSource: "rork.json",
      rootSuggestions: ["web", "functions"],
    });
    expect(normalizeRepoPreviewInspection({ ...base, rootDirectory: "web", rootSource: "made-up" })?.rootSource).toBe("explicit");
    expect(normalizeRepoPreviewInspection({ ...base, rootDirectory: "." })?.rootSource).toBe("root");
  });

  it("accepts only bounded tar offsets and a real indexed entry point", () => {
    const valid = normalizeRepoPreviewManifest(
      {
        version: 1,
        entry: "index.html",
        files: [
          { path: "index.html", offset: 512, size: 120 },
          { path: "assets/app.js", offset: 1_024, size: 400 },
        ],
      },
      2_048,
    );
    expect(valid?.files).toHaveLength(2);
    expect(isRepoPreviewArtifactPath("assets/app.js")).toBe(true);
    expect(isRepoPreviewArtifactPath(".env")).toBe(false);
    expect(isRepoPreviewArtifactPath(".git/config")).toBe(false);
    expect(isRepoPreviewArtifactPath("package.json")).toBe(false);
    expect(isRepoPreviewArtifactPath("vite.config.js")).toBe(false);
    expect(isRepoPreviewArtifactPath("next.config.mjs")).toBe(false);
    expect(isRepoPreviewArtifactPath("webpack.config.js")).toBe(false);
    expect(isRepoPreviewArtifactPath("wrangler.json")).toBe(false);
    expect(isRepoPreviewArtifactPath("config.json")).toBe(false);
    expect(isRepoPreviewArtifactPath("secrets.json")).toBe(false);
    expect(isRepoPreviewArtifactPath("tsconfig.app.json")).toBe(false);
    expect(isRepoPreviewArtifactPath("feed.xml")).toBe(false);
    expect(
      normalizeRepoPreviewManifest(
        { version: 1, entry: "index.html", files: [{ path: "../index.html", offset: 0, size: 4 }] },
        10,
      ),
    ).toBeNull();
    expect(
      normalizeRepoPreviewManifest(
        { version: 1, entry: "index.html", files: [{ path: "index.html", offset: 900, size: 200 }] },
        1_000,
      ),
    ).toBeNull();
    expect(normalizeRepoPreviewManifest({ version: 1, entry: "index.html", files: [] }, REPO_PREVIEW_MAX_ARCHIVE_BYTES + 1)).toBeNull();
  });

  it("sandboxes active SVG documents without breaking their image MIME type", () => {
    expect(repoPreviewContentType("assets/logo.svg")).toBe("image/svg+xml");
    expect(repoPreviewContentSecurityPolicy("assets/logo.svg")).toContain("sandbox;");
    expect(repoPreviewContentSecurityPolicy("assets/logo.svg")).toContain("script-src 'none'");
    expect(repoPreviewContentSecurityPolicy("index.html")).toContain("sandbox allow-scripts");
    expect(repoPreviewContentSecurityPolicy("assets/logo.png")).toBeUndefined();
  });

  it("rewrites root assets into one preview namespace and redacts credential-shaped logs", () => {
    const html = rewriteRepoPreviewHtml(
      '<html><head></head><body><script src="/assets/app.js"></script><img src="https://cdn.example/a.png"></body></html>',
      "/repo-preview/p.abc/",
    );
    expect(html).toContain('<base href="/repo-preview/p.abc/">');
    expect(html).toContain('src="/repo-preview/p.abc/assets/app.js"');
    expect(html).toContain('src="https://cdn.example/a.png"');
    // The storage shim boots before the app's own scripts and stays escape-free.
    const shimAt = html.indexOf("<script data-gera-preview-shim>");
    expect(shimAt).toBeGreaterThan(html.indexOf("<base "));
    expect(shimAt).toBeLessThan(html.indexOf('<script src="/repo-preview/p.abc/assets/app.js">'));
    expect(repoPreviewSandboxShim()).not.toContain("\\");
    expect(repoPreviewSandboxShim()).not.toMatch(/<\/script>.+<\/script>/s);
    // Popups and route changes are bridged to the embedding Gera page instead of dying as about:blank.
    expect(repoPreviewSandboxShim()).toContain("if(window.parent===window)return;");
    expect(repoPreviewSandboxShim()).toContain('source:"gera-preview",type:"open"');
    expect(repoPreviewSandboxShim()).toContain('source:"gera-preview",type:"state"');
    expect(repoPreviewSandboxShim()).toContain("window.open=function");
    expect(rewriteRepoPreviewHtml("<p>bare</p>", "/repo-preview/p.abc")).toMatch(/^<base href="\/repo-preview\/p\.abc\/"><script data-gera-preview-shim>/);
    const capabilityPrefix = `/repo-preview/${"a".repeat(24)}.${"b".repeat(32)}.${"c".repeat(24)}/${"d".repeat(48)}/`;
    const alreadyNamespaced = rewriteRepoPreviewHtml(
      `<script src="${capabilityPrefix}assets/app.js"></script>`,
      capabilityPrefix,
    );
    expect(alreadyNamespaced).toContain(`src="${capabilityPrefix}assets/app.js"`);
    expect(alreadyNamespaced).not.toContain(`${capabilityPrefix}repo-preview/`);

    const previewId = `${"a".repeat(24)}.${"b".repeat(32)}.${"c".repeat(24)}`;
    const log = redactRepoPreviewLog(
      `Authorization: Bearer secret-secret-secret\nghp_abcdefghijklmnopqrstuvwxyz123456\nhttps://u:p@example.com/a?token=hello\n${previewId}`,
    );
    expect(log).not.toContain("secret-secret-secret");
    expect(log).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(log).not.toContain("u:p");
    expect(log).not.toContain("token=hello");
    expect(log).not.toContain(previewId);
    expect(log).toContain("[redacted]");
    expect(repoPreviewSafeRouteLabel(`/asset/${previewId}/index.html`)).toBe("/asset/[redacted]");
    expect(repoPreviewSafeRouteLabel(`/hook/${previewId}/complete`)).toBe("/hook/[redacted]");
  });

  it("cryptographically verifies the GitHub OIDC issuer, audience, lifetime and signature", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2_048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "test-kid" };
    const encode = (value: unknown): string => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    };
    const sign = async (claims: Record<string, unknown>): Promise<string> => {
      const header = encode({ alg: "RS256", typ: "JWT", kid: "test-kid" });
      const payload = encode(claims);
      const signature = new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
      );
      let binary = "";
      for (const byte of signature) binary += String.fromCharCode(byte);
      return `${header}.${payload}.${btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
    };
    const now = Math.floor(Date.now() / 1_000);
    const claims = {
      iss: "https://token.actions.githubusercontent.com",
      aud: "gera-repo-preview",
      sub: "repo:acme/site:ref:refs/heads/main",
      jti: "one-job-token",
      iat: now - 5,
      nbf: now - 5,
      exp: now + 300,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));
    try {
      expect(await verifyGitHubActionsOidc(await sign(claims))).toMatchObject({ aud: "gera-repo-preview" });
      expect(await verifyGitHubActionsOidc(await sign({ ...claims, aud: "other-service" }))).toBeNull();
      const token = await sign(claims);
      const parts = token.split(".");
      parts[2] = `${parts[2]?.startsWith("A") ? "B" : "A"}${parts[2]?.slice(1) ?? ""}`;
      expect(await verifyGitHubActionsOidc(parts.join("."))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a dispatch whose mutable ref did not resolve to the inspected workflow commit", () => {
    const sha = "a".repeat(40);
    const run = {
      id: 4242,
      repository: { full_name: "acme/site" },
      head_sha: sha,
      head_branch: "main",
      path: ".github/workflows/gera-web-preview.yml",
      event: "workflow_dispatch",
      run_attempt: 1,
      name: "Gera web preview",
      html_url: "https://github.com/acme/site/actions/runs/4242",
    };
    const expected = {
      repository: "acme/site",
      defaultBranch: "main",
      workflowSha: sha,
      workflowPath: ".github/workflows/gera-web-preview.yml",
      runId: "4242",
    };
    expect(repoPreviewWorkflowRunMatches(run, expected)).toBe(true);
    expect(repoPreviewWorkflowRunMatches({ ...run, head_sha: "b".repeat(40) }, expected)).toBe(false);
    expect(repoPreviewWorkflowRunMatches({ ...run, path: ".github/workflows/other.yml" }, expected)).toBe(false);
    expect(repoPreviewWorkflowRunMatches({ ...run, event: "push" }, expected)).toBe(false);
  });

  it("binds callback identity to the exact GitHub run and canonical workflow revision", () => {
    const sha = "a".repeat(40);
    const claims: GitHubOidcClaims = {
      repository: "acme/site",
      workflow_ref: "acme/site/.github/workflows/gera-web-preview.yml@refs/heads/main",
      workflow_sha: sha,
      workflow: "Gera web preview",
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      ref_type: "branch",
      sha,
      run_id: "4242",
      run_attempt: "1",
      runner_environment: "github-hosted",
    };
    const expected = {
      repository: "acme/site",
      runId: "4242",
      workflowPath: ".github/workflows/gera-web-preview.yml",
      workflowRef: "refs/heads/main",
      workflowSha: sha,
    };
    expect(authorizeGitHubPreviewClaims(claims, expected)).toBe(true);
    expect(authorizeGitHubPreviewClaims({ ...claims, run_id: "4243" }, expected)).toBe(false);
    expect(authorizeGitHubPreviewClaims({ ...claims, workflow_sha: "b".repeat(40) }, expected)).toBe(false);
    expect(authorizeGitHubPreviewClaims({ ...claims, ref: "refs/heads/other" }, expected)).toBe(false);
    expect(authorizeGitHubPreviewClaims({ ...claims, runner_environment: "self-hosted" }, expected)).toBe(false);
    expect(authorizeGitHubPreviewClaims({ ...claims, run_attempt: "2" }, expected)).toBe(false);
  });

  it("ships a read-only immutable workflow with GitHub OIDC and no dispatched secret", () => {
    const source = repoPreviewWorkflowSource();
    expect(repoPreviewRunnerVersion(source)).toBe(3);
    expect(repoPreviewWorkflowMatches(source)).toBe(true);
    expect(repoPreviewWorkflowMatches(source.replace("contents: read", "contents: write"))).toBe(false);
    expect(source).toContain("permissions: {}");
    expect(source).toContain("run-name: Gera web preview");
    expect(source).toContain("audience=gera-repo-preview");
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("ref: ${{ inputs.commit_sha }}");
    expect(source).toContain("timeout-minutes: 20");
    expect(source).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(source).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(source).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(source).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(source).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(source).toContain('Authorization: Bearer $OIDC_TOKEN');
    expect(source).toContain("/repo-preview-hook/$PREVIEW_ID/archive");
    expect(source).not.toContain("upload_token");
    expect(source).not.toContain("UPLOAD_TOKEN");
    expect(source).not.toContain("access_token");
    expect(source).not.toContain("${{ secrets.");
    expect(source).not.toContain("${{ inputs.preview_id }}");
    expect(source).not.toContain("run-name: Gera preview ·");
    expect(source).not.toContain("pull_request:");
    type WorkflowJob = {
      permissions?: Record<string, string>;
      steps?: Array<{ name?: string; run?: string; env?: Record<string, string>; uses?: string }>;
    };
    const workflow = parse(source) as { jobs?: { begin?: WorkflowJob; build?: WorkflowJob; publish?: WorkflowJob } };
    const begin = workflow.jobs?.begin;
    const build = workflow.jobs?.build;
    const publish = workflow.jobs?.publish;
    expect(begin?.permissions).toEqual({ contents: "none", "id-token": "write" });
    expect(build?.permissions).toEqual({ contents: "read", "id-token": "none" });
    expect(publish?.permissions).toEqual({ actions: "read", contents: "none", "id-token": "write" });
    const buildSteps = build?.steps ?? [];
    expect(buildSteps.length).toBeGreaterThan(4);
    expect(buildSteps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(true);
    expect(buildSteps.some((step) => step.run?.includes("ACTIONS_ID_TOKEN_REQUEST"))).toBe(false);
    const buildScript = buildSteps.find((step) => step.name === "Install, build and package")?.run;
    expect(buildScript).toContain("python3 - <<'PY'");
    expect(buildScript).toContain("/repo-preview/__GERA_PREVIEW_BASE__/");
    expect(buildScript).not.toContain("PREVIEW_ID");
    expect(begin?.steps?.[0]?.run).toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    const publishScript = publish?.steps?.find((step) => step.name === "Publish from trusted job")?.run;
    expect(publishScript).toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    expect(publishScript).toContain("/configuration");
    expect(publishScript).toContain("data.replace(placeholder, replacement)");
    expect(publishScript).toContain('echo "::add-mask::$PREVIEW_ACCESS"');
  });

  it("removes the private preview read capability from public chat snapshots", async () => {
    const now = Date.now();
    const accessToken = "e".repeat(48);
    const job: RepoPreviewJob = {
      id: `${"a".repeat(24)}.${"b".repeat(32)}.${"d".repeat(24)}`,
      repository: "acme/site",
      ref: "main",
      commitSha: "c".repeat(40),
      rootDirectory: ".",
      framework: "vite",
      packageManager: "bun",
      phase: "ready",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 1_000,
      previewUrl: `https://preview.example/repo-preview/${"a".repeat(24)}.${"b".repeat(32)}.${"d".repeat(24)}/${accessToken}/`,
    };
    const conversation: Conversation = {
      id: "chat-preview",
      title: "Private preview",
      modelId: "openai/gpt-5.1",
      createdAt: now,
      updatedAt: now,
      messages: [{ id: "m1", role: "assistant", content: "", createdAt: now, repoPreview: job }],
    };
    const snapshot = await buildShareSnapshot(conversation);
    expect(snapshot.messages[0]?.repoPreview).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(job.id);
    expect(JSON.stringify(snapshot)).not.toContain(accessToken);
    expect(snapshot.messages[0]?.content).toContain("stay private");

    const serverSanitized = stripRepoPreviewCapabilities({
      messages: [{ role: "assistant", content: "", repoPreview: { id: job.id, previewUrl: "https://private" } }],
    }) as { messages: Array<{ content: string; repoPreview?: unknown }> };
    expect(serverSanitized.messages[0]?.repoPreview).toBeUndefined();
    expect(serverSanitized.messages[0]?.content).toContain("stay private");
    expect(JSON.stringify(serverSanitized)).not.toContain(job.id);
  });

  it("binds the artifact staging key to one exact workflow run", () => {
    const archiveKey = `previews/${"a".repeat(24)}/${"b".repeat(64)}.tar`;
    const stagingKey = repoPreviewStagingKey(archiveKey, "123456");
    expect(stagingKey).toBe(`${archiveKey}.upload-run-123456`);
    expect(repoPreviewStagingKey(stagingKey, "777")).toBe(`${archiveKey}.upload-run-777`);
    expect(repoPreviewArchiveBaseKey(stagingKey)).toBe(archiveKey);
    expect(repoPreviewArchiveBaseKey(archiveKey)).toBe(archiveKey);
    expect(isRepoPreviewStagingKey(stagingKey, "123456")).toBe(true);
    expect(isRepoPreviewStagingKey(stagingKey, "654321")).toBe(false);
    expect(isRepoPreviewStagingKey(archiveKey, "123456")).toBe(false);
    expect(isRepoPreviewStagingKey(`../${stagingKey}`, "123456")).toBe(false);
    expect(isRepoPreviewStagingKey(stagingKey, "12a")).toBe(false);
    expect(isRepoPreviewStagingKey(undefined, "123456")).toBe(false);
  });

  it("accepts only bounded artifact sizes and well-formed transfer reports", () => {
    expect(normalizeRepoPreviewArchiveLength(8_388_608)).toBe(8_388_608);
    expect(normalizeRepoPreviewArchiveLength(REPO_PREVIEW_MAX_ARCHIVE_BYTES)).toBe(REPO_PREVIEW_MAX_ARCHIVE_BYTES);
    expect(normalizeRepoPreviewArchiveLength(REPO_PREVIEW_MAX_ARCHIVE_BYTES + 1)).toBeNull();
    expect(normalizeRepoPreviewArchiveLength(0)).toBeNull();
    expect(normalizeRepoPreviewArchiveLength(12.5)).toBeNull();
    expect(normalizeRepoPreviewArchiveLength("8")).toBeNull();

    const stagingKey = repoPreviewStagingKey(`previews/${"a".repeat(24)}/${"b".repeat(64)}.tar`, "42");
    const uploaded = normalizeRepoPreviewArchiveCommit({ stagingKey, contentLength: 1024, status: 200, failure: "" }, "42");
    expect(uploaded).toEqual({ stagingKey, contentLength: 1024, status: 200, failure: "", uploaded: true });

    const rejected = normalizeRepoPreviewArchiveCommit({ stagingKey, contentLength: 1024, status: 403 }, "42");
    expect(rejected?.uploaded).toBe(false);
    expect(repoPreviewArchiveFailureMessage(rejected!)).toBe("Rork storage rejected the preview artifact (HTTP 403).");

    const broken = normalizeRepoPreviewArchiveCommit(
      { stagingKey, contentLength: 1024, status: 200, failure: " Network connection lost. " },
      "42",
    );
    expect(broken?.uploaded).toBe(false);
    expect(repoPreviewArchiveFailureMessage(broken!)).toContain("Network connection lost.");
    expect(repoPreviewArchiveFailureMessage({ status: 0, failure: "" })).toBe(
      "The preview artifact transfer to Rork storage did not complete.",
    );

    expect(normalizeRepoPreviewArchiveCommit({ stagingKey, contentLength: 1024, status: 200 }, "43")).toBeNull();
    expect(normalizeRepoPreviewArchiveCommit({ stagingKey: "previews/x.tar", contentLength: 1024, status: 200 }, "42")).toBeNull();
    expect(normalizeRepoPreviewArchiveCommit({ stagingKey, contentLength: 0, status: 200 }, "42")).toBeNull();
    expect(normalizeRepoPreviewArchiveCommit(null, "42")).toBeNull();

    expect(repoPreviewStorageUnavailableMessage(new Error("storage_quota"))).toContain("quota");
    expect(repoPreviewStorageUnavailableMessage(new Error("storage_unavailable"))).toContain("storage_unavailable");
    expect(repoPreviewStorageUnavailableMessage("boom")).toContain("Enable file storage");
    expect(repoPreviewStorageUnavailableMessage(new Error("storage_unavailable:403 storage_not_enabled"))).toContain(
      "not enabled for this project (storage_unavailable: 403 storage_not_enabled)",
    );
    expect(repoPreviewStorageUnavailableMessage(new Error("storage_unavailable:401 unauthorized"))).toContain(
      "rejected the Gera backend's toolkit key",
    );
    expect(repoPreviewStorageUnavailableMessage(new Error("storage_unavailable:no_toolkit_secret"))).toContain(
      "no Rork toolkit key",
    );
    expect(
      repoPreviewStorageUnavailableMessage(new Error("storage_unavailable:dev-x.rorktest.dev 404; rork.app 301")),
    ).toContain("No Rork API host would mint storage credentials (storage_unavailable: dev-x.rorktest.dev 404; rork.app 301)");
  });

  it("normalizes durable jobs and drops unsafe URLs before rendering", () => {
    const now = Date.now();
    const normalized = normalizeRepoPreviewJob({
      id: `${"a".repeat(24)}.${"b".repeat(32)}.${"d".repeat(24)}`,
      repository: "acme/site",
      ref: "main",
      commitSha: "c".repeat(40),
      rootDirectory: ".",
      framework: "vite",
      packageManager: "pnpm",
      phase: "ready",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 1_000,
      previewUrl: "https://preview.example/app",
      actionsUrl: "javascript:alert(1)",
      logs: "ready",
    });
    expect(normalized?.previewUrl).toBe("https://preview.example/app");
    expect(normalized?.actionsUrl).toBeUndefined();
    expect(
      normalizeRepoPreviewJob({
        ...normalized,
        rootDirectory: "../escape",
      }),
    ).toBeUndefined();
  });
});
