import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  REPO_PREVIEW_MAX_ARCHIVE_BYTES,
  detectRepoPreviewProject,
  isRepoPreviewArtifactPath,
  normalizeRepoPreviewDirectory,
  normalizeRepoPreviewManifest,
  normalizeRepoPreviewRef,
  parseRepoPreviewRepository,
  redactRepoPreviewLog,
  repoPreviewRunnerVersion,
  repoPreviewWorkflowMatches,
  repoPreviewWorkflowSource,
  signRepoPreviewId,
  verifyRepoPreviewId,
  rewriteRepoPreviewHtml,
} from "../../../functions/repo-preview-shared";
import { stripRepoPreviewCapabilities } from "../../../functions/share-safety";
import { normalizeRepoPreviewJob } from "@/lib/repo-preview";
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

  it("rewrites root assets into one preview namespace and redacts credential-shaped logs", () => {
    const html = rewriteRepoPreviewHtml(
      '<html><head></head><body><script src="/assets/app.js"></script><img src="https://cdn.example/a.png"></body></html>',
      "/repo-preview/p.abc/",
    );
    expect(html).toContain('<base href="/repo-preview/p.abc/">');
    expect(html).toContain('src="/repo-preview/p.abc/assets/app.js"');
    expect(html).toContain('src="https://cdn.example/a.png"');

    const log = redactRepoPreviewLog(
      "Authorization: Bearer secret-secret-secret\nghp_abcdefghijklmnopqrstuvwxyz123456\nhttps://u:p@example.com/a?token=hello",
    );
    expect(log).not.toContain("secret-secret-secret");
    expect(log).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(log).not.toContain("u:p");
    expect(log).not.toContain("token=hello");
    expect(log).toContain("[redacted]");
  });

  it("ships a read-only immutable workflow with no repository-secret interpolation", () => {
    const source = repoPreviewWorkflowSource();
    expect(repoPreviewRunnerVersion(source)).toBe(1);
    expect(repoPreviewWorkflowMatches(source)).toBe(true);
    expect(repoPreviewWorkflowMatches(source.replace("contents: read", "contents: write"))).toBe(false);
    expect(source).toContain("permissions:\n  contents: read");
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("ref: ${{ inputs.commit_sha }}");
    expect(source).toContain("timeout-minutes: 20");
    expect(source).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(source).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(source).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(source).toContain('Authorization: Bearer $UPLOAD_TOKEN');
    expect(source).toContain("/repo-preview-hook/$PREVIEW_ID/archive");
    expect(source).not.toContain("/$UPLOAD_TOKEN/");
    expect(source).not.toContain("${{ secrets.");
    expect(source).not.toContain("pull_request:");
    const workflow = parse(source) as { jobs?: { preview?: { steps?: Array<{ name?: string; run?: string }> } } };
    const steps = workflow.jobs?.preview?.steps ?? [];
    expect(steps.length).toBeGreaterThan(5);
    expect(steps.find((step) => step.name === "Install, build and package")?.run).toContain("python3 - <<'PY'");
  });

  it("removes the unguessable preview capability from public chat snapshots", async () => {
    const now = Date.now();
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
    expect(snapshot.messages[0]?.content).toContain("stay private");

    const serverSanitized = stripRepoPreviewCapabilities({
      messages: [{ role: "assistant", content: "", repoPreview: { id: job.id, previewUrl: "https://private" } }],
    }) as { messages: Array<{ content: string; repoPreview?: unknown }> };
    expect(serverSanitized.messages[0]?.repoPreview).toBeUndefined();
    expect(serverSanitized.messages[0]?.content).toContain("stay private");
    expect(JSON.stringify(serverSanitized)).not.toContain(job.id);
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
