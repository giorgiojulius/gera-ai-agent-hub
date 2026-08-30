import { describe, expect, it } from "vitest";

import {
  COST_WEIGHT,
  ELO_START,
  computeStandings,
  estimateAnswerCost,
  estimateMediaCost,
  estimateUsageRowCost,
  expectedScore,
  type ArenaBattle,
} from "@/lib/arena";
import type { GatewayModel, ModelPricing } from "@/lib/types";

function model(pricing?: ModelPricing): GatewayModel {
  return { id: "test/model", name: "Test model", owned_by: "test", type: "language", pricing };
}

let seq = 0;

function battle(partial: Partial<ArenaBattle>): ArenaBattle {
  seq += 1;
  return {
    id: `b${seq}`,
    voter: "tester@example.com",
    winnerId: "model/a",
    loserId: "model/b",
    draw: false,
    prompt: "test prompt",
    createdAt: seq * 1000,
    ...partial,
  };
}

describe("expectedScore", () => {
  it("gives even odds at equal ratings", () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5);
  });

  it("favors the higher rating", () => {
    expect(expectedScore(1200, 1000)).toBeCloseTo(0.7597, 3);
  });
});

describe("computeStandings", () => {
  it("moves 16 points symmetrically on the first even battle (K=32)", () => {
    const standings = computeStandings([battle({})]);
    const a = standings.find((row) => row.modelId === "model/a");
    const b = standings.find((row) => row.modelId === "model/b");
    expect(a?.rating).toBe(ELO_START + 16);
    expect(b?.rating).toBe(ELO_START - 16);
    expect(a?.wins).toBe(1);
    expect(a?.games).toBe(1);
    expect(b?.losses).toBe(1);
    expect(standings[0]?.modelId).toBe("model/a");
  });

  it("keeps a fresh draw at even ratings and counts it for both", () => {
    const standings = computeStandings([battle({ draw: true })]);
    const a = standings.find((row) => row.modelId === "model/a");
    const b = standings.find((row) => row.modelId === "model/b");
    expect(a?.rating).toBe(ELO_START);
    expect(b?.rating).toBe(ELO_START);
    expect(a?.draws).toBe(1);
    expect(b?.draws).toBe(1);
    expect(a?.wins).toBe(0);
    expect(b?.losses).toBe(0);
  });

  it("replays chronologically no matter the input order", () => {
    const first = battle({ winnerId: "model/a", loserId: "model/b", createdAt: 1000 });
    const second = battle({ winnerId: "model/b", loserId: "model/a", createdAt: 2000 });
    const sorted = computeStandings([first, second]);
    const shuffled = computeStandings([second, first]);
    expect(shuffled).toEqual(sorted);
    // After the comeback the underdog gains slightly more than 16.
    const b = sorted.find((row) => row.modelId === "model/b");
    const a = sorted.find((row) => row.modelId === "model/a");
    expect(b?.rating).toBe(1001);
    expect(a?.rating).toBe(999);
  });

  it("ignores self-battles instead of corrupting ratings", () => {
    const standings = computeStandings([battle({ winnerId: "model/a", loserId: "model/a" })]);
    expect(standings).toHaveLength(0);
  });

  it("discounts Value by cost: each doubling costs COST_WEIGHT points", () => {
    const standings = computeStandings([
      battle({ winnerId: "model/a", loserId: "model/c", winnerCost: 0.01 }),
      battle({ winnerId: "model/b", loserId: "model/d", winnerCost: 0.32 }),
    ]);
    const a = standings.find((row) => row.modelId === "model/a");
    const b = standings.find((row) => row.modelId === "model/b");
    expect(a?.rating).toBe(1016);
    expect(b?.rating).toBe(1016);
    expect(a?.hasCost).toBe(true);
    expect(b?.hasCost).toBe(true);
    // 0.32 / 0.01 = 32 = 2^5 → five doublings.
    expect(a?.value).toBe(1016);
    expect(b?.value).toBe(1016 - COST_WEIGHT * 5);
  });

  it("leaves Value = rating when a model has no cost data", () => {
    const standings = computeStandings([
      battle({ winnerId: "model/a", loserId: "model/c", winnerCost: 0.01 }),
    ]);
    const c = standings.find((row) => row.modelId === "model/c");
    expect(c?.hasCost).toBe(false);
    expect(c?.value).toBe(c?.rating);
  });

  it("averages cost only over metered answers", () => {
    const standings = computeStandings([
      battle({ winnerId: "model/a", loserId: "model/b", winnerCost: 0.1 }),
      battle({ winnerId: "model/a", loserId: "model/b", winnerCost: 0.3 }),
      battle({ winnerId: "model/a", loserId: "model/b" }),
    ]);
    const a = standings.find((row) => row.modelId === "model/a");
    expect(a?.costedAnswers).toBe(2);
    expect(a?.avgCost).toBeCloseTo(0.2);
  });
});

