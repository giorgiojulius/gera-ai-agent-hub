/**
 * Browser regression for the reply timeline: the commentary a model wrote
 * before calling tools stays where it was said, tool batches sit between the
 * prose segments in reading order, and a long batch folds into one summary row
 * that expands on tap. Legacy replies (records without offsets) keep the old
 * rows-then-text layout.
 */
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MessageList } from "@/components/gera/MessageList";
import { TID } from "@/lib/testids";
import type { ChatMessage, ToolCallRecord } from "@/lib/types";

function call(id: string, name: string, textOffset?: number, status: ToolCallRecord["status"] = "done"): ToolCallRecord {
  return { id, name, arguments: "{}", status, ...(textOffset === undefined ? {} : { textOffset }) };
}

const STEP_ONE = "Checking the failed job logs first.";
const STEP_TWO = "The build step failed on a missing env var; reading the workflow file.";
const FINAL = "Root cause: CI_TOKEN is not set for forks.";
const CONTENT = `${STEP_ONE}\n\n${STEP_TWO}\n\n${FINAL}`;

const LOG_CALLS = Array.from({ length: 8 }, (_, index) =>
  call(`log_${index}`, "mcp_github_get_job_logs", STEP_ONE.length),
);
const FILE_CALL = call("file_1", "mcp_github_get_contents", `${STEP_ONE}\n\n${STEP_TWO}`.length);

const INTERLEAVED: ChatMessage = {
  id: "a1",
  role: "assistant",
  content: CONTENT,
  createdAt: 1,
  toolCalls: [...LOG_CALLS, FILE_CALL],
};

function orderOf(...testIds: string[]): string[] {
  const nodes = [...document.querySelectorAll<HTMLElement>("[data-testid]")];
  return nodes
    .map((node) => node.dataset.testid ?? "")
    .filter((id) => testIds.includes(id));
}

test("tool batches sit between the prose segments they were issued from", async () => {
  await render(<MessageList messages={[INTERLEAVED]} streaming={false} />);

  const bubble = page.getByTestId(TID.messageAssistant);
  await expect.element(bubble).toBeVisible();
  await expect.element(bubble.getByText(STEP_ONE, { exact: true })).toBeVisible();
  await expect.element(bubble.getByText(STEP_TWO, { exact: true })).toBeVisible();
  await expect.element(bubble.getByText(FINAL, { exact: true })).toBeVisible();

  // Reading order: prose → 8-call batch → prose → 1-call batch → prose.
  expect(orderOf(TID.messageText, TID.messageToolGroup)).toEqual([
    TID.messageText,
    TID.messageToolGroup,
    TID.messageText,
    TID.messageToolGroup,
    TID.messageText,
  ]);
});

test("a long batch folds into one summary row and expands on tap", async () => {
  await render(<MessageList messages={[INTERLEAVED]} streaming={false} />);

  const toggle = page.getByTestId(TID.messageToolGroupToggle);
  await expect.element(toggle).toBeVisible();
  await expect.element(toggle.getByText("8 tool calls", { exact: true })).toBeVisible();
  await expect.element(toggle.getByText("mcp_github_get_job_logs ×8", { exact: true })).toBeVisible();
  // Folded: the eight rows are not rendered; the single-call batch still lists its row.
  expect(document.querySelectorAll(`[data-testid="${TID.messageToolCall}"]`)).toHaveLength(1);

  await toggle.click();

  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  expect(document.querySelectorAll(`[data-testid="${TID.messageToolCall}"]`)).toHaveLength(9);
});

test("a running batch names the call in flight; a failed one counts its failures", async () => {
  const running: ChatMessage = {
    id: "a2",
    role: "assistant",
    content: STEP_ONE,
    createdAt: 1,
    toolCalls: [
      call("r1", "web_search", STEP_ONE.length),
      call("r2", "web_search", STEP_ONE.length),
      call("r3", "fetch_url", STEP_ONE.length, "error"),
      call("r4", "fetch_url", STEP_ONE.length, "running"),
    ],
  };
  await render(<MessageList messages={[running]} streaming />);

  const toggle = page.getByTestId(TID.messageToolGroupToggle);
  await expect.element(toggle.getByText("now · fetch_url", { exact: true })).toBeVisible();
  await expect.element(toggle.getByText("running", { exact: true })).toBeVisible();
  // The spinner in the batch is the live indicator — no "thinking" dots stacked under it.
  expect(document.body.textContent).not.toContain("Gera is thinking");

  const failed: ChatMessage = {
    ...running,
    id: "a3",
    toolCalls: running.toolCalls?.map((item) => (item.id === "r4" ? { ...item, status: "done" as const } : item)),
  };
  await render(<MessageList messages={[failed]} streaming={false} />);
  await expect.element(page.getByText("1 failed", { exact: true })).toBeVisible();
});

test("legacy records without offsets keep the rows-then-text layout", async () => {
  const legacy: ChatMessage = {
    id: "a4",
    role: "assistant",
    content: FINAL,
    createdAt: 1,
    toolCalls: [call("l1", "web_search"), call("l2", "fetch_url")],
  };
  await render(<MessageList messages={[legacy]} streaming={false} />);

  expect(orderOf(TID.messageText, TID.messageToolGroup)).toEqual([TID.messageToolGroup, TID.messageText]);
  // Two calls: listed as rows, no fold toggle.
  expect(document.querySelectorAll(`[data-testid="${TID.messageToolCall}"]`)).toHaveLength(2);
  expect(document.querySelectorAll(`[data-testid="${TID.messageToolGroupToggle}"]`)).toHaveLength(0);
});
