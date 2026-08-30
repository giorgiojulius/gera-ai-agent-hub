import {
  CHAT_FALLBACKS,
  DEFAULT_AUDIO_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_FALLBACKS,
  VIDEO_FALLBACKS,
  defaultVoiceForModel,
  videoDurationForModel,
  videoI2vFallbacks,
  voicesForModel,
} from "@/lib/models";
import { clampImageCount, MAX_IMAGE_COUNT } from "@/lib/image-count";
import type { UploadImage } from "@/lib/resize-image";

/** Input image for i2v: local file bytes or a public link the provider fetches itself. */
export type VideoImageInput = UploadImage | { url: string };
import { executeSurfTool, SURF_TOOL_NAMES, SURF_TOOLS, type SurfSession } from "@/lib/selfsurf";
import { readErrorMessage, requireJson, toolkitFetch } from "@/lib/toolkit";
import { reportMediaUsage } from "@/lib/usage";
import type { BuiltinToolId, OpenAiTool, ResearchSource } from "@/lib/types";

/**
 * Assigns stable citation numbers to web sources gathered during one agent
 * turn. Numbers are handed out by the tool layer (not the model), so a [n]
 * marker in the answer is guaranteed to map to a page that was actually
 * searched or read.
 */
export type SourceLedger = {
  assign(url: string, title?: string): number;
  list(): ResearchSource[];
};

export function createSourceLedger(): SourceLedger {
  const order: ResearchSource[] = [];
  const byUrl = new Map<string, number>();
  return {
    assign(url: string, title?: string): number {
      const clean = url.trim();
      const existing = byUrl.get(clean);
      if (existing !== undefined) {
        const entry = order[existing - 1];
        if (title && (!entry.title || entry.title === clean)) {
          entry.title = title;
        }
        return existing;
      }
      const number = order.length + 1;
      byUrl.set(clean, number);
      order.push({ url: clean, title: title?.trim() ? title : clean });
      return number;
    },
    list(): ResearchSource[] {
      return order.map((item) => ({ ...item }));
    },
  };
}

const WEB_SEARCH_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web (Exa neural index). Use for current events, facts, docs, and anything that needs citations. Each result carries a citation number like [3] — cite claims with those markers.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        numResults: { type: "number", description: "Number of results, 3-8" },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Only results published within this window — use for news and anything time-sensitive",
        },
      },
      required: ["query"],
    },
  },
};

const FETCH_URL_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "fetch_url",
    description:
      "Read the full text of web pages. Each page also lists the links found on it — call fetch_url again on those links to browse deeper, hop by hop (read-only: no logins, no forms).",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "HTTP URLs to fetch",
        },
      },
      required: ["urls"],
    },
  },
};

const GENERATE_IMAGE_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate one or more images from a detailed visual prompt. Returns data URLs the UI will display. When the user asks for several images or variations, set count instead of calling this tool repeatedly.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed image description" },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536"],
          description: "Optional size",
        },
        count: {
          type: "number",
          minimum: 1,
          maximum: MAX_IMAGE_COUNT,
          description: `How many variations to generate in parallel (1-${MAX_IMAGE_COUNT}). Use only when the user explicitly asks for several.`,
        },
      },
      required: ["prompt"],
    },
  },
};

const GENERATE_VIDEO_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "generate_video",
    description: "Generate a short video from a prompt. This can take up to a few minutes.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed video description" },
        aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1"] },
      },
      required: ["prompt"],
    },
  },
};

const GENERATE_AUDIO_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "generate_audio",
    description: "Speak text aloud with text-to-speech. Returns audio the UI will play.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The exact text to read aloud" },
      },
      required: ["prompt"],
    },
  },
};

const TOOL_MAP: Record<Exclude<BuiltinToolId, "selfsurf">, OpenAiTool> = {
  web_search: WEB_SEARCH_TOOL,
  fetch_url: FETCH_URL_TOOL,
  generate_image: GENERATE_IMAGE_TOOL,
  generate_video: GENERATE_VIDEO_TOOL,
  generate_audio: GENERATE_AUDIO_TOOL,
};

