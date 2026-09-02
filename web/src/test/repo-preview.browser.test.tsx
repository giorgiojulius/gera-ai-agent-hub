import { page } from "vitest/browser";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RepoPreviewCard, RepoPreviewReceipt } from "@/components/gera/RepoPreviewFlow";
import { RepoPreviewPanelView } from "@/components/gera/RepoPreviewPanel";
import type { LiveRepoPreview } from "@/hooks/use-repo-preview-job";
import { TID } from "@/lib/testids";
import type { RepoPreviewJob } from "@/lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

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

const live: LiveRepoPreview = {
  job,
  isRefreshing: false,
  statusUnavailable: false,
  actionBusy: false,
  refresh: () => undefined,
  cancel: () => undefined,
  rebuild: () => undefined,
};

function frames(): HTMLIFrameElement[] {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>(`iframe[data-testid="${TID.repoPreviewFrame}"]`));
}

/** Replays what the served preview's shim posts, from a given frame's window. */
function postFromFrame(frame: HTMLIFrameElement | Window, data: Record<string, unknown>) {
  const source = frame instanceof HTMLIFrameElement ? frame.contentWindow : frame;
  window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source }));
}

test("the dock turns in-preview popups into tabs and sends other sites to a real browser tab", async () => {
  const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
  const screen = await render(<RepoPreviewPanelView live={live} onClose={() => undefined} />);
  const previewUrl = job.previewUrl ?? "";

  const panel = page.getByTestId(TID.repoPreviewPanel);
  await expect.element(panel).toBeVisible();
  expect(screen.container.querySelector(`[data-testid="${TID.repoPreviewTabs}"]`)).toBeNull();
  await expect.element(page.getByTestId(TID.repoPreviewAddress)).toHaveTextContent("preview.example");

  const [rootFrame] = frames();
  expect(rootFrame).toBeDefined();

  // A foreign window (not one of the dock's frames) must never be able to open tabs.
  postFromFrame(window, { source: "gera-preview", type: "open", url: `${previewUrl}evil`, target: "_blank" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(frames()).toHaveLength(1);

  // Same artifact root → new tab in the panel, focused, with the address bar following it.
  postFromFrame(rootFrame, { source: "gera-preview", type: "open", url: `${previewUrl}settings?tab=1`, target: "_blank" });
  await expect.element(page.getByTestId(TID.repoPreviewTabs)).toBeVisible();
  await expect.element(page.getByTestId(TID.repoPreviewAddress)).toHaveTextContent("/settings?tab=1");
  expect(frames()).toHaveLength(2);
  const tabs = page.getByTestId(TID.repoPreviewTab);
  await expect.element(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect.element(tabs.nth(1)).toHaveTextContent("/settings?tab=1");
  expect(frames()[1].src).toBe(`${previewUrl}settings?tab=1`);

  // The new page reports its route and title; the tab label and address bar follow.
  postFromFrame(frames()[1], { source: "gera-preview", type: "state", href: `${previewUrl}settings/profile`, title: "Profile · Storefront" });
  await expect.element(tabs.nth(1)).toHaveTextContent("Profile · Storefront");
  await expect.element(page.getByTestId(TID.repoPreviewAddress)).toHaveTextContent("/settings/profile");

  // Another origin (OAuth) → a real browser tab from Gera's trusted document, never an in-panel frame.
  postFromFrame(rootFrame, { source: "gera-preview", type: "open", url: "https://github.com/login/oauth/authorize?client_id=1", target: "_blank" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(openSpy).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?client_id=1", "_blank");
  expect(frames()).toHaveLength(2);

  // Same backend origin outside the artifact root is folded back into the sandboxed namespace, never opened raw.
  postFromFrame(rootFrame, { source: "gera-preview", type: "open", url: "https://preview.example/mcp/oauth/callback", target: "_blank" });
  await expect.element(page.getByTestId(TID.repoPreviewAddress)).toHaveTextContent("/mcp/oauth/callback");
  expect(openSpy).toHaveBeenCalledTimes(1);
  expect(frames()).toHaveLength(3);
  expect(frames()[2].src).toBe(`${previewUrl}mcp/oauth/callback`);

  // Closing the active tab falls back to its left neighbour; closing the last extra tab hides the strip again.
  await page.getByRole("button", { name: "Close /mcp/oauth/callback" }).click();
  await expect.element(page.getByTestId(TID.repoPreviewAddress)).toHaveTextContent("/settings/profile");
  expect(frames()).toHaveLength(2);
  await page.getByRole("button", { name: "Close Profile · Storefront" }).click();
  await expect.element(page.getByTestId(TID.repoPreviewAddress)).not.toHaveTextContent("/settings");
  expect(frames()).toHaveLength(1);
  expect(screen.container.querySelector(`[data-testid="${TID.repoPreviewTabs}"]`)).toBeNull();
});
