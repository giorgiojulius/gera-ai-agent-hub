import { describe, expect, it } from "vitest";

import {
  isPrereleaseModel,
  latestInFamily,
  latestSelection,
  modelFamily,
} from "../../../functions/model-lineage";
import {
  groupChatModels,
  chatBaseModels,
  resolvedModeIds,
  sanitizeChatModel,
  upgradeChatSelection,
  upgradeSettingsModels,
} from "@/lib/models";
import { defaultJuliusSettings } from "@/lib/julius";
import type { AgentSettings, GatewayModel } from "@/lib/types";

function model(id: string, released: number, type: GatewayModel["type"] = "language"): GatewayModel {
  return { id, name: id, owned_by: id.split("/")[0] ?? "", type, tags: [], released };
}

/** Shape of the live toolkit catalog on 2026-09-28 (subset). */
const CATALOG: GatewayModel[] = [
  model("spacexai/grok-4.5", 1783468800),
  model("spacexai/grok-4.6", 1786492800),
  model("spacexai/grok-4.7", 1789948800),
  model("spacexai/grok-4.20-reasoning", 1773100800),
  model("spacexai/grok-4.1-fast-reasoning", 1763510400),
  model("openai/gpt-5.6-sol", 1783555200),
  model("openai/gpt-5.6-sol-fast", 1783555200),
  model("openai/gpt-6-sol", 1790035200),
  model("openai/gpt-6-sol-fast", 1790035200),
  model("openai/gpt-5.6-luna", 1783555200),
  model("openai/gpt-6-luna", 1790035200),
  model("openai/gpt-5.6-terra", 1783555200),
  model("openai/gpt-6-astra", 1788480000),
  model("anthropic/claude-opus-5", 1784851200),
  model("anthropic/claude-opus-5.5", 1790035200),
  model("anthropic/claude-opus-5.5-fast", 1790035200),
  model("anthropic/claude-fable-5.1", 1788134400),
  model("google/gemini-3.7-flash", 1786579200),
  model("google/gemini-3.8-flash", 1788307200),
  model("google/gemini-3.8-flash-tts", 1790121600, "speech"),
  model("google/gemini-omni-flash-preview", 1782777600),
  model("alibaba/qwen3.7-flash", 1780000000),
  model("alibaba/qwen3.8-flash", 1787702400),
  model("alibaba/qwen3.8-max", 1785628800),
  model("alibaba/qwen3.8-max-0902", 1788220800),
  model("alibaba/qwen3.8-max-prime", 1790121600),
  model("deepseek/deepseek-v4-flash", 1776902400),
  model("deepseek/deepseek-v4.1-flash", 1788825600),
  model("deepseek/deepseek-v4-flash-vision-exp", 1787270400),
  model("deepseek/deepseek-v4-pro", 1776902400),
  model("moonshotai/kimi-k3", 1784160000),
  model("bytedance/seed-1.8", 1756684800),
  model("bytedance/seed-2.1-turbo", 1788000000),
];

