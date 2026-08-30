import { describe, expect, it } from "vitest";

import { extractImageUrl } from "@/lib/image-url";
import {
  I2V_READY_MODEL_IDS,
  I2V_URL_READY_MODEL_IDS,
  IMAGE_EDIT_MODEL,
  modelShortName,
  resolveVideoModelForImage,
  videoDurationForModel,
  videoI2vFallbacks,
  videoImageSwitchNote,
  videoModelTakesLocalFiles,
} from "@/lib/models";

describe("resolveVideoModelForImage (base64 — attached file)", () => {
  it("keeps base64-capable i2v models as picked", () => {
    for (const id of I2V_READY_MODEL_IDS) {
      expect(resolveVideoModelForImage(id, "base64")).toEqual({ modelId: id, switched: false });
    }
  });

  it("routes Kling t2v to its i2v sibling", () => {
    expect(resolveVideoModelForImage("klingai/kling-v3.0-t2v", "base64")).toEqual({
      modelId: "klingai/kling-v3.0-i2v",
      switched: true,
    });
  });

  it("routes URL-only Seedance off attached files", () => {
    const routed = resolveVideoModelForImage("bytedance/seedance-2.5", "base64");
    expect(routed.switched).toBe(true);
    expect((I2V_READY_MODEL_IDS as readonly string[]).includes(routed.modelId)).toBe(true);
  });

  it("routes t2v-only Wan to a base64-capable model", () => {
    const routed = resolveVideoModelForImage("alibaba/wan-v2.7-t2v", "base64");
    expect(routed.switched).toBe(true);
    expect((I2V_READY_MODEL_IDS as readonly string[]).includes(routed.modelId)).toBe(true);
  });

  it("routes unknown ids somewhere capable instead of failing", () => {
    const routed = resolveVideoModelForImage("acme/unknown-model", "base64");
    expect(routed.switched).toBe(true);
    expect((I2V_READY_MODEL_IDS as readonly string[]).includes(routed.modelId)).toBe(true);
  });
});

describe("resolveVideoModelForImage (url — pasted link)", () => {
  it("keeps Seedance when the image arrives as a public link", () => {
    expect(resolveVideoModelForImage("bytedance/seedance-2.5", "url")).toEqual({
      modelId: "bytedance/seedance-2.5",
      switched: false,
    });
  });

  it("keeps every url-capable model as picked", () => {
    for (const id of I2V_URL_READY_MODEL_IDS) {
      expect(resolveVideoModelForImage(id, "url")).toEqual({ modelId: id, switched: false });
    }
  });

  it("still routes Kling t2v to its i2v sibling", () => {
    expect(resolveVideoModelForImage("klingai/kling-v3.0-t2v", "url")).toEqual({
      modelId: "klingai/kling-v3.0-i2v",
      switched: true,
    });
  });

  it("routes t2v-only Wan to a url-capable model", () => {
    const routed = resolveVideoModelForImage("alibaba/wan-v2.7-t2v", "url");
    expect(routed.switched).toBe(true);
    expect((I2V_URL_READY_MODEL_IDS as readonly string[]).includes(routed.modelId)).toBe(true);
  });
});

describe("videoDurationForModel", () => {
  it("sends 6s to Veo (supports only 4/6/8)", () => {
    expect(videoDurationForModel("google/veo-3.1-fast-generate-001")).toBe(6);
    expect(videoDurationForModel("google/veo-3.1-generate-001")).toBe(6);
  });

  it("sends 5s to everything else", () => {
    expect(videoDurationForModel("bytedance/seedance-2.5")).toBe(5);
    expect(videoDurationForModel("klingai/kling-v3.0-i2v")).toBe(5);
    expect(videoDurationForModel("spacexai/grok-imagine-video-1.5")).toBe(5);
  });
});

