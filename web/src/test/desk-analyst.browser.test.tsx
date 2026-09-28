import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { vi } from "vitest";

import "@/index.css";

vi.mock("@/lib/backend", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/backend")>();
  return { ...actual, authedFetch: vi.fn() };
});

import { DeskAnalystSection } from "@/components/gera/DeskAnalystSection";
import { DeskInsightsSection } from "@/components/gera/DeskInsightsSection";
import { authedFetch } from "@/lib/backend";
import type { DeskTimelinePoint } from "@/lib/projects";
import { TID } from "@/lib/testids";

const MIN = 60 * 1000;

function wrap(node: React.ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {node}
    </QueryClientProvider>
  );
}

test("insights show the SLA split and the busiest weekday/hour slot in the viewer's zone", async () => {
  const monday14 = new Date(2026, 8, 21, 14, 0).getTime();
  const timeline: DeskTimelinePoint[] = [
    { at: monday14, adminId: "a", conversationId: "c1", responseMs: 2 * MIN, grade: "good" },
    { at: monday14 + 10 * MIN, adminId: "a", conversationId: "c2", responseMs: 3 * MIN, grade: "good" },
    { at: monday14 + 20 * MIN, adminId: "a", conversationId: "c3", responseMs: 5 * 60 * MIN, grade: "bad" },
    { at: monday14 + 30 * MIN, adminId: "a", conversationId: "c4", responseMs: 0, grade: "" },
  ];
  await render(wrap(<DeskInsightsSection timeline={timeline} />));
  const block = page.getByTestId(TID.screenDeskInsights);
  await expect.element(block).toBeVisible();
  await expect.element(block.getByText("3 timed replies")).toBeVisible();
  await expect.element(block.getByText("67%", { exact: true })).toBeVisible();
  await expect.element(block.getByText("Peaks: Mon 14:00 (4)")).toBeVisible();
});

test("analyst: a preset sends the question with history and renders the answer with its model", async () => {
  const fetchMock = vi.mocked(authedFetch);
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          answer: "## Summary\n\nAnna needs coaching: **3 of 5** replies graded bad.",
          modelId: "anthropic/claude-opus-5.5",
          basis: { replies: 5, graded: 5, transcripts: 2, scope: "team" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  await render(wrap(<DeskAnalystSection projectId="p1" screenId="s1" range={{ from: 1, to: 2 }} />));
  await expect.element(page.getByTestId(TID.screenDeskAnalyst)).toBeVisible();
  await expect.element(page.getByText("Opus · xhigh")).toBeVisible();

  await page.getByRole("button", { name: "Who needs coaching" }).click();
  const answer = page.getByTestId(TID.screenDeskAnalystAnswer);
  await expect.element(answer).toBeVisible();
  await expect.element(answer.getByText("Anna needs coaching:", { exact: false })).toBeVisible();
  await expect.element(answer.getByText("anthropic/claude-opus-5.5 · xhigh", { exact: false })).toBeVisible();
  const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { history: unknown[]; from: number };
  expect(first.history).toEqual([]);
  expect(first.from).toBe(1);

  // Follow-up carries the previous turn pair.
  await page.getByTestId(TID.screenDeskAnalystInput).fill("И что делать?");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect.poll(() => fetchMock.mock.calls.length).toBe(2);
  const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
    question: string;
    history: Array<{ role: string }>;
  };
  expect(second.question).toBe("И что делать?");
  expect(second.history.map((turn) => turn.role)).toEqual(["user", "assistant"]);
});

test("analyst: a server error is shown honestly and the question returns to the input", async () => {
  const fetchMock = vi.mocked(authedFetch);
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: "analyst_failed", message: "Gateway returned 401" }), { status: 502 }),
  );
  await render(wrap(<DeskAnalystSection projectId="p1" screenId="s1" range={{ from: 0, to: 0 }} />));
  await page.getByTestId(TID.screenDeskAnalystInput).fill("Why?");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect.element(page.getByText("Gateway returned 401")).toBeVisible();
  await expect.element(page.getByTestId(TID.screenDeskAnalystInput)).toHaveValue("Why?");
});