describe("model lineage", () => {
  it("masks versions into a family and keeps variant words", () => {
    expect(modelFamily("spacexai/grok-4.6")).toBe("spacexai/grok-#");
    expect(modelFamily("openai/gpt-5.6-sol")).toBe(modelFamily("openai/gpt-6-sol"));
    expect(modelFamily("openai/gpt-6-sol-fast")).not.toBe(modelFamily("openai/gpt-6-sol"));
    expect(modelFamily("spacexai/grok-4.20-reasoning")).not.toBe(modelFamily("spacexai/grok-4.6"));
  });

  it("flags pre-release and dated snapshot builds", () => {
    expect(isPrereleaseModel("google/gemini-omni-flash-preview")).toBe(true);
    expect(isPrereleaseModel("deepseek/deepseek-v4-flash-vision-exp")).toBe(true);
    expect(isPrereleaseModel("alibaba/qwen3.8-max-0902")).toBe(true);
    expect(isPrereleaseModel("stealth/pixel-canary")).toBe(true);
    expect(isPrereleaseModel("spacexai/grok-4.7")).toBe(false);
  });

  it("finds the newest release of each line", () => {
    expect(latestInFamily(CATALOG, "spacexai/grok-4.6")).toBe("spacexai/grok-4.7");
    expect(latestInFamily(CATALOG, "openai/gpt-5.6-sol")).toBe("openai/gpt-6-sol");
    expect(latestInFamily(CATALOG, "openai/gpt-5.6-luna")).toBe("openai/gpt-6-luna");
    expect(latestInFamily(CATALOG, "anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5.5");
    expect(latestInFamily(CATALOG, "google/gemini-3.7-flash")).toBe("google/gemini-3.8-flash");
    expect(latestInFamily(CATALOG, "deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4.1-flash");
    expect(latestInFamily(CATALOG, "alibaba/qwen3.7-flash")).toBe("alibaba/qwen3.8-flash");
  });

  it("never jumps lines, types, variants or into pre-releases", () => {
    expect(latestInFamily(CATALOG, "openai/gpt-5.6-terra")).toBe("openai/gpt-5.6-terra");
    expect(latestInFamily(CATALOG, "spacexai/grok-4.20-reasoning")).toBe("spacexai/grok-4.20-reasoning");
    expect(latestInFamily(CATALOG, "alibaba/qwen3.8-max")).toBe("alibaba/qwen3.8-max");
    expect(latestInFamily(CATALOG, "bytedance/seed-1.8")).toBe("bytedance/seed-1.8");
    expect(latestInFamily(CATALOG, "moonshotai/kimi-k3")).toBe("moonshotai/kimi-k3");
    expect(latestInFamily([], "spacexai/grok-4.6")).toBe("spacexai/grok-4.6");
  });

  it("an older release with a bigger minor number never wins over a newer one", () => {
    const catalog = [model("spacexai/grok-4.7", 200), model("spacexai/grok-4.20", 100)];
    expect(latestInFamily(catalog, "spacexai/grok-4.7")).toBe("spacexai/grok-4.7");
  });

  it("keeps the reasoning effort pin", () => {
    expect(latestSelection(CATALOG, "spacexai/grok-4.6:xhigh")).toBe("spacexai/grok-4.7:xhigh");
    expect(latestSelection(CATALOG, "anthropic/claude-opus-5:high")).toBe("anthropic/claude-opus-5.5:high");
  });
});

describe("catalog-driven pickers", () => {
  it("chat pickers list the newest release of each curated line", () => {
    const ids = resolvedModeIds(CATALOG, "chat");
    expect(ids).toContain("spacexai/grok-4.7:xhigh");
    expect(ids).toContain("openai/gpt-6-sol");
    expect(ids).toContain("anthropic/claude-opus-5.5");
    expect(ids).not.toContain("spacexai/grok-4.6:xhigh");
    const bases = chatBaseModels(CATALOG).map((item) => item.id);
    expect(bases).toContain("spacexai/grok-4.7");
    expect(bases).not.toContain("spacexai/grok-4.6");
    expect(new Set(bases).size).toBe(bases.length);
  });

  it("primary picks follow their line", () => {
    const { primary } = groupChatModels(chatBaseModels(CATALOG));
    const ids = primary.map((item) => item.id);
    expect(ids).toContain("spacexai/grok-4.7");
    expect(ids).toContain("openai/gpt-6-sol");
    expect(ids).toContain("openai/gpt-6-luna");
  });

  it("media tabs stay hand-curated", () => {
    expect(resolvedModeIds(CATALOG, "audio")).toEqual(["spacexai/grok-tts", "openai/tts-1"]);
  });

  it("a newer release of a curated line survives sanitizing", () => {
    expect(sanitizeChatModel("spacexai/grok-4.7:xhigh")).toBe("spacexai/grok-4.7:xhigh");
    expect(sanitizeChatModel("openai/gpt-6-sol")).toBe("openai/gpt-6-sol");
    expect(sanitizeChatModel("google/gemini-omni-flash-preview")).not.toBe("google/gemini-omni-flash-preview");
  });

  it("upgrades saved picks, Julius and agent profiles; custom ids stay", () => {
    expect(upgradeChatSelection(CATALOG, "spacexai/grok-4.6:xhigh")).toBe("spacexai/grok-4.7:xhigh");
    expect(upgradeChatSelection(CATALOG, "")).toBe("");
    expect(upgradeChatSelection([], "spacexai/grok-4.6")).toBe("spacexai/grok-4.6");
    const settings = {
      modelId: "spacexai/grok-4.6:xhigh",
      julius: defaultJuliusSettings(),
      agents: [
        { id: "a", modelId: "anthropic/claude-opus-5" },
        { id: "b", modelId: "" },
      ],
    } as unknown as AgentSettings;
    const { settings: next, changed } = upgradeSettingsModels(settings, CATALOG);
    expect(next.modelId).toBe("spacexai/grok-4.7:xhigh");
    expect(next.julius.candidateModelIds).toEqual([
      "spacexai/grok-4.7:xhigh",
      "openai/gpt-5.6-terra",
      "anthropic/claude-opus-5.5",
    ]);
    expect(next.julius.proponentModelId).toBe("openai/gpt-6-sol");
    expect(next.julius.verifierModelId).toBe("google/gemini-3.8-flash");
    expect(next.agents[0]?.modelId).toBe("anthropic/claude-opus-5.5");
    expect(next.agents[1]?.modelId).toBe("");
    expect(changed.length).toBeGreaterThan(0);
    const again = upgradeSettingsModels(next, CATALOG);
    expect(again.changed).toEqual([]);
    expect(again.settings).toBe(next);
  });
});
