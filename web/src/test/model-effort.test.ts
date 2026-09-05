// Chat picker's model/effort split: selection ids round-trip, the catalog
// dedupes effort variants, and every pinned budget stays inside the curated
// chat catalog (so sanitizing never silently snaps it back to the default).
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHAT_MODEL,
  MODE_MODEL_IDS,
  REASONING_EFFORTS,
  chatBaseModels,
  effortLabel,
  groupChatModels,
  parseModelSelection,
  sanitizeChatModel,
  withEffort,
} from "@/lib/models";
import type { GatewayModel } from "@/lib/types";
import { normalizeStoredSettings } from "@/lib/history";

function gatewayModel(id: string): GatewayModel {
  return {
    id,
    name: id.split("/").pop() ?? id,
    owned_by: id.split("/")[0] ?? "",
    type: "language",
  };
}

describe("withEffort / parseModelSelection", () => {
  it("round-trips every effort", () => {
    for (const effort of REASONING_EFFORTS) {
      const parsed = parseModelSelection(withEffort("anthropic/claude-opus-5", effort));
      expect(parsed.catalogId).toBe("anthropic/claude-opus-5");
      expect(parsed.reasoningEffort).toBe(effort);
    }
  });

  it("default budget is the bare catalog id", () => {
    expect(withEffort("openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(parseModelSelection("openai/gpt-5.6-sol").reasoningEffort).toBeUndefined();
  });

  it("every effort combo of a curated chat model survives sanitizing", () => {
    for (const effort of [undefined, ...REASONING_EFFORTS]) {
      const id = withEffort("openai/gpt-5.6-sol", effort);
      expect(sanitizeChatModel(id)).toBe(id);
    }
  });

  it("the Reset target is a curated base with a pinned effort", () => {
    const parsed = parseModelSelection(DEFAULT_CHAT_MODEL);
    expect(parsed.reasoningEffort).toBeDefined();
    expect(sanitizeChatModel(DEFAULT_CHAT_MODEL)).toBe(DEFAULT_CHAT_MODEL);
  });
});

describe("chatBaseModels", () => {
  it("collapses effort variants into a single base row", () => {
    const models = [gatewayModel("spacexai/grok-4.6"), gatewayModel("anthropic/claude-opus-5")];
    const bases = chatBaseModels(models);
    expect(bases.filter((model) => model.id === "spacexai/grok-4.6")).toHaveLength(1);
  });

  it("keeps catalog order and only bases the gateway actually lists", () => {
    const models = [gatewayModel("anthropic/claude-opus-5"), gatewayModel("openai/gpt-5.6-sol")];
    expect(chatBaseModels(models).map((model) => model.id)).toEqual([
      "openai/gpt-5.6-sol",
      "anthropic/claude-opus-5",
    ]);
  });

  it("falls back to gateway language models when no curated base matches", () => {
    const models = [gatewayModel("acme/new-chat-model")];
    expect(chatBaseModels(models).map((model) => model.id)).toEqual(["acme/new-chat-model"]);
  });
});

describe("groupChatModels", () => {
  it("keeps Astra, Sol, Fable and Luna first and moves Grok under More", () => {
    const catalog = [
      gatewayModel("google/gemini-3.7-flash"),
      gatewayModel("openai/gpt-6-astra"),
      gatewayModel("openai/gpt-5.6-sol"),
      gatewayModel("openai/gpt-5.6-luna"),
      gatewayModel("anthropic/claude-opus-5"),
      gatewayModel("anthropic/claude-fable-5.1"),
      gatewayModel("spacexai/grok-4.6"),
    ];

    const groups = groupChatModels(catalog);

    expect(groups.primary.map((model) => model.id)).toEqual([
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
      "anthropic/claude-fable-5.1",
      "openai/gpt-5.6-luna",
    ]);
    expect(groups.more.map((model) => model.id)).toEqual([
      "google/gemini-3.7-flash",
      "anthropic/claude-opus-5",
      "spacexai/grok-4.6",
    ]);
  });
});

describe("Astra catalog", () => {
  it("migrates actual persisted composer, profile and Julius selections with effort intact", () => {
    const stored = normalizeStoredSettings({
      modelId: "openai/gpt-6-astra-fast:high",
      agents: [{ id: "artist", modelId: "openai/gpt-6-astra-fast:medium" }, { id: "default", modelId: "" }],
      julius: { candidateModelIds: ["openai/gpt-6-astra-fast", "anthropic/claude-opus-5"], chairmanModelId: "openai/gpt-6-astra-fast:xhigh" },
    });
    expect(stored.modelId).toBe("openai/gpt-6-astra:high");
    expect(stored.agents[0].modelId).toBe("openai/gpt-6-astra:medium");
    expect(stored.agents[1].modelId).toBe("");
    expect(stored.julius.candidateModelIds).toContain("openai/gpt-6-astra");
    expect(stored.julius.chairmanModelId).toBe("openai/gpt-6-astra:xhigh");
  });

  it("removes Fast from pickers and migrates stored Fast choices to ordinary Astra", () => {
    expect(MODE_MODEL_IDS.chat).not.toContain("openai/gpt-6-astra-fast");
    const bases = chatBaseModels([gatewayModel("openai/gpt-6-astra"), gatewayModel("openai/gpt-6-astra-fast")]);
    expect(bases.map((model) => model.id)).toEqual(["openai/gpt-6-astra"]);
    for (const effort of [undefined, ...REASONING_EFFORTS]) {
      expect(sanitizeChatModel(withEffort("openai/gpt-6-astra-fast", effort))).toBe(withEffort("openai/gpt-6-astra", effort));
    }
    expect(sanitizeChatModel("spacexai/grok-4.6:xhigh")).toBe("spacexai/grok-4.6:xhigh");
  });
});

describe("effortLabel", () => {
  it("labels xhigh as xHigh and capitalizes the rest", () => {
    expect(effortLabel("xhigh")).toBe("xHigh");
    expect(effortLabel("medium")).toBe("Medium");
    expect(effortLabel("low")).toBe("Low");
  });
});
