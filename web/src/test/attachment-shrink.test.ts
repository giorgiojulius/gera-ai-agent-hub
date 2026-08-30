// Chat vision pipeline: the AI gateway caps a whole request near 4.5 MB, so
// oversized image attachments are shrunk before they ride a turn, and images
// whose bytes are gone surface an honest note instead of silently vanishing
// from the model's view.
import { describe, expect, it } from "vitest";

import { userContent } from "../../../functions/agent-engine";

import { toApiMessages } from "@/lib/chat";
import { shrinkImageDataUrl, shrinkMessagesForApi } from "@/lib/resize-image";
import type { Attachment, ChatMessage } from "@/lib/types";

const smallImage = `data:image/png;base64,${"A".repeat(400)}`;

function userMessage(attachments: Attachment[]): ChatMessage {
  return { id: "m1", role: "user", content: "look at this", createdAt: 1, attachments };
}

describe("shrinkImageDataUrl", () => {
  it("leaves non-image sources untouched", async () => {
    expect(await shrinkImageDataUrl("idb:m_1", 1_000)).toBe("idb:m_1");
    expect(await shrinkImageDataUrl("", 1_000)).toBe("");
    expect(await shrinkImageDataUrl("data:application/pdf;base64,AAAA", 1)).toBe(
      "data:application/pdf;base64,AAAA",
    );
  });

  it("leaves images already under the budget untouched", async () => {
    expect(await shrinkImageDataUrl(smallImage, 1_000_000)).toBe(smallImage);
  });

  it("fails soft when re-encoding is impossible instead of dropping the image", async () => {
    // No canvas in this environment — the original must come back, not a crash.
    const huge = `data:image/png;base64,${"B".repeat(9_000)}`;
    expect(await shrinkImageDataUrl(huge, 1_000)).toBe(huge);
  });
});

describe("shrinkMessagesForApi", () => {
  it("returns the same reference when no images ride the turn", async () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "hi", createdAt: 1 },
      { id: "m2", role: "assistant", content: "hello", createdAt: 2 },
    ];
    expect(await shrinkMessagesForApi(messages)).toBe(messages);
  });

  it("keeps already-small images untouched by reference", async () => {
    const messages: ChatMessage[] = [
      userMessage([{ id: "a1", name: "s.png", mime: "image/png", dataUrl: smallImage }]),
    ];
    expect(await shrinkMessagesForApi(messages)).toBe(messages);
  });
});

describe("engine userContent (server)", () => {
  it("sends loadable images as vision parts", () => {
    const content = userContent("look", [
      { name: "shot.png", mime: "image/png", dataUrl: smallImage },
    ]);
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: "text", text: "look" });
    expect(parts[1]?.image_url?.url).toBe(smallImage);
  });

  it("tells the model honestly when image bytes are missing", () => {
    const content = userContent("what is on the picture?", [
      { name: "lost.png", mime: "image/png", dataUrl: "" },
    ]);
    expect(typeof content).toBe("string");
    expect(content).toContain("lost.png");
    expect(content).toContain("could not be loaded");
  });

  it("never forwards unresolved vault refs as image urls", () => {
    const content = userContent("look", [
      { name: "ref.png", mime: "image/png", dataUrl: "idb:m_42" },
    ]);
    expect(typeof content).toBe("string");
    expect(content).toContain("could not be loaded");
  });
});

describe("client toApiMessages images", () => {
  it("carries the honest note for lost images", () => {
    const api = toApiMessages([
      userMessage([{ id: "a1", name: "gone.png", mime: "image/png", dataUrl: "" }]),
    ]);
    const user = api.find((message) => message.role === "user");
    expect(typeof user?.content).toBe("string");
    expect(user?.content).toContain("gone.png");
    expect(user?.content).toContain("could not be loaded");
  });

  it("keeps real images as vision parts", () => {
    const api = toApiMessages([
      userMessage([{ id: "a1", name: "shot.png", mime: "image/png", dataUrl: smallImage }]),
    ]);
    const user = api.find((message) => message.role === "user");
    expect(Array.isArray(user?.content)).toBe(true);
  });
});