describe("videoI2vFallbacks", () => {
  it("never includes the primary model", () => {
    for (const id of I2V_READY_MODEL_IDS) {
      expect(videoI2vFallbacks(id)).not.toContain(id);
    }
  });

  it("only offers models that accept BOTH url and base64 envelopes", () => {
    const fallbacks = videoI2vFallbacks("google/veo-3.1-fast-generate-001");
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const id of fallbacks) {
      expect((I2V_READY_MODEL_IDS as readonly string[]).includes(id)).toBe(true);
      expect((I2V_URL_READY_MODEL_IDS as readonly string[]).includes(id)).toBe(true);
    }
  });
});

describe("videoModelTakesLocalFiles (paperclip visibility)", () => {
  it("rejects link-only Seedance so the paperclip hides", () => {
    expect(videoModelTakesLocalFiles("bytedance/seedance-2.5")).toBe(false);
  });

  it("rejects t2v-only Wan", () => {
    expect(videoModelTakesLocalFiles("alibaba/wan-v2.7-t2v")).toBe(false);
  });

  it("accepts every base64-capable model", () => {
    for (const id of I2V_READY_MODEL_IDS) {
      expect(videoModelTakesLocalFiles(id)).toBe(true);
    }
  });

  it("accepts Kling t2v via its i2v sibling", () => {
    expect(videoModelTakesLocalFiles("klingai/kling-v3.0-t2v")).toBe(true);
  });

  it("rejects unknown models instead of guessing", () => {
    expect(videoModelTakesLocalFiles("acme/unknown-model")).toBe(false);
  });
});

describe("extractImageUrl", () => {
  it("pulls a link and keeps the rest as the motion prompt", () => {
    const result = extractImageUrl("https://example.com/cat.jpg сделай чтобы кот прыгнул");
    expect(result).toEqual({
      url: "https://example.com/cat.jpg",
      text: "сделай чтобы кот прыгнул",
    });
  });

  it("handles a link in the middle of the prompt", () => {
    const result = extractImageUrl("оживи https://cdn.site.io/pic.png плавно, добавь ветер");
    expect(result?.url).toBe("https://cdn.site.io/pic.png");
    expect(result?.text).toBe("оживи плавно, добавь ветер");
  });

  it("keeps query strings (extension-less CDN links)", () => {
    const result = extractImageUrl("https://images.unsplash.com/photo-12345?w=1200&q=80 zoom in slowly");
    expect(result?.url).toBe("https://images.unsplash.com/photo-12345?w=1200&q=80");
  });

  it("strips trailing sentence punctuation from the link", () => {
    const result = extractImageUrl("Оживи картинку (https://example.com/dog.webp).");
    expect(result?.url).toBe("https://example.com/dog.webp");
  });

  it("returns empty text for a link-only prompt", () => {
    const result = extractImageUrl("https://example.com/scene.png");
    expect(result?.text).toBe("");
  });

  it("returns null when there is no link", () => {
    expect(extractImageUrl("закат над морем, волны")).toBeNull();
  });

  it("rejects hostnames without a dot", () => {
    expect(extractImageUrl("посмотри http://localhost:3000/pic.png")).toBeNull();
  });
});

describe("honest switch notes", () => {
  it("names both models in the video note", () => {
    const note = videoImageSwitchNote("bytedance/seedance-2.5", "spacexai/grok-imagine-video-1.5");
    expect(note).toContain("seedance-2.5");
    expect(note).toContain("grok-imagine-video-1.5");
    expect(note.toLowerCase()).toContain("paste");
  });

  it("explains the Kling sibling switch", () => {
    const note = videoImageSwitchNote("klingai/kling-v3.0-t2v", "klingai/kling-v3.0-i2v");
    expect(note).toContain("kling-v3.0-i2v");
  });

  it("shortens model ids for notes", () => {
    expect(modelShortName("openai/gpt-image-2")).toBe("gpt-image-2");
    expect(modelShortName("standalone")).toBe("standalone");
  });

  it("pins the docs-confirmed editor", () => {
    expect(IMAGE_EDIT_MODEL).toBe("openai/gpt-image-2");
  });
});