export function builtinOpenAiTools(enabled: Record<BuiltinToolId, boolean>): OpenAiTool[] {
  const tools: OpenAiTool[] = [];
  if (enabled.web_search) {
    tools.push(TOOL_MAP.web_search);
  }
  if (enabled.fetch_url) {
    tools.push(TOOL_MAP.fetch_url);
  }
  // One toggle arms the whole SelfSurf browser tool family.
  if (enabled.selfsurf) {
    tools.push(...SURF_TOOLS);
  }
  if (enabled.generate_image) {
    tools.push(TOOL_MAP.generate_image);
  }
  if (enabled.generate_video) {
    tools.push(TOOL_MAP.generate_video);
  }
  if (enabled.generate_audio) {
    tools.push(TOOL_MAP.generate_audio);
  }
  return tools;
}

type ToolResult = {
  text: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
};

export async function executeBuiltinTool(
  name: string,
  argsJson: string,
  ledger?: SourceLedger,
  surf?: SurfSession,
): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }

  if (SURF_TOOL_NAMES.has(name)) {
    if (!surf) {
      return { text: "SelfSurf is not available in this mode." };
    }
    return { text: await executeSurfTool(name, args, surf, ledger) };
  }

  if (name === "web_search") {
    return {
      text: await runWebSearch(
        String(args.query ?? ""),
        Number(args.numResults ?? 5),
        typeof args.recency === "string" ? args.recency : undefined,
        ledger,
      ),
    };
  }
  if (name === "fetch_url") {
    const urls = Array.isArray(args.urls) ? args.urls.map(String) : [];
    return { text: await runFetchUrls(urls, ledger) };
  }
  if (name === "generate_image") {
    const count = clampImageCount(Number(args.count ?? 1));
    const batch = await generateImageBatch(
      String(args.prompt ?? ""),
      typeof args.size === "string" ? args.size : "1024x1024",
      DEFAULT_IMAGE_MODEL,
      [],
      count,
    );
    const text = [
      batch.images.length === 1 ? "Image generated." : `Generated ${batch.images.length} images.`,
      batch.failed > 0 ? `${batch.failed} of ${count} attempts failed.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return { text, images: batch.images };
  }
  if (name === "generate_video") {
    const video = await generateVideo(
      String(args.prompt ?? ""),
      typeof args.aspectRatio === "string" ? args.aspectRatio : "16:9",
    );
    return { text: "Video generated.", videos: [video] };
  }
  if (name === "generate_audio") {
    const audio = await generateAudio(String(args.prompt ?? ""));
    return { text: "Audio generated.", audios: [audio] };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const RECENCY_WINDOW_MS: Record<string, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

async function runWebSearch(
  query: string,
  numResults: number,
  recency?: string,
  ledger?: SourceLedger,
): Promise<string> {
  if (!query.trim()) {
    return "Missing search query.";
  }
  const windowMs = recency ? RECENCY_WINDOW_MS[recency] : undefined;
  const base = {
    query,
    type: "auto",
    numResults: Math.min(Math.max(numResults || 5, 3), 8),
    ...(windowMs ? { startPublishedDate: new Date(Date.now() - windowMs).toISOString() } : {}),
  };
  // Page text alongside highlights grounds answers far better than bare
  // snippets; fall back to highlights-only if the richer shape is rejected.
  let response = await toolkitFetch("/v2/exa/search", {
    method: "POST",
    body: JSON.stringify({ ...base, contents: { highlights: true, text: { maxCharacters: 1_200 } } }),
  });
  if (!response.ok) {
    response = await toolkitFetch("/v2/exa/search", {
      method: "POST",
      body: JSON.stringify({ ...base, contents: { highlights: true } }),
    });
  }
  const data = await requireJson<{
    results?: Array<{
      title?: string;
      url: string;
      publishedDate?: string | null;
      highlights?: string[];
      text?: string;
    }>;
  }>(response);
  const results = data.results ?? [];
  if (results.length === 0) {
    return windowMs
      ? `No results published in the last ${recency}. Retry without "recency" to include older material.`
      : "No search results.";
  }
  return results
    .map((hit, index) => {
      const marker = ledger ? `[${ledger.assign(hit.url, hit.title)}]` : `${index + 1}.`;
      const date = hit.publishedDate ? ` (${hit.publishedDate.slice(0, 10)})` : "";
      const highlights = (hit.highlights ?? []).slice(0, 2).join(" ");
      const body = (hit.text ?? "").replace(/\s+/g, " ").trim().slice(0, 1_000);
      return `${marker} ${hit.title ?? "(untitled)"}${date}\n${hit.url}\n${highlights}${body ? `\n${body}` : ""}`.trim();
    })
    .join("\n\n");
}

async function runFetchUrls(urls: string[], ledger?: SourceLedger): Promise<string> {
  const clean = urls.map((url) => url.trim()).filter((url) => url.startsWith("http")).slice(0, 4);
  if (clean.length === 0) {
    return "No valid URLs.";
  }
  // extras.links powers multi-hop browsing; retry the plain shape if the
  // proxy or upstream rejects the field so page reading never breaks.
  let response = await toolkitFetch("/v2/exa/contents", {
    method: "POST",
    body: JSON.stringify({ urls: clean, text: true, extras: { links: 10 } }),
  });
  if (!response.ok) {
    response = await toolkitFetch("/v2/exa/contents", {
      method: "POST",
      body: JSON.stringify({ urls: clean, text: true }),
    });
  }
  const data = await requireJson<{
    results?: Array<{ url?: string; title?: string; text?: string; extras?: { links?: string[] } }>;
  }>(response);
  const results = data.results ?? [];
  if (results.length === 0) {
    return "Could not fetch those pages.";
  }
  return results
    .map((item) => {
      const marker = item.url && ledger ? `[${ledger.assign(item.url, item.title)}] ` : "";
      const body = (item.text ?? "").slice(0, 4000);
      const links = (item.extras?.links ?? [])
        .filter((link) => typeof link === "string" && link.startsWith("http"))
        .slice(0, 10);
      const linksBlock =
        links.length > 0
          ? `\n\nLinks on this page (fetch_url them to browse deeper):\n${links.join("\n")}`
          : "";
      return `${marker}# ${item.title ?? item.url ?? "Page"}\n${item.url ?? ""}\n${body}${linksBlock}`;
    })
    .join("\n\n---\n\n");
}

