import { describe, expect, it } from "vitest";

import { mergeUsageStats, splitUsageStats, type UsageStat } from "@/lib/arena";
import { turnUsageEvents } from "@/lib/telemetry";

describe("turnUsageEvents", () => {
  it("maps each metered model to one event", () => {
    const events = turnUsageEvents({
      usage: {
        prompt: 12,
        completion: 30,
        calls: 3,
        byModel: {
          "openai/gpt-5.2": { prompt: 10, completion: 20, calls: 2 },
          "xai/grok-4.6": { prompt: 2, completion: 10, calls: 1 },
        },
      },
      mode: "chat",
      fallbackModelId: "openai/gpt-5.2",
      ok: true,
    });
    expect(events).toHaveLength(2);
    expect(events).toContainEqual({
      modelId: "openai/gpt-5.2",
      mode: "chat",
      ok: true,
      promptTokens: 10,
      completionTokens: 20,
    });
    expect(events).toContainEqual({
      modelId: "xai/grok-4.6",
      mode: "chat",
      ok: true,
      promptTokens: 2,
      completionTokens: 10,
    });
  });

  it("falls back to a single zero-token event when nothing was metered", () => {
    const events = turnUsageEvents({
      usage: undefined,
      mode: "image",
      fallbackModelId: "openai/gpt-image-1",
      ok: false,
    });
    expect(events).toEqual([
      { modelId: "openai/gpt-image-1", mode: "image", ok: false, promptTokens: 0, completionTokens: 0 },
    ]);
  });

  it("returns nothing when there is no usage and no fallback", () => {
    expect(turnUsageEvents({ usage: undefined, mode: "chat", fallbackModelId: "", ok: true })).toEqual([]);
  });

  it("reports helper calls as mode service — never as chat adoption", () => {
    const events = turnUsageEvents({
      usage: {
        prompt: 110,
        completion: 25,
        calls: 2,
        byModel: { "spacexai/grok-4.6": { prompt: 100, completion: 20, calls: 1 } },
        serviceByModel: { "alibaba/qwen3.7-flash": { prompt: 10, completion: 5, calls: 1 } },
      },
      mode: "chat",
      fallbackModelId: "spacexai/grok-4.6",
      ok: true,
    });
    expect(events).toContainEqual({
      modelId: "spacexai/grok-4.6",
      mode: "chat",
      ok: true,
      promptTokens: 100,
      completionTokens: 20,
    });
    expect(events).toContainEqual({
      modelId: "alibaba/qwen3.7-flash",
      mode: "service",
      ok: true,
      promptTokens: 10,
      completionTokens: 5,
    });
    // The helper model must NOT appear as a chat run.
    expect(events.filter((event) => event.mode === "chat").map((event) => event.modelId)).toEqual([
      "spacexai/grok-4.6",
    ]);
  });

  it("maps media tallies to their own modes with units and skips the zero fallback", () => {
    const events = turnUsageEvents({
      usage: {
        prompt: 0,
        completion: 0,
        calls: 2,
        byModel: {},
        media: {
          "openai/gpt-image-2": { images: 3, calls: 3 },
          "bytedance/seedance-2.5": { videoSeconds: 5, calls: 1 },
          "spacexai/grok-tts": { speechChars: 420, calls: 1 },
        },
      },
      mode: "image",
      fallbackModelId: "openai/gpt-image-2",
      ok: true,
    });
    expect(events).toContainEqual({
      modelId: "openai/gpt-image-2",
      mode: "image",
      ok: true,
      promptTokens: 0,
      completionTokens: 0,
      units: 3,
    });
    expect(events).toContainEqual({
      modelId: "bytedance/seedance-2.5",
      mode: "video",
      ok: true,
      promptTokens: 0,
      completionTokens: 0,
      units: 5,
    });
    expect(events).toContainEqual({
      modelId: "spacexai/grok-tts",
      mode: "audio",
      ok: true,
      promptTokens: 0,
      completionTokens: 0,
      units: 420,
    });
    expect(events).toHaveLength(3);
  });
});

