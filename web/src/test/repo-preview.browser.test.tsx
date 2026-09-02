import { page } from "vitest/browser";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { RepoPreviewCard, RepoPreviewReceipt } from "@/components/gera/RepoPreviewFlow";
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

test("docked receipt stays compact, never embeds the frame, and focuses the dock on click", async () => {
  let opened = 0;
  const screen = await render(<RepoPreviewReceipt job={job} active={false} onOpen={() => { opened += 1; }} />);

  const receipt = page.getByTestId(TID.repoPreviewFlow);
  await expect.element(receipt).toHaveTextContent("Preview running");
  await expect.element(receipt).toHaveTextContent("acme/storefront");
  await expect.element(receipt).toHaveTextContent("Open");
  await expect.element(receipt).toHaveAttribute("aria-pressed", "false");
  expect(screen.container.querySelector(`[data-testid="${TID.repoPreviewFrame}"]`)).toBeNull();

  await receipt.click();
  expect(opened).toBe(1);

  await screen.rerender(<RepoPreviewReceipt job={job} active onOpen={() => { opened += 1; }} />);
  await expect.element(receipt).toHaveAttribute("aria-pressed", "true");
  await expect.element(receipt).toHaveTextContent("In panel");
});