describe("estimateAnswerCost", () => {
  it("prices prompt and completion at list rates", () => {
    const cost = estimateAnswerCost(model({ input: 0.000002, output: 0.00001 }), {
      prompt: 1000,
      completion: 500,
      calls: 1,
    });
    expect(cost).toBeCloseTo(1000 * 0.000002 + 500 * 0.00001, 10);
  });

  it("bills provider-cached prompt tokens at the cache-read rate", () => {
    const pricing: ModelPricing = { input: 0.000002, output: 0.00001, inputCacheRead: 0.0000002 };
    const cost = estimateAnswerCost(model(pricing), { prompt: 1000, completion: 0, calls: 1, cached: 800 });
    // 200 fresh at full rate + 800 cached at a tenth.
    expect(cost).toBeCloseTo(200 * 0.000002 + 800 * 0.0000002, 12);
  });

  it("falls back to the full input rate when no cache-read rate is listed", () => {
    const withCache = estimateAnswerCost(model({ input: 0.000002, output: 0.00001 }), {
      prompt: 1000,
      completion: 0,
      calls: 1,
      cached: 800,
    });
    const without = estimateAnswerCost(model({ input: 0.000002, output: 0.00001 }), {
      prompt: 1000,
      completion: 0,
      calls: 1,
    });
    expect(withCache).toBeCloseTo(without ?? -1, 12);
  });

  it("returns undefined without token rates", () => {
    expect(estimateAnswerCost(model({ image: 0.04 }), { prompt: 10, completion: 10, calls: 1 })).toBeUndefined();
    expect(estimateAnswerCost(undefined, { prompt: 10, completion: 10, calls: 1 })).toBeUndefined();
  });
});

describe("estimateMediaCost", () => {
  it("prices images per asset, video per second and TTS per character", () => {
    expect(estimateMediaCost(model({ image: 0.04 }), { images: 3 })).toBeCloseTo(0.12);
    expect(estimateMediaCost(model({ videoPerSecond: 0.15 }), { videoSeconds: 6 })).toBeCloseTo(0.9);
    expect(estimateMediaCost(model({ speechChar: 0.00003 }), { speechChars: 500 })).toBeCloseTo(0.015);
  });

  it("is honest about missing rates", () => {
    expect(estimateMediaCost(model({}), { images: 3 })).toBeUndefined();
    expect(estimateMediaCost(undefined, { images: 3 })).toBeUndefined();
  });
});

describe("estimateUsageRowCost", () => {
  it("prices image rows by units, not tokens", () => {
    const cost = estimateUsageRowCost(
      model({ image: 0.05 }),
      { runs: 2, promptTokens: 0, completionTokens: 0, units: 4 },
      "image",
    );
    expect(cost).toBeCloseTo(0.2);
  });

  it("returns undefined for media rows without metered units (pre-units history)", () => {
    expect(
      estimateUsageRowCost(model({ image: 0.05 }), { runs: 2, promptTokens: 0, completionTokens: 0, units: 0 }, "image"),
    ).toBeUndefined();
  });

  it("prices chat and service rows by tokens", () => {
    const row = { runs: 3, promptTokens: 1000, completionTokens: 200, units: 0 };
    const expected = 1000 * 0.000002 + 200 * 0.00001;
    expect(estimateUsageRowCost(model({ input: 0.000002, output: 0.00001 }), row, "chat")).toBeCloseTo(expected, 10);
    expect(estimateUsageRowCost(model({ input: 0.000002, output: 0.00001 }), row, "service")).toBeCloseTo(expected, 10);
  });

  it("returns undefined for token rows with nothing metered", () => {
    expect(
      estimateUsageRowCost(
        model({ input: 0.000002, output: 0.00001 }),
        { runs: 5, promptTokens: 0, completionTokens: 0, units: 0 },
        "chat",
      ),
    ).toBeUndefined();
  });
});
