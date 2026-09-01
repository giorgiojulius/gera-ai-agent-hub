import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/backend")>();
  return { ...actual, authedFetch: vi.fn() };
});

import { authedFetch } from "@/lib/backend";
import { clearDeskStats, fetchDeskStats, refreshDeskStats } from "@/lib/projects";

const authedFetchMock = vi.mocked(authedFetch);
const emptyStats = {
  isAdmin: true,
  teammates: [],
  totalReplies: 0,
  conversations: 0,
  gradedReplies: 0,
  badReplies: 0,
  responseSamples: 0,
  withinOneHour: 0,
  p90ResponseMs: 0,
  ungraded: 0,
  range: { from: 100, to: 200 },
  coverage: null,
  now: 200,
};

function okResponse(): Response {
  return new Response(JSON.stringify(emptyStats), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("desk performance API", () => {
  beforeEach(() => {
    authedFetchMock.mockReset();
    authedFetchMock.mockImplementation(async () => okResponse());
  });

  it("carries the exact date range through reads and deep refreshes", async () => {
    await fetchDeskStats("p1", "s1", { from: 100, to: 200 });
    await refreshDeskStats("p1", "s1", { from: 100, to: 200 });

    expect(authedFetchMock).toHaveBeenNthCalledWith(
      1,
      "/projects/p1/intercom/stats",
      expect.objectContaining({ body: JSON.stringify({ screenId: "s1", from: 100, to: 200 }) }),
    );
    expect(authedFetchMock).toHaveBeenNthCalledWith(
      2,
      "/projects/p1/intercom/stats/refresh",
      expect.objectContaining({ body: JSON.stringify({ screenId: "s1", from: 100, to: 200 }) }),
    );
  });

  it("uses the dedicated destructive endpoint to clear current results", async () => {
    await clearDeskStats("p1", "s1", { from: 100, to: 200 });

    expect(authedFetchMock).toHaveBeenCalledWith(
      "/projects/p1/intercom/stats/clear",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ screenId: "s1", from: 100, to: 200 }) }),
    );
  });
});