describe("mergeUsageStats", () => {
  const stat = (partial: Partial<UsageStat>): UsageStat => ({
    modelId: "m",
    mode: "chat",
    runs: 0,
    errors: 0,
    users: 0,
    promptTokens: 0,
    completionTokens: 0,
    units: 0,
    lastUsed: 0,
    ...partial,
  });

  it("sums media units across modes", () => {
    const rows = mergeUsageStats([
      stat({ modelId: "img", mode: "image", runs: 2, units: 4 }),
      stat({ modelId: "img", mode: "image", runs: 1, units: 1 }),
    ]);
    expect(rows[0].units).toBe(5);
  });

  it("merges modes per model, ranks by runs and computes shares", () => {
    const rows = mergeUsageStats([
      stat({ modelId: "a", runs: 6, users: 2, promptTokens: 100, completionTokens: 50, lastUsed: 5 }),
      stat({ modelId: "a", mode: "image", runs: 2, users: 3, lastUsed: 9 }),
      stat({ modelId: "b", runs: 12, users: 1, errors: 3, lastUsed: 7 }),
    ]);
    expect(rows.map((row) => row.modelId)).toEqual(["b", "a"]);
    expect(rows[0].errors).toBe(3);
    expect(rows[0].share).toBeCloseTo(0.6);
    expect(rows[1].runs).toBe(8);
    expect(rows[1].modes).toEqual(["chat", "image"]);
    expect(rows[1].users).toBe(3);
    expect(rows[1].promptTokens).toBe(100);
    expect(rows[1].lastUsed).toBe(9);
    expect(rows[1].share).toBeCloseTo(0.4);
  });

  it("returns an empty list for no stats", () => {
    expect(mergeUsageStats([])).toEqual([]);
  });
});

describe("splitUsageStats", () => {
  const stat = (partial: Partial<UsageStat>): UsageStat => ({
    modelId: "m",
    mode: "chat",
    runs: 0,
    errors: 0,
    users: 0,
    promptTokens: 0,
    completionTokens: 0,
    units: 0,
    lastUsed: 0,
    ...partial,
  });

  it("sorts the service group last — helper spend never mixes into chat standings", () => {
    const groups = splitUsageStats([
      stat({ modelId: "alibaba/qwen3.7-flash", mode: "service", runs: 40 }),
      stat({ modelId: "chat-a", runs: 5 }),
      stat({ modelId: "img", mode: "image", runs: 2 }),
    ]);
    expect(groups.map((group) => group.mode)).toEqual(["chat", "image", "service"]);
    expect(groups[0].rows.map((row) => row.modelId)).toEqual(["chat-a"]);
    expect(groups[2].rows[0].runs).toBe(40);
  });

  it("groups by mode in chat-image-video-audio order with per-group shares", () => {
    const groups = splitUsageStats([
      stat({ modelId: "tts", mode: "audio", runs: 1 }),
      stat({ modelId: "img-a", mode: "image", runs: 3 }),
      stat({ modelId: "chat-a", runs: 6 }),
      stat({ modelId: "img-b", mode: "image", runs: 1 }),
      stat({ modelId: "vid", mode: "video", runs: 2 }),
    ]);
    expect(groups.map((group) => group.mode)).toEqual(["chat", "image", "video", "audio"]);
    expect(groups[0].runs).toBe(6);
    expect(groups[0].rows[0].share).toBeCloseTo(1);
    const image = groups[1];
    expect(image.runs).toBe(4);
    expect(image.rows.map((row) => row.modelId)).toEqual(["img-a", "img-b"]);
    expect(image.rows[0].share).toBeCloseTo(0.75);
    expect(image.rows[1].share).toBeCloseTo(0.25);
  });

  it("keeps a model used in two modes in both tables and sorts unknown modes last", () => {
    const groups = splitUsageStats([
      stat({ modelId: "dual", mode: "image", runs: 2 }),
      stat({ modelId: "dual", runs: 5 }),
      stat({ modelId: "weird", mode: "research", runs: 1 }),
    ]);
    expect(groups.map((group) => group.mode)).toEqual(["chat", "image", "research"]);
    expect(groups[0].rows[0].modelId).toBe("dual");
    expect(groups[0].rows[0].runs).toBe(5);
    expect(groups[1].rows[0].modelId).toBe("dual");
    expect(groups[1].rows[0].runs).toBe(2);
  });

  it("returns nothing for no stats", () => {
    expect(splitUsageStats([])).toEqual([]);
  });
});
