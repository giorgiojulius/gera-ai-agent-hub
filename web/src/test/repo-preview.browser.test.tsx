import { page } from "vitest/browser";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RepoPreviewCard, RepoPreviewReceipt } from "@/components/gera/RepoPreviewFlow";
import { RepoPreviewPanelView } from "@/components/gera/RepoPreviewPanel";
import type { LiveRepoPreview } from "@/hooks/use-repo-preview-job";
import { PreviewPopupRegistry } from "@/lib/preview-bridge";
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

  // A `target="_blank"` link to another origin → a real browser tab from Gera's trusted document, never an in-panel frame.
  postFromFrame(rootFrame, { source: "gera-preview", type: "open", url: "https://github.com/login/oauth/authorize?client_id=1", target: "_blank" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(openSpy).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?client_id=1", "_blank");
  expect(frames()).toHaveLength(2);

  // A `window.open` from the app (OAuth popup) → a proxied real window carrying the app's placement hints minus opener-severing tokens.
  postFromFrame(rootFrame, {
    source: "gera-preview",
    type: "open",
    url: "https://auth.rork.app/oauth/start?state=1",
    target: "_blank",
    id: "w1",
    features: "width=500,height=650,noopener",
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(openSpy).toHaveBeenCalledWith("https://auth.rork.app/oauth/start?state=1", "_blank", "width=500,height=650");
  expect(frames()).toHaveLength(2);

  // Same backend origin outside the artifact root is folded back into the sandboxed namespace, never opened raw.
  postFromFrame(rootFrame, { source: "gera-preview", type: "open", url: "https://preview.example/mcp/oauth/callback", target: "_blank" });
  await expect.element(page.getByTestId(TID.repoPreviewAddress)).toHaveTextContent("/mcp/oauth/callback");
  expect(openSpy).toHaveBeenCalledTimes(2);
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

async function mountFrame(title: string): Promise<HTMLIFrameElement> {
  const frame = document.createElement("iframe");
  frame.srcdoc = `<!doctype html><title>${title}</title>`;
  document.body.appendChild(frame);
  await new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
  return frame;
}

test("the popup registry plays opener for the preview: callbacks are relayed in, closing is reported, foreign windows are ignored", async () => {
  // Same-origin stand-ins so the test can listen on both ends: the preview frame and the real popup window.
  const frame = await mountFrame("preview");
  const popupHost = await mountFrame("popup");
  const popupWin = popupHost.contentWindow as Window;
  const frameInbox: unknown[] = [];
  (frame.contentWindow as Window).addEventListener("message", (event) => frameInbox.push(event.data));
  const popupInbox: unknown[] = [];
  popupWin.addEventListener("message", (event) => popupInbox.push(event.data));
  const openSpy = vi.spyOn(window, "open").mockReturnValue(popupWin);

  const registry = new PreviewPopupRegistry(() => frame, 20);
  expect(registry.open("root", "w1", "https://auth.rork.app/oauth/start", "popup,width=500")).toBe(true);
  expect(openSpy).toHaveBeenCalledWith("https://auth.rork.app/oauth/start", "_blank", "popup,width=500");
  expect(registry.size).toBe(1);

  // Only windows the registry opened are relayed — and only into the frame that asked for them.
  expect(registry.relay(new MessageEvent("message", { data: { type: "rork_auth_callback", code: "nope" }, origin: "https://evil.example", source: window }))).toBe(false);
  expect(
    registry.relay(new MessageEvent("message", { data: { type: "rork_auth_callback", code: "abc" }, origin: "https://auth.rork.app", source: popupWin })),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(frameInbox).toContainEqual({
      source: "gera-preview-host",
      type: "message",
      id: "w1",
      origin: "https://auth.rork.app",
      data: { type: "rork_auth_callback", code: "abc" },
    }),
  );

  // The preview's `popup.postMessage` reaches the real window.
  registry.send("root", "w1", { hello: "popup" }, "*");
  await vi.waitFor(() => expect(popupInbox).toContainEqual({ hello: "popup" }));

  // The user closes the window: within one poll the frame hears `closed` and tracking is dropped.
  popupHost.remove();
  await vi.waitFor(() => expect(frameInbox).toContainEqual({ source: "gera-preview-host", type: "closed", id: "w1" }));
  expect(registry.size).toBe(0);

  registry.dispose();
  frame.remove();
});
