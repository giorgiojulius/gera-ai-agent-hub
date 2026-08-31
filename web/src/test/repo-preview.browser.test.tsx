import { page } from "vitest/browser";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { RepoPreviewCard } from "@/components/gera/RepoPreviewFlow";
import { TID } from "@/lib/testids";
import type { RepoPreviewJob } from "@/lib/types";

const now = Date.now();
const job: RepoPreviewJob = {
  id: `${"a".repeat(24)}.${"b".repeat(32)}.${"d".repeat(24)}`,
  repository: "acme/storefront",
  ref: "main",
  commitSha: "c".repeat(40),
  rootDirectory: "apps/web",
  framework: "vite",
  packageManager: "bun",
  phase: "ready",
  createdAt: now,
  updatedAt: now,
  expiresAt: now + 24 * 60 * 60_000,
  previewUrl: `https://preview.example/repo-preview/${"a".repeat(24)}.${"b".repeat(32)}.${"d".repeat(24)}/`,
  actionsUrl: "https://github.com/acme/storefront/actions/runs/42",
  logs: "Installed 312 packages\nBuilt in 1.8s\nPackaged 28 files",
};

test("repository launch receipt shows a real preview and bounded build evidence", async () => {
  render(<RepoPreviewCard job={job} readOnly />);

  await expect.element(page.getByTestId(TID.repoPreviewFlow)).toHaveTextContent("Preview running");
  await expect.element(page.getByTestId(TID.repoPreviewFlow)).toHaveTextContent("acme/storefront");
  await expect.element(page.getByTestId(TID.repoPreviewFrame)).toBeVisible();

  await page.getByTestId(TID.repoPreviewLogs).click();
  await expect.element(page.getByTestId(TID.repoPreviewFlow)).toHaveTextContent("Packaged 28 files");
});
