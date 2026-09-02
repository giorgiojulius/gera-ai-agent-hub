import { describe, expect, it } from "vitest";

import { bootActiveId } from "@/lib/agent-store";
import { chatIdFromPath, chatPath, isChatHomePath } from "@/lib/nav";
import type { Conversation } from "@/lib/types";

function thread(id: string, updatedAt: number): Conversation {
  return {
    id,
    title: id,
    modelId: "openai/gpt-5.1",
    createdAt: updatedAt,
    updatedAt,
    messages: [{ id: `${id}-m1`, role: "user", content: "hi", createdAt: updatedAt }],
  };
}

describe("chat addresses", () => {
  it("round-trips a thread id through its canonical address", () => {
    expect(chatIdFromPath(chatPath("abc123"))).toBe("abc123");
    expect(chatIdFromPath(chatPath("id with/slash"))).toBe("id with/slash");
    expect(chatIdFromPath("/c/abc123/")).toBe("abc123");
  });

  it("recognizes only /c/<id> as a chat address", () => {
    expect(chatIdFromPath("/")).toBeNull();
    expect(chatIdFromPath("/c/")).toBeNull();
    expect(chatIdFromPath("/c/a/b")).toBeNull();
    expect(chatIdFromPath("/settings")).toBeNull();
    expect(chatIdFromPath("/projects/p1/channels/c1")).toBeNull();
    expect(chatIdFromPath("/c/%E0%A4%A")).toBeNull();
    expect(isChatHomePath("/")).toBe(true);
    expect(isChatHomePath("")).toBe(true);
    expect(isChatHomePath("/c/abc")).toBe(false);
    expect(isChatHomePath("/settings")).toBe(false);
  });
});

describe("bootActiveId", () => {
  const newest = thread("newest", 3_000);
  const remembered = thread("remembered", 2_000);
  const oldest = thread("oldest", 1_000);
  const history = [newest, remembered, oldest];

  it("opens a fresh thread when the page loads at the chat home", () => {
    expect(bootActiveId(history, "/", "remembered")).toBeNull();
    expect(bootActiveId(history, "/", null)).toBeNull();
  });

  it("opens exactly the thread a /c/<id> address names", () => {
    expect(bootActiveId(history, chatPath("oldest"), "remembered")).toBe("oldest");
    expect(bootActiveId(history, chatPath("newest"), null)).toBe("newest");
  });

  it("keeps a deep link to a thread not on this device unresolved instead of guessing", () => {
    expect(bootActiveId(history, chatPath("elsewhere"), "remembered")).toBeNull();
  });

  it("falls back to the remembered thread only on pages that say nothing about chats", () => {
    expect(bootActiveId(history, "/settings", "remembered")).toBe("remembered");
    expect(bootActiveId(history, "/projects/p1", "gone")).toBe("newest");
    expect(bootActiveId([], "/settings", "remembered")).toBeNull();
  });
});
