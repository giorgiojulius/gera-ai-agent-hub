import { describe, expect, it } from "vitest";

import { toApiMessages } from "@/lib/chat";
import {
  DEFAULT_AUDIO_MODEL,
  DEFAULT_CHAT_MODEL,
  MODE_MODEL_IDS,
  defaultVoiceForModel,
  sanitizeChatModel,
  voicesForModel,
} from "@/lib/models";
import { routerContextDigest } from "@/lib/router";
import type { ChatMessage } from "@/lib/types";

function user(id: string, content: string): ChatMessage {
  return { id, role: "user", content, createdAt: 1 };
}

function assistant(id: string, content: string): ChatMessage {
  return { id, role: "assistant", content, createdAt: 1 };
}

function assistantWithTool(id: string, callId: string, result: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "done",
    toolCalls: [{ id: callId, name: "web_search", arguments: "{}", status: "done", result }],
    createdAt: 1,
  };
}

describe("replay budget tiering", () => {
  it("replays the newest tool results with far more room than older turns", () => {
    const long = "x".repeat(30_000);
    const api = toApiMessages([
      user("u1", "first question"),
      assistantWithTool("a1", "call_old", long),
      user("u2", "follow-up about that research"),
      assistantWithTool("a2", "call_new", long),
    ]);
    const toolMessages = api.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    const oldLen = (toolMessages[0].content as string).length;
    const newLen = (toolMessages[1].content as string).length;
    // Older turn stays a compact stub; the newest turn keeps real detail.
    expect(oldLen).toBeLessThan(3_000);
    expect(newLen).toBeGreaterThan(9_000);
  });

  it("treats the only tool-bearing turn as the recent one", () => {
    const long = "y".repeat(30_000);
    const api = toApiMessages([user("u1", "question"), assistantWithTool("a1", "call_1", long)]);
    const toolMessages = api.filter((message) => message.role === "tool");
    expect((toolMessages[0].content as string).length).toBeGreaterThan(9_000);
  });
});

describe("routerContextDigest", () => {
  it("labels roles, keeps order, and skips empty messages", () => {
    const digest = routerContextDigest([
      user("u1", "Расскажи про Tesla Model 3"),
      assistant("a1", "Вот обзор модели…"),
      assistant("a2", "   "),
    ]);
    expect(digest).toContain("User: Расскажи про Tesla Model 3");
    expect(digest).toContain("Assistant: Вот обзор модели…");
    expect(digest.split("\n")).toHaveLength(2);
  });

  it("caps long threads while keeping the most recent tail", () => {
    const messages: ChatMessage[] = Array.from({ length: 9 }, (_, index) =>
      user(`u${index}`, `topic-${index} ${"word ".repeat(120)}`),
    );
    const digest = routerContextDigest(messages);
    expect(digest.length).toBeLessThanOrEqual(1_600);
    expect(digest).toContain("topic-8");
  });

  it("returns an empty string for a fresh thread", () => {
    expect(routerContextDigest([])).toBe("");
  });
});

describe("sanitizeChatModel", () => {
  it("keeps curated chat picks including reasoning-effort variants", () => {
    expect(sanitizeChatModel("spacexai/grok-4.6:xhigh")).toBe("spacexai/grok-4.6:xhigh");
    expect(sanitizeChatModel("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
    expect(sanitizeChatModel("anthropic/claude-opus-5:high")).toBe("anthropic/claude-opus-5:high");
    expect(sanitizeChatModel("anthropic/claude-fable-5.1")).toBe("anthropic/claude-fable-5.1");
    expect(sanitizeChatModel("anthropic/claude-fable-5.1:high")).toBe("anthropic/claude-fable-5.1:high");
  });

  it("upgrades a retired pick to its successor instead of the default", () => {
    expect(sanitizeChatModel("anthropic/claude-fable-5")).toBe("anthropic/claude-fable-5.1");
    expect(sanitizeChatModel("anthropic/claude-fable-5:xhigh")).toBe("anthropic/claude-fable-5.1:xhigh");
  });

  it("snaps stale or removed chat models to the default", () => {
    expect(sanitizeChatModel("anthropic/claude-sonnet-4.5")).toBe(DEFAULT_CHAT_MODEL);
    expect(sanitizeChatModel(undefined)).toBe(DEFAULT_CHAT_MODEL);
    expect(sanitizeChatModel("")).toBe(DEFAULT_CHAT_MODEL);
  });
});

describe("catalog ids match the live gateway", () => {
  it("audio uses the spacexai/grok-tts id with working voices", () => {
    expect(DEFAULT_AUDIO_MODEL).toBe("spacexai/grok-tts");
    expect(MODE_MODEL_IDS.audio).toContain(DEFAULT_AUDIO_MODEL);
    expect(voicesForModel(DEFAULT_AUDIO_MODEL)).toContain("eve");
    expect(defaultVoiceForModel(DEFAULT_AUDIO_MODEL)).toBe("eve");
  });

  it("dead gateway ids are out of the curated lists", () => {
    expect(MODE_MODEL_IDS.image).not.toContain("google/imagen-4.0-ultra-generate-001");
    expect(MODE_MODEL_IDS.chat).not.toContain("anthropic/claude-sonnet-4.5");
    expect(MODE_MODEL_IDS.audio).not.toContain("xai/grok-tts");
  });

  it("fable runs the current 5.1 generation in the chat catalog", () => {
    expect(MODE_MODEL_IDS.chat).toContain("anthropic/claude-fable-5.1");
    expect(MODE_MODEL_IDS.chat).not.toContain("anthropic/claude-fable-5");
  });
});
