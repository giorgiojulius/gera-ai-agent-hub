// Turn-level usage metering: service split (router/planner/titles never pose
// as real model usage), cache/reasoning detail capture, and per-asset media
// tallies. The capture stack is module-global — every test closes what it opens.
import { describe, expect, it } from "vitest";

import {
  beginUsageCapture,
  detachedUsageTally,
  endUsageCapture,
  mergeUsage,
  parseUsagePayload,
  reportMediaUsage,
  reportUsage,
  reportUsageTo,
  settledUsage,
} from "@/lib/usage";

describe("parseUsagePayload", () => {
  it("reads OpenAI-style tokens with cache and reasoning details", () => {
    expect(
      parseUsagePayload({
        prompt_tokens: 1000,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 700 },
        completion_tokens_details: { reasoning_tokens: 120 },
      }),
    ).toEqual({ prompt: 1000, completion: 300, cached: 700, reasoning: 120 });
  });

  it("reads Anthropic-style tokens with cache reads", () => {
    expect(
      parseUsagePayload({ input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 400 }),
    ).toEqual({ prompt: 500, completion: 80, cached: 400, reasoning: 0 });
  });

  it("clamps subset counts to their parents and rejects empty payloads", () => {
    expect(parseUsagePayload({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } })?.cached).toBe(100);
    expect(parseUsagePayload({ prompt_tokens: 0, completion_tokens: 0 })).toBeNull();
    expect(parseUsagePayload("nope")).toBeNull();
    expect(parseUsagePayload(null)).toBeNull();
  });
});

describe("reportUsage", () => {
  it("routes service calls into serviceByModel, answers into byModel", () => {
    const capture = beginUsageCapture();
    reportUsage("spacexai/grok-4.6", { prompt_tokens: 100, completion_tokens: 50 });
    reportUsage("alibaba/qwen3.7-flash", { prompt_tokens: 30, completion_tokens: 10 }, "service");
    const usage = endUsageCapture(capture);
    expect(usage?.byModel).toEqual({
      "spacexai/grok-4.6": { prompt: 100, completion: 50, calls: 1 },
    });
    expect(usage?.serviceByModel).toEqual({
      "alibaba/qwen3.7-flash": { prompt: 30, completion: 10, calls: 1 },
    });
    // Totals stay honest — service spend is still spend.
    expect(usage?.prompt).toBe(130);
    expect(usage?.completion).toBe(60);
    expect(usage?.calls).toBe(2);
  });

  it("keeps cached and reasoning details per model", () => {
    const capture = beginUsageCapture();
    reportUsage("openai/gpt-5.6-terra", {
      prompt_tokens: 1000,
      completion_tokens: 400,
      prompt_tokens_details: { cached_tokens: 600 },
      completion_tokens_details: { reasoning_tokens: 250 },
    });
    const usage = endUsageCapture(capture);
    expect(usage?.byModel["openai/gpt-5.6-terra"]).toEqual({
      prompt: 1000,
      completion: 400,
      calls: 1,
      cached: 600,
      reasoning: 250,
    });
  });

  it("is a no-op without an open capture", () => {
    expect(() => reportUsage("m", { prompt_tokens: 10, completion_tokens: 1 })).not.toThrow();
  });
});

describe("reportUsageTo", () => {
  it("bills the named capture even when a newer turn is on top of the stack", () => {
    // Two threads run in parallel: A started first, B opened its capture
    // later. A's server run settles while B is still live — A's tokens must
    // land on A, not on whatever capture happens to be newest.
    const a = beginUsageCapture();
    const b = beginUsageCapture();
    reportUsageTo(a, "spacexai/grok-4.6", { prompt_tokens: 400, completion_tokens: 100 });
    reportUsageTo(a, "alibaba/qwen3.7-flash", { prompt_tokens: 20, completion_tokens: 5 }, "service");
    expect(endUsageCapture(b)).toBeUndefined();
    const usage = endUsageCapture(a);
    expect(usage?.byModel).toEqual({ "spacexai/grok-4.6": { prompt: 400, completion: 100, calls: 1 } });
    expect(usage?.serviceByModel).toEqual({ "alibaba/qwen3.7-flash": { prompt: 20, completion: 5, calls: 1 } });
    expect(usage?.calls).toBe(2);
  });

  it("fills a detached tally without touching the live capture stack", () => {
    const live = beginUsageCapture();
    const tally = detachedUsageTally();
    reportUsageTo(tally, "spacexai/grok-4.6", { prompt_tokens: 10, completion_tokens: 2 });
    expect(settledUsage(tally)?.prompt).toBe(10);
    expect(settledUsage(detachedUsageTally())).toBeUndefined();
    expect(endUsageCapture(live)).toBeUndefined();
  });
});

describe("reportMediaUsage", () => {
  it("tallies per-asset units and keeps a media-only capture alive", () => {
    const capture = beginUsageCapture();
    reportMediaUsage("openai/gpt-image-2", { images: 1 });
    reportMediaUsage("openai/gpt-image-2", { images: 2 });
    reportMediaUsage("bytedance/seedance-2.5", { videoSeconds: 5 });
    const usage = endUsageCapture(capture);
    expect(usage).toBeDefined(); // zero LLM calls, but assets were produced
    expect(usage?.media).toEqual({
      "openai/gpt-image-2": { calls: 2, images: 3 },
      "bytedance/seedance-2.5": { calls: 1, videoSeconds: 5 },
    });
  });

  it("ignores empty tallies", () => {
    const capture = beginUsageCapture();
    reportMediaUsage("openai/gpt-image-2", {});
    expect(endUsageCapture(capture)).toBeUndefined();
  });
});

describe("mergeUsage", () => {
  it("merges byModel, serviceByModel and media maps", () => {
    const merged = mergeUsage(
      {
        prompt: 100,
        completion: 50,
        calls: 2,
        byModel: { a: { prompt: 100, completion: 50, calls: 1 } },
        serviceByModel: { svc: { prompt: 10, completion: 5, calls: 1 } },
        media: { img: { calls: 1, images: 1 } },
      },
      {
        prompt: 40,
        completion: 20,
        calls: 2,
        byModel: { a: { prompt: 40, completion: 20, calls: 1, cached: 30 } },
        media: { img: { calls: 1, images: 2 } },
      },
    );
    expect(merged?.prompt).toBe(140);
    expect(merged?.byModel.a).toEqual({ prompt: 140, completion: 70, calls: 2, cached: 30 });
    expect(merged?.serviceByModel).toEqual({ svc: { prompt: 10, completion: 5, calls: 1 } });
    expect(merged?.media).toEqual({ img: { calls: 2, images: 3 } });
  });

  it("passes through one-sided merges", () => {
    const only = { prompt: 1, completion: 2, calls: 1, byModel: {} };
    expect(mergeUsage(only, undefined)).toBe(only);
    expect(mergeUsage(undefined, only)).toBe(only);
  });
});
