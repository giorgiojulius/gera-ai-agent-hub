import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { DeskTrendSection } from "@/components/gera/DeskTrendSection";
import { TeammateTrend } from "@/components/gera/TeammateTrend";
import type { DeskTimelinePoint } from "@/lib/projects";
import { TID } from "@/lib/testids";

const HOUR = 60 * 60 * 1000;

function localDay(day: number, hour = 12): number {
  return new Date(2026, 8, day, hour).getTime();
}

function point(at: number, extra: Partial<DeskTimelinePoint>): DeskTimelinePoint {
  return { at, adminId: "anna", conversationId: `c${at}-${extra.adminId ?? "anna"}`, responseMs: 10 * 60 * 1000, grade: "", ...extra };
}

const RANGE = { from: localDay(8, 0), to: localDay(14, 23) };
const NOW = localDay(14, 23);

/** Anna improves quality three days in a row; Boris is flat; previous week has data for both. */
const TIMELINE: DeskTimelinePoint[] = [
  point(localDay(1), { adminId: "anna", grade: "bad", responseMs: 2 * HOUR }),
  point(localDay(3), { adminId: "anna", grade: "good", responseMs: 2 * HOUR }),
  point(localDay(2), { adminId: "boris", grade: "good", responseMs: 15 * 60 * 1000 }),
  point(localDay(9), { adminId: "anna", grade: "bad", responseMs: 40 * 60 * 1000 }),
  point(localDay(10), { adminId: "anna", grade: "good", responseMs: 30 * 60 * 1000 }),
  point(localDay(10, 14), { adminId: "anna", grade: "bad", responseMs: 30 * 60 * 1000 }),
  point(localDay(11), { adminId: "anna", grade: "good", responseMs: 20 * 60 * 1000 }),
  point(localDay(11, 14), { adminId: "anna", grade: "good", responseMs: 20 * 60 * 1000 }),
  point(localDay(11, 15), { adminId: "anna", grade: "bad", responseMs: 20 * 60 * 1000 }),
  point(localDay(12), { adminId: "anna", grade: "good", responseMs: 20 * 60 * 1000 }),
  point(localDay(9), { adminId: "boris", grade: "good", responseMs: 15 * 60 * 1000 }),
  point(localDay(12), { adminId: "boris", grade: "good", responseMs: 15 * 60 * 1000 }),
];

test("teammate dynamics: verdict, metric tabs and previous-period comparison follow the teammate's own data", async () => {
  await render(<TeammateTrend adminId="anna" timeline={TIMELINE} range={RANGE} now={NOW} />);

  const block = page.getByTestId(TID.screenDeskTeammateTrend);
  await expect.element(block).toBeVisible();
  await expect.element(page.getByTestId(`${TID.screenDeskTeammateTrend}-verdict`)).toHaveTextContent(
    "Quality rising 3 days in a row.",
  );
  // Anna in the current week: 7 replies, 4 good / 3 bad = 57%, median 20m; previous week 2 replies, 50%, 2h.
  await expect.element(block.getByText("7", { exact: true })).toBeVisible();
  await expect.element(block.getByText("57%", { exact: true })).toBeVisible();
  await expect.element(block.getByText("20m", { exact: true }).first()).toBeVisible();
  await expect.element(block.getByText("+250%", { exact: true })).toBeVisible();
  await expect.element(block.getByText("+7 pts", { exact: true })).toBeVisible();
  await expect.element(block.getByText("-83%", { exact: true })).toBeVisible();

  // Medians 40m -> 30m -> 20m -> 20m: the last day is flat, so the verdict compares it with the earlier mean.
  await page.getByTestId(`${TID.screenDeskTeammateTrend}-response`).click();
  await expect.element(page.getByTestId(`${TID.screenDeskTeammateTrend}-verdict`)).toHaveTextContent(
    "Latest day: reply time faster than before (20m vs 30m before).",
  );

  await page.getByTestId(`${TID.screenDeskTeammateTrend}-replies`).click();
  await expect.element(page.getByTestId(`${TID.screenDeskTeammateTrend}-verdict`)).toHaveTextContent(
    "Latest day: volume below the earlier level (1 vs 2 before).",
  );
});

test("team trend ranks who moved most for admins and hides the ranking for a single visible teammate", async () => {
  const screen = await render(
    <DeskTrendSection
      timeline={TIMELINE}
      range={RANGE}
      now={NOW}
      teammates={[
        { adminId: "boris", name: "Boris" },
        { adminId: "anna", name: "Anna" },
      ]}
    />,
  );

  const shifts = page.getByTestId(TID.screenDeskPerformanceShifts);
  await expect.element(shifts).toBeVisible();
  const rows = shifts.getByText(/^(Anna|Boris)$/);
  await expect.element(rows.nth(0)).toHaveTextContent("Anna");
  await expect.element(rows.nth(1)).toHaveTextContent("Boris");

  await screen.rerender(
    <DeskTrendSection timeline={TIMELINE.filter((p) => p.adminId === "anna")} range={RANGE} now={NOW} teammates={[]} />,
  );
  await expect.element(page.getByTestId(TID.screenDeskPerformanceTrend)).toBeVisible();
  expect(document.querySelector(`[data-testid="${TID.screenDeskPerformanceShifts}"]`)).toBeNull();
});