export async function generateImage(
  prompt: string,
  size = "1024x1024",
  modelId = DEFAULT_IMAGE_MODEL,
  inputImages: UploadImage[] = [],
): Promise<string> {
  if (!prompt.trim()) {
    throw new Error("Describe the image first.");
  }
  const editing = inputImages.length > 0;
  const response = await toolkitFetch("/v2/vercel/v3/ai/image-model", {
    method: "POST",
    headers: {
      "ai-gateway-protocol-version": "0.0.1",
      "ai-image-model-specification-version": "4",
      "ai-model-id": modelId,
    },
    body: JSON.stringify({
      model: modelId,
      prompt,
      n: 1,
      size,
      ...(editing
        ? {
            files: inputImages.map((image) => ({
              type: "file",
              mediaType: image.mediaType,
              data: image.data,
            })),
          }
        : {}),
      // Editing pins one model: blind gateway fallbacks would re-bill models
      // that may not accept input images at all.
      providerOptions: editing ? {} : { gateway: { models: [...IMAGE_FALLBACKS] } },
    }),
  });
  const data = await requireJson<{ images?: string[] }>(response);
  const raw = data.images?.[0];
  if (!raw) {
    throw new Error("No image returned.");
  }
  // Per-asset billing — metered into the turn cost at the picked model's list rate.
  reportMediaUsage(modelId, { images: 1 });
  return raw.startsWith("data:") ? raw : `data:image/png;base64,${raw}`;
}

/**
 * Fans one prompt out into `count` parallel generations (each with its own
 * seed). Partial failures are tolerated: you get every image that worked plus
 * the number that failed — it only throws when the whole batch failed.
 */
export async function generateImageBatch(
  prompt: string,
  size = "1024x1024",
  modelId = DEFAULT_IMAGE_MODEL,
  inputImages: UploadImage[] = [],
  count = 1,
): Promise<{ images: string[]; failed: number }> {
  const total = clampImageCount(count);
  if (total === 1) {
    return { images: [await generateImage(prompt, size, modelId, inputImages)], failed: 0 };
  }
  const settled = await Promise.allSettled(
    Array.from({ length: total }, () => generateImage(prompt, size, modelId, inputImages)),
  );
  const images = settled
    .filter((item): item is PromiseFulfilledResult<string> => item.status === "fulfilled")
    .map((item) => item.value);
  if (images.length === 0) {
    const first = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    throw first && first.reason instanceof Error
      ? first.reason
      : new Error(String(first?.reason ?? "Image generation failed."));
  }
  return { images, failed: total - images.length };
}

