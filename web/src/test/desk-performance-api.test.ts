import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/backend")>();
  return { ...actual, authedFetch: vi.fn() };
});

import { authedFetch } from "@/lib/backend";
import { askDeskAnalyst, clearDeskStats, fetchDeskStats, refreshDeskStats } from "@/lib/projects";

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

  it("asks the analyst with range, history and the viewer's timezone", async () => {
    authedFetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            answer: "Anna needs coaching.",
            modelId: "anthropic/claude-opus-5.5",
            basis: { replies: 10, graded: 8, transcripts: 2, scope: "team" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const result = await askDeskAnalyst("p1", {
      screenId: "s1",
      question: "Who needs coaching?",
      history: [{ role: "user", content: "Hi" }],
      range: { from: 100, to: 200 },
    });
    expect(result.answer).toBe("Anna needs coaching.");
    const [path, init] = authedFetchMock.mock.calls[0];
    expect(path).toBe("/projects/p1/intercom/stats/ask");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      screenId: "s1",
      question: "Who needs coaching?",
      history: [{ role: "user", content: "Hi" }],
      from: 100,
      to: 200,
    });
    expect(typeof body.tzOffsetMinutes).toBe("number");
  });

  it("surfaces the server's honest analyst error message", async () => {
    authedFetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: "no_data", message: "No replies collected for this range yet" }), {
          status: 409,
        }),
    );
    await expect(
      askDeskAnalyst("p1", { screenId: "s1", question: "x", history: [], range: { from: 0, to: 0 } }),
    ).rejects.toThrow("No replies collected for this range yet");
  });
});
