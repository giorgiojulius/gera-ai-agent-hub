import { describe, expect, it } from "vitest";

import {
  buildCodePatch,
  deriveCodeChangeFlow,
  finalizeCodeChangeFlow,
  isCodeMutationToolName,
} from "../../../functions/code-change-flow";
import { mergeCodeChangeStates, safeCodePreviewUrl } from "@/lib/code-changes";
import { normalizeCodeChangeState } from "@/lib/history";
import type { RunToolRecord } from "../../../functions/run-protocol";

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
  status: RunToolRecord["status"] = "done",
  result?: string,
): RunToolRecord {
  return { id, name, arguments: JSON.stringify(args), status, ...(result !== undefined ? { result } : {}) };
}

describe("code change flow", () => {
  it("builds an honest diff, PR, checks, and deployment preview from real tool records", () => {
    const before = "<!doctype html>\n<html>\n<body>Old</body>\n</html>";
    const after = "<!doctype html>\n<html>\n<body>New</body>\n</html>";
    const calls: RunToolRecord[] = [
      call("read", "mcp_github_get_contents", { owner: "acme", repo: "site", path: "index.html", ref: "main" }, "done", `index.html (52 B, sha abc123):\n${before}`),
      call("branch", "mcp_github_create_branch", { owner: "acme", repo: "site", branch: "gera/hero", from: "main" }, "done", "Created branch"),
      call("write", "mcp_github_put_file", { owner: "acme", repo: "site", branch: "gera/hero", path: "index.html", content: after, expected_sha: "abc123", message: "Update hero" }, "done", "Updated index.html"),
      call("checks", "mcp_github_list_workflow_runs", { owner: "acme", repo: "site", branch: "gera/hero" }, "done", "run_id 7 [success] build — https://github.com/acme/site/actions/runs/7"),
      call("deploy", "mcp_github_list_deployments", { owner: "acme", repo: "site" }, "done", "Preview [success]\n  preview: https://gera-hero.example.dev"),
      call("pr", "mcp_github_create_pull", { owner: "acme", repo: "site", head: "gera/hero", title: "Update hero" }, "done", "Opened PR #8: https://github.com/acme/site/pull/8"),
    ];

    const flow = finalizeCodeChangeFlow(calls, 123);
    expect(flow).toMatchObject({
      status: "done",
      repository: "acme/site",
      branch: "gera/hero",
      pullRequestUrl: "https://github.com/acme/site/pull/8",
      preview: { kind: "url", url: "https://gera-hero.example.dev/" },
      validation: { status: "passed", label: "Checks passed" },
    });
    expect(flow?.files).toHaveLength(1);
    expect(flow?.files[0]).toMatchObject({ path: "index.html", action: "update", additions: 1, deletions: 1 });
    expect(flow?.files[0].patch).toContain("-<body>Old</body>");
    expect(flow?.files[0].patch).toContain("+<body>New</body>");
  });

  it("starts the flow on a branch call and runs committed HTML with changed local assets inlined", () => {
    const html = "<!doctype html><html><head><link rel=\"stylesheet\" href=\"./app.css\"></head><body><button>It works</button><script src=\"./app.js\"></script></body></html>";
    const branchOnly = deriveCodeChangeFlow([
      call("branch", "mcp_github_create_branch", { owner: "acme", repo: "demo", branch: "gera/demo" }, "running"),
    ], 10);
    expect(branchOnly).toMatchObject({ status: "running", files: [], repository: "acme/demo", branch: "gera/demo" });

    const settled = finalizeCodeChangeFlow([
      call("css", "mcp_github_put_file", { owner: "acme", repo: "demo", branch: "gera/demo", path: "public/app.css", content: "button { color: tomato; }", message: "Style demo" }, "done", "Created public/app.css"),
      call("js", "mcp_github_put_file", { owner: "acme", repo: "demo", branch: "gera/demo", path: "public/app.js", content: "document.body.dataset.ready = 'yes';", message: "Wire demo" }, "done", "Created public/app.js"),
      call("write", "mcp_github_put_file", { owner: "acme", repo: "demo", branch: "gera/demo", path: "public/index.html", content: html, message: "Add demo" }, "done", "Created public/index.html"),
    ], 10);
    expect(settled?.preview).toMatchObject({ kind: "html", label: "public/index.html" });
    expect(settled?.preview?.kind === "html" ? settled.preview.html : "").toContain("<style data-gera-source=\"./app.css\">button { color: tomato; }</style>");
    expect(settled?.preview?.kind === "html" ? settled.preview.html : "").toContain("document.body.dataset.ready = 'yes';");
    expect(settled?.files.find((file) => file.path === "public/index.html")).toMatchObject({ action: "create", additions: 1, deletions: 0 });
  });

  it("keeps completed files visible while the next tool arguments are still streaming", () => {
    const first = deriveCodeChangeFlow([
      call("write", "mcp_github_put_file", { path: "src/app.ts", content: "export const x = 1;" }, "done", "Created src/app.ts"),
    ], 1);
    expect(first?.files).toHaveLength(1);
    const next = deriveCodeChangeFlow([
      { id: "pr", name: "mcp_github_create_pull", arguments: "{\"head\":", status: "running" },
    ], 1, first);
    expect(next?.files[0].path).toBe("src/app.ts");
  });

  it("bounds giant diffs and rejects unsafe external previews", () => {
    const before = Array.from({ length: 800 }, (_, index) => `old-${index}-${"x".repeat(40)}`).join("\n");
    const after = Array.from({ length: 800 }, (_, index) => `new-${index}-${"y".repeat(40)}`).join("\n");
    const diff = buildCodePatch(before, after);
    expect(diff.truncated).toBe(true);
    expect(diff.patch.length).toBeLessThanOrEqual(30_030);
    expect(safeCodePreviewUrl("http://preview.example.com")).toBeNull();
    expect(safeCodePreviewUrl("https://user:secret@preview.example.com")).toBeNull();
    expect(safeCodePreviewUrl("https://preview.example.com/app")).toBe("https://preview.example.com/app");
  });

  it("sanitizes synced preview records before they reach links or iframes", () => {
    const normalized = normalizeCodeChangeState({
      status: "done",
      startedAt: 1,
      files: [{ id: "f", path: "index.html", action: "create", status: "done", additions: 1, deletions: 0 }],
      pullRequestUrl: "javascript:alert(1)",
      validation: { status: "passed", label: "Checks", url: "data:text/html,bad" },
      preview: { kind: "url", label: "bad", url: "https://user:secret@example.com" },
    });
    expect(normalized?.pullRequestUrl).toBeUndefined();
    expect(normalized?.validation?.url).toBeUndefined();
    expect(normalized?.preview).toBeUndefined();
  });

  it("recognizes namespaced mutations and merges continuation ledgers", () => {
    expect(isCodeMutationToolName("mcp_github_put_file")).toBe(true);
    expect(isCodeMutationToolName("web_search")).toBe(false);
    const base = finalizeCodeChangeFlow([
      call("one", "put_file", { path: "one.ts", content: "one" }, "done", "Created one.ts"),
    ], 10);
    const next = finalizeCodeChangeFlow([
      call("two", "write_file", { file_path: "two.ts", content: "two" }, "done", "Created two.ts"),
    ], 20);
    const merged = mergeCodeChangeStates(base, next);
    expect(merged?.files.map((file) => file.path)).toEqual(["one.ts", "two.ts"]);
    expect(merged?.startedAt).toBe(10);
  });
});
