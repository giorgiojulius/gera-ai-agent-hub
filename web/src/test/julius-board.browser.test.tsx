/**
 * Browser regression for the Council v2 board inside the Julius panel: the
 * backbone pick with per-candidate probabilities, quality grades, the
 * keep / fix / drop tally, and the per-block rulings behind the toggle.
 */
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { JuliusPanel } from "@/components/gera/JuliusPanel";
import { TID } from "@/lib/testids";
import type { JuliusState } from "@/lib/types";

vi.mock("@/hooks/use-agent", () => ({
  useAgent: () => ({ models: [], chooseJuliusWinner: () => undefined }),
}));

const JULIUS: JuliusState = {
  decision: "council_v2",
  status: "done",
  startedAt: 1_000,
  finishedAt: 61_000,
  winner: 1,
  decidedBy: "jev",
  chairmanModelId: "test/chairman",
  candidates: [
    { id: "c0", modelId: "test/alpha", content: "Alpha says twelve.", status: "done" },
    { id: "c1", modelId: "test/beta", content: "Beta says fourteen.", status: "done" },
  ],
  reviews: [{ role: "verifier", modelId: "test/verifier", content: "✗ twelve is wrong; it is fourteen.", status: "done" }],
  board: {
    modelId: "typesafe-ai/jev",
    status: "done",
    backbone: { winner: 1, probabilities: [0.25, 0.75], confidence: 0.75 },
    quality: [
      { candidate: 0, score: 1.1, level: "usable with caveats", confidence: 0.62 },
      { candidate: 1, score: 2.7, level: "excellent", confidence: 0.71 },
    ],
    blocks: [
      { id: "A1", candidate: 0, excerpt: "Alpha says twelve.", chars: 18, decision: "drop_wrong", probability: 0.88 },
      { id: "A2", candidate: 0, excerpt: "Alpha adds context.", chars: 19, decision: "keep", probability: 0.8 },
      { id: "B1", candidate: 1, excerpt: "Beta says fourteen.", chars: 19, decision: "keep", probability: 0.93 },
      { id: "B2", candidate: 1, excerpt: "Beta's stale date.", chars: 18, decision: "fix", probability: 0.77 },
    ],
    inputTokens: 2_100,
    elapsedMs: 1_800,
  },
};

test("the board shows Jev's backbone pick, quality grades and the block tally; rulings expand on tap", async () => {
  await render(<JuliusPanel julius={JULIUS} messageId="m1" />);

  // Header names the backbone and who decided; a settled multi-candidate panel starts folded.
  const header = page.getByText("Backbone: B · test/beta · Jev's ruling", { exact: true });
  await expect.element(header).toBeVisible();
  await header.click();

  const board = page.getByTestId(TID.juliusBoard);
  await expect.element(board).toBeVisible();
  await expect.element(board.getByText("Jev’s board", { exact: true })).toBeVisible();
  await expect.element(board.getByText("75%", { exact: true })).toBeVisible();
  await expect.element(board.getByText("25%", { exact: true })).toBeVisible();
  await expect.element(board.getByText("2,100 tokens in · 0 out · 1.8s", { exact: true })).toBeVisible();
  await expect.element(board.getByText("usable with caveats")).toBeVisible();
  await expect.element(board.getByText("excellent")).toBeVisible();
  await expect.element(board.getByText("2 keep", { exact: true })).toBeVisible();
  await expect.element(board.getByText("1 fix", { exact: true })).toBeVisible();
  await expect.element(board.getByText("1 drop · wrong", { exact: true })).toBeVisible();

  // Folded by default; the four rulings appear on tap with their decisions.
  expect(document.querySelectorAll(`[data-testid="${TID.juliusBoardBlock}"]`)).toHaveLength(0);
  await page.getByTestId(TID.juliusBoardToggle).click();
  await expect.element(page.getByTestId(TID.juliusBoardToggle)).toHaveAttribute("aria-expanded", "true");
  const rows = [...document.querySelectorAll<HTMLElement>(`[data-testid="${TID.juliusBoardBlock}"]`)];
  expect(rows.map((row) => row.dataset.decision)).toEqual(["drop_wrong", "keep", "keep", "fix"]);
  await expect.element(board.getByText("Alpha says twelve.", { exact: true })).toBeVisible();
  await expect.element(board.getByText("drop · wrong 88%", { exact: true })).toBeVisible();
});

test("a board that failed shows the reason instead of pretending Jev ruled", async () => {
  const failed: JuliusState = {
    ...JULIUS,
    status: "choice",
    winner: undefined,
    decidedBy: undefined,
    verdict: "Jev could not rule (gateway 400: model not available) — pick the winner yourself.",
    board: { modelId: "typesafe-ai/jev", status: "error", error: "gateway 400: model not available", quality: [], blocks: [] },
  };
  await render(<JuliusPanel julius={failed} messageId="m2" />);
  const board = page.getByTestId(TID.juliusBoard);
  await expect.element(board.getByText("gateway 400: model not available", { exact: true })).toBeVisible();
  const verdict = page.getByTestId(TID.juliusVerdict);
  await expect.element(verdict).toHaveTextContent(/Editor/);
  await expect.element(verdict).toHaveTextContent(/pick the winner yourself/);
  await expect.element(page.getByText("Use this answer", { exact: true }).first()).toBeVisible();
});