export async function generateVideo(
  prompt: string,
  aspectRatio = "16:9",
  modelId = DEFAULT_VIDEO_MODEL,
  inputImage?: VideoImageInput,
): Promise<string> {
  if (!prompt.trim()) {
    throw new Error("Describe the video first.");
  }
  // Image runs need same-operation fallbacks; text runs keep the t2v set.
  const fallbackModels = inputImage ? videoI2vFallbacks(modelId) : [...VIDEO_FALLBACKS];
  const response = await toolkitFetch("/v2/vercel/v3/ai/video-model", {
    method: "POST",
    retry: false,
    headers: {
      "ai-gateway-protocol-version": "0.0.1",
      "ai-video-model-specification-version": "4",
      "ai-model-id": modelId,
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: modelId,
      prompt,
      n: 1,
      aspectRatio,
      // Veo rejects 5-second runs (4/6/8 only) — pick per model, not a constant.
      duration: videoDurationForModel(modelId),
      ...(inputImage
        ? "url" in inputImage
          ? { image: { type: "url", url: inputImage.url } }
          : { image: { type: "file", mediaType: inputImage.mediaType, data: inputImage.data } }
        : {}),
      providerOptions: {
        gateway: { models: fallbackModels },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const body = await response.text();
  const events = body
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");

  let errorMessage: string | null = null;
  let videoUrl: string | null = null;

  for (const event of events) {
    try {
      const parsed = JSON.parse(event) as {
        type?: string;
        message?: string;
        videos?: Array<{ type?: string; url?: string; data?: string; mediaType?: string }>;
      };
      if (parsed.type === "error") {
        errorMessage = parsed.message ?? "Video generation failed.";
        continue;
      }
      const videos = parsed.videos ?? [];
      if (videos.length === 0) {
        continue;
      }
      const first = videos[0];
      if (first.type === "url" && first.url) {
        videoUrl = first.url;
      } else if (first.data) {
        videoUrl = `data:${first.mediaType ?? "video/mp4"};base64,${first.data}`;
      } else if (first.url) {
        videoUrl = first.url;
      }
    } catch {
      // skip malformed events
    }
  }

  if (videoUrl) {
    // Duration is what we requested — the closest honest estimate we have.
    reportMediaUsage(modelId, { videoSeconds: videoDurationForModel(modelId) });
    return videoUrl;
  }
  throw new Error(errorMessage ?? "No video returned.");
}

export type AudioGenerationOptions = {
  modelId?: string;
  voice?: string;
};

/** Generates speech audio as a data URL via gateway text-to-speech with a provider voice. */
export async function generateAudio(prompt: string, options: AudioGenerationOptions = {}): Promise<string> {
  if (!prompt.trim()) {
    throw new Error("Add the text to speak first.");
  }
  const modelId = options.modelId ?? DEFAULT_AUDIO_MODEL;

  const allowed = voicesForModel(modelId);
  const voice = options.voice && allowed.includes(options.voice) ? options.voice : defaultVoiceForModel(modelId);
  const response = await toolkitFetch("/v2/vercel/v4/ai/speech-model", {
    method: "POST",
    retry: false,
    headers: {
      "ai-gateway-protocol-version": "0.0.1",
      "ai-model-id": modelId,
    },
    body: JSON.stringify({
      text: prompt,
      ...(voice ? { voice } : {}),
      outputFormat: "mp3",
    }),
  });
  const data = await requireJson<{ audio?: unknown; mediaType?: string }>(response);

  let base64: string | undefined;
  if (typeof data.audio === "string") {
    base64 = data.audio;
  } else if (data.audio && typeof data.audio === "object") {
    const nested = data.audio as { base64?: string; data?: string; url?: string };
    if (typeof nested.url === "string" && nested.url.length > 0) {
      return nested.url;
    }
    base64 = nested.base64 ?? nested.data;
  }
  if (!base64) {
    throw new Error("No audio returned.");
  }
  reportMediaUsage(modelId, { speechChars: prompt.length });
  return base64.startsWith("data:") ? base64 : `data:${data.mediaType ?? "audio/mpeg"};base64,${base64}`;
}

export function chatGatewayOptions(): Record<string, unknown> {
  return {
    gateway: {
      models: [...CHAT_FALLBACKS],
    },
  };
}
