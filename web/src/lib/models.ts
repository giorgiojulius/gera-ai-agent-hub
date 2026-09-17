import { getToolkitUrl } from "@/lib/env";
import type {
  AgentSettings,
  CostTier,
  CreateMode,
  GatewayModel,
  ModelPricing,
  ModelType,
} from "@/lib/types";

export const DEFAULT_CHAT_MODEL = "spacexai/grok-4.6:xhigh";
/** Everyday choices shown before the chat picker's full catalog. */
export const PRIMARY_CHAT_MODEL_IDS = [
  "openai/gpt-6-astra",
  "spacexai/grok-4.6",
  "openai/gpt-5.6-sol",
  "anthropic/claude-fable-5.1",
  "openai/gpt-5.6-luna",
] as const;
export const CHAT_FALLBACKS = ["openai/gpt-5.6-terra", "google/gemini-3.7-flash"] as const;
/**
 * Cheapest catalog model for internal helper calls (tool router, research
 * planner). Gateway list rates as of 2026-08: qwen3.7-flash
 * $0.03/$0.13 per 1M vs gemini-3.7-flash $0.75/$3.75 — ~25x cheaper input.
 */
export const FAST_MODEL = "alibaba/qwen3.7-flash";
/**
 * Thread auto-titles run on Luna instead of the fast model — qwen titles
 * read clunky; at ≤64 output tokens per thread the upgrade costs pennies.
 */
export const TITLE_MODEL = "openai/gpt-5.6-luna";
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";
export const IMAGE_FALLBACKS = ["bytedance/seedream-5.0-lite", "spacexai/grok-imagine-image-2.0"] as const;
export const DEFAULT_VIDEO_MODEL = "bytedance/seedance-2.5";
export const VIDEO_FALLBACKS = ["alibaba/wan-v2.7-t2v", "google/veo-3.1-fast-generate-001"] as const;
export const DEFAULT_AUDIO_MODEL = "spacexai/grok-tts";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type ModelSelection = {
  catalogId: string;
  reasoningEffort?: ReasoningEffort;
};

/** Every pinnable thinking budget, in ascending depth — drives the Effort submenu. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/** Builds a selection id: bare catalog id, or `id:effort` when the thinking budget is pinned. */
export function withEffort(catalogId: string, effort?: ReasoningEffort): string {
  return effort ? `${catalogId}:${effort}` : catalogId;
}

/**
 * Curated current-generation catalog per creation tab. Anything not listed
 * here (older gateway generations) is hidden from every picker.
 */
export const MODE_MODEL_IDS: Record<CreateMode, string[]> = {
  chat: [
    "google/gemini-3.7-flash",
    "openai/gpt-6-astra",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
    "anthropic/claude-opus-5",
    "anthropic/claude-fable-5.1",
    "spacexai/grok-4.6:high",
    "spacexai/grok-4.6:xhigh",
    "spacexai/grok-4.20-reasoning",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "moonshotai/kimi-k3",
    "alibaba/qwen3.8-max",
    "alibaba/qwen3.7-flash",
    "bytedance/seed-1.8",
  ],
  image: [
    "openai/gpt-image-2",
    "bytedance/seedream-5.0-pro",
    "bytedance/seedream-5.0-lite",
    "spacexai/grok-imagine-image-2.0",
  ],
  video: [
    "bytedance/seedance-2.5",
    "alibaba/wan-v2.7-t2v",
    "google/veo-3.1-fast-generate-001",
    "klingai/kling-v3.0-t2v",
    "spacexai/grok-imagine-video-1.5",
  ],
  audio: ["spacexai/grok-tts", "openai/tts-1"],
};

/** How the input image reaches the model: pasted public link vs local file bytes. */
export type VideoImageSource = "url" | "base64";

/**
 * Video models that take locally attached images (raw base64) — probed
 * 2026-08-24 via the gateway's capabilities.input_limits metadata. Seedance
 * 2.5 accepts image input only as a public URL, so it's absent here but
 * present in the URL list below. Wan v2.7 is text-to-video only.
 */
export const I2V_READY_MODEL_IDS = [
  "klingai/kling-v3.0-i2v",
  "google/veo-3.1-fast-generate-001",
  "spacexai/grok-imagine-video-1.5",
] as const;

/** Models that animate a pasted public image link ("url" in supported_sources). */
export const I2V_URL_READY_MODEL_IDS = [
  "bytedance/seedance-2.5",
  "klingai/kling-v3.0-i2v",
  "google/veo-3.1-fast-generate-001",
  "spacexai/grok-imagine-video-1.5",
] as const;

const I2V_FALLBACK_TARGET = "spacexai/grok-imagine-video-1.5";

/** Docs-confirmed image-editing model — the retry target when a pick rejects input images. */
export const IMAGE_EDIT_MODEL = "openai/gpt-image-2";

/**
 * Whether the picked video model can animate a locally attached file.
 * Seedance takes images only as public links and Wan has no image input at
 * all — the composer hides the paperclip for those picks instead of silently
 * rerouting the run to another model.
 */
export function videoModelTakesLocalFiles(modelId: string): boolean {
  if ((I2V_READY_MODEL_IDS as readonly string[]).includes(modelId)) {
    return true;
  }
  // Kling t2v hands the file to its i2v sibling — same family, same look.
  return modelId === "klingai/kling-v3.0-t2v";
}

/** Which model actually runs when the user brings an image into video mode. */
export function resolveVideoModelForImage(
  modelId: string,
  source: VideoImageSource,
): { modelId: string; switched: boolean } {
  const ready = source === "url" ? I2V_URL_READY_MODEL_IDS : I2V_READY_MODEL_IDS;
  if ((ready as readonly string[]).includes(modelId)) {
    return { modelId, switched: false };
  }
  if (modelId === "klingai/kling-v3.0-t2v") {
    return { modelId: "klingai/kling-v3.0-i2v", switched: true };
  }
  // Pasted links can stay in the Bytedance family (URL is "always honoured"
  // there); local files need a base64-capable target.
  return {
    modelId: source === "url" ? "bytedance/seedance-2.5" : I2V_FALLBACK_TARGET,
    switched: true,
  };
}

/** Veo accepts only 4/6/8-second runs (probed); everything else here takes 5. */
export function videoDurationForModel(modelId: string): number {
  return modelId.startsWith("google/veo") ? 6 : 5;
}

/**
 * Same-operation fallbacks for image-to-video. Kling i2v and Grok Imagine
 * accept BOTH url and base64 input shapes (probed supported_sources), both
 * take 5s and 6s durations and every aspect the picker offers — so one list
 * safely backs either source kind receiving the identical request body.
 */
export function videoI2vFallbacks(primary: string): string[] {
  return ["klingai/kling-v3.0-i2v", I2V_FALLBACK_TARGET].filter((id) => id !== primary);
}

/** "klingai/kling-v3.0-i2v" → "kling-v3.0-i2v" — short handle for honest notes. */
export function modelShortName(modelId: string): string {
  return modelId.split("/")[1] ?? modelId;
}

/** Honest one-liner shown when an image-to-video run had to move off the picked model. */
export function videoImageSwitchNote(fromId: string, toId: string): string {
  const from = modelShortName(fromId);
  const to = modelShortName(toId);
  if (fromId === "klingai/kling-v3.0-t2v") {
    return `Animated with ${to} — the image-to-video variant of ${from}.`;
  }
  if (fromId === "bytedance/seedance-2.5") {
    return `Animated with ${to} — ${from} takes image input only as a public link. Paste the image URL in the prompt to run it on ${from}.`;
  }
  return `Animated with ${to} — ${from} doesn't support image-to-video.`;
}

/** Audio engines that must exist even when the gateway catalog omits them. */
const STATIC_AUDIO_MODELS: GatewayModel[] = [
  {
    id: "spacexai/grok-tts",
    name: "Grok TTS",
    description: "Natural text-to-speech voices from xAI.",
    owned_by: "spacexai",
    type: "speech",
    tags: [],
  },
  {
    id: "openai/tts-1",
    name: "OpenAI TTS-1",
    description: "Fast OpenAI text-to-speech.",
    owned_by: "openai",
    type: "speech",
    tags: [],
  },
];

/** Appends the built-in audio engines missing from the live catalog. */
export function withStaticModels(models: GatewayModel[]): GatewayModel[] {
  const seen = new Set(models.map((model) => model.id));
  const extras = STATIC_AUDIO_MODELS.filter((model) => !seen.has(model.id));
  return extras.length > 0 ? [...models, ...extras] : models;
}

export const MODE_LABEL: Record<CreateMode, string> = {
  chat: "Chat",
  image: "Image",
  video: "Video",
  audio: "Audio",
};

export function isCreateMode(value: unknown): value is CreateMode {
  return value === "chat" || value === "image" || value === "video" || value === "audio";
}

export function defaultModelForMode(mode: CreateMode): string {
  switch (mode) {
    case "image":
      return DEFAULT_IMAGE_MODEL;
    case "video":
      return DEFAULT_VIDEO_MODEL;
    case "audio":
      return DEFAULT_AUDIO_MODEL;
    default:
      return DEFAULT_CHAT_MODEL;
  }
}

/** Keeps only curated model ids; anything old/unknown falls back to the mode default. */
export function sanitizeModeModel(mode: CreateMode, id: string | undefined): string {
  if (mode === "chat") {
    return sanitizeChatModel(id);
  }
  return id && MODE_MODEL_IDS[mode].includes(id) ? id : defaultModelForMode(mode);
}

/** Which creation tab a curated model id belongs to, if any. */
export function modeOfModelId(id: string): CreateMode | undefined {
  const modes: CreateMode[] = ["chat", "image", "video", "audio"];
  return modes.find((mode) => MODE_MODEL_IDS[mode].includes(id));
}

export function modeForModelType(type: ModelType): CreateMode {
  if (type === "image") {
    return "image";
  }
  if (type === "video") {
    return "video";
  }
  if (type === "speech") {
    return "audio";
  }
  return "chat";
}

/** Chat catalog membership by base id — reasoning-effort suffixes ride along freely. */
const CHAT_CATALOG_IDS = new Set(MODE_MODEL_IDS.chat.map((id) => parseModelSelection(id).catalogId));

/**
 * Retired picks that have a direct successor in the catalog. Without this a
 * pinned model would fall all the way back to the default on the next
 * generation — moving a user off Anthropic entirely instead of onto the
 * newer Anthropic model they actually wanted.
 */
const MODEL_SUCCESSORS: Record<string, string> = {
  "openai/gpt-6-astra-fast": "openai/gpt-6-astra",
  "anthropic/claude-fable-5": "anthropic/claude-fable-5.1",
};

/**
 * Stale chat model ids (removed from the gateway or the curated list) would
 * otherwise persist in settings forever and silently degrade every answer —
 * upgrade them to their successor, or snap them to the current default.
 */
export function sanitizeChatModel(id: string | undefined, fallback: string = DEFAULT_CHAT_MODEL): string {
  if (!id) {
    return fallback;
  }
  const parsed = parseModelSelection(id);
  if (CHAT_CATALOG_IDS.has(parsed.catalogId)) {
    return id;
  }
  const successor = MODEL_SUCCESSORS[parsed.catalogId];
  if (successor && CHAT_CATALOG_IDS.has(successor)) {
    return withEffort(successor, parsed.reasoningEffort);
  }
  return fallback;
}

/** The model selection id driving the given creation tab. */
export function modelIdForMode(settings: AgentSettings, mode: CreateMode): string {
  if (mode === "image") {
    return sanitizeModeModel("image", settings.imageModelId);
  }
  if (mode === "video") {
    return sanitizeModeModel("video", settings.videoModelId);
  }
  if (mode === "audio") {
    return sanitizeModeModel("audio", settings.audioModelId);
  }
  return sanitizeChatModel(settings.modelId);
}

export function voicesForModel(modelId: string): string[] {
  if (modelId.startsWith("spacexai/") || modelId.startsWith("xai/")) {
    return ["eve", "ara", "rex", "sal", "leo"];
  }
  if (modelId.startsWith("openai/")) {
    return ["alloy", "nova", "shimmer", "onyx", "echo", "fable"];
  }
  return [];
}

export function defaultVoiceForModel(modelId: string): string {
  return voicesForModel(modelId)[0] ?? "";
}

function asModelType(value: unknown): ModelType {
  if (
    value === "language" ||
    value === "image" ||
    value === "video" ||
    value === "embedding" ||
    value === "speech" ||
    value === "transcription" ||
    value === "realtime" ||
    value === "reranking" ||
    value === "evaluation"
  ) {
    return value;
  }
  return "language";
}

function parseMoney(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function cheapestVideoSecond(raw: unknown): number | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const costs = raw
    .map((item) => parseMoney(asRecord(item)?.cost_per_second))
    .filter((cost): cost is number => typeof cost === "number");
  return costs.length > 0 ? Math.min(...costs) : undefined;
}

function videoMillionTokens(raw: unknown): number | undefined {
  const pricing = asRecord(raw);
  const tiers = pricing?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return undefined;
  }
  const first = asRecord(tiers[0]);
  const noInput = asRecord(first?.no_video_input);
  return parseMoney(noInput?.cost_per_million_tokens) ?? parseMoney(first?.cost_per_million_tokens);
}

function normalizePricing(raw: unknown): ModelPricing | undefined {
  const source = asRecord(raw);
  if (!source) {
    return undefined;
  }
  const pricing: ModelPricing = {
    input: parseMoney(source.input),
    output: parseMoney(source.output),
    inputCacheRead: parseMoney(source.input_cache_read),
    image: parseMoney(source.image),
    videoPerSecond: cheapestVideoSecond(source.video_duration_pricing),
    videoPerMillionTokens: videoMillionTokens(source.video_token_pricing),
    speechChar: parseMoney(source.speech_input_character_cost),
    audioInput: parseMoney(source.audio_input_token_cost),
    transcriptionPerSecond: parseMoney(source.transcription_duration_cost_per_second),
  };
  return Object.values(pricing).some((value) => typeof value === "number") ? pricing : undefined;
}

function normalizeModel(raw: Record<string, unknown>): GatewayModel {
  const modalities = raw.modalities as GatewayModel["modalities"] | undefined;
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? raw.id ?? "Unknown model"),
    description: typeof raw.description === "string" ? raw.description : undefined,
    owned_by: String(raw.owned_by ?? "unknown"),
    type: asModelType(raw.type),
    context_window: typeof raw.context_window === "number" ? raw.context_window : undefined,
    max_tokens: typeof raw.max_tokens === "number" ? raw.max_tokens : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
    pricing: normalizePricing(raw.pricing),
    modalities,
  };
}

/** Last catalog the gateway answered with — lets run config read model facts synchronously. */
let lastGatewayModels: GatewayModel[] = [];

/**
 * Context window (tokens) of a picked model from the last loaded gateway
 * catalog; undefined until the catalog loaded or when the gateway omits it.
 * Server runs use it to decide when MCP tool schemas would crowd the prompt.
 */
export function cachedContextWindow(selectionId: string): number | undefined {
  const model = resolveSelectionModel(lastGatewayModels, selectionId);
  return typeof model?.context_window === "number" && model.context_window > 0 ? model.context_window : undefined;
}

/**
 * Output ceiling (tokens) of a picked model from the last loaded gateway
 * catalog (`max_tokens`); undefined until the catalog loaded or when the
 * gateway omits it. Server runs send it with every completion so the
 * provider's default cap never shortens a reply.
 */
export function cachedMaxOutputTokens(selectionId: string): number | undefined {
  const model = resolveSelectionModel(lastGatewayModels, selectionId);
  return typeof model?.max_tokens === "number" && Number.isFinite(model.max_tokens) && model.max_tokens >= 1
    ? Math.floor(model.max_tokens)
    : undefined;
}

/**
 * Whether the picked model accepts image input per the last loaded gateway
 * catalog (`modalities.input` lists "image"); undefined until the catalog
 * loaded or when the gateway omits modalities. Server runs use it to decide
 * whether images an MCP tool returns are shown to the model or described.
 */
export function cachedAcceptsImages(selectionId: string): boolean | undefined {
  const model = resolveSelectionModel(lastGatewayModels, selectionId);
  const inputs = model?.modalities?.input;
  if (!Array.isArray(inputs)) {
    return undefined;
  }
  return inputs.some((item) => typeof item === "string" && item.toLowerCase() === "image");
}

export async function fetchGatewayModels(): Promise<GatewayModel[]> {
  const urls = [`${getToolkitUrl()}/v2/vercel/v1/models`, "https://ai-gateway.vercel.sh/v1/models"];
  let lastError: Error | null = null;

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        lastError = new Error("Could not load models.");
        continue;
      }
      const payload = (await response.json()) as { data?: Record<string, unknown>[] };
      const models = (payload.data ?? [])
        .map(normalizeModel)
        .filter((model) => model.id.length > 0);
      if (models.length > 0) {
        lastGatewayModels = models;
        return models;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Could not load models.");
    }
  }

  throw lastError ?? new Error("Could not load models.");
}

export function parseModelSelection(selectionId: string): ModelSelection {
  const split = selectionId.lastIndexOf(":");
  if (split <= 0) {
    return { catalogId: selectionId };
  }
  const catalogId = selectionId.slice(0, split);
  const effort = selectionId.slice(split + 1);
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") {
    return { catalogId, reasoningEffort: effort };
  }
  return { catalogId: selectionId };
}

/** "xhigh" → "xHigh", the rest capitalize — the label shown next to the model name. */
export function effortLabel(effort: ReasoningEffort): string {
  if (effort === "xhigh") {
    return "xHigh";
  }
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function resolveSelectionModel(models: GatewayModel[], selectionId: string): GatewayModel | undefined {
  const parsed = parseModelSelection(selectionId);
  const base = models.find((model) => model.id === parsed.catalogId);
  if (!base) {
    return undefined;
  }
  if (!parsed.reasoningEffort) {
    return base;
  }
  return {
    ...base,
    id: selectionId,
    name: `${base.name} ${effortLabel(parsed.reasoningEffort)}`,
  };
}

function modelsFromIds(models: GatewayModel[], ids: string[]): GatewayModel[] {
  return ids.map((id) => resolveSelectionModel(models, id)).filter((model): model is GatewayModel => Boolean(model));
}

/** Curated model list for one creation tab — old catalog generations excluded. */
export function modelsForMode(models: GatewayModel[], mode: CreateMode): GatewayModel[] {
  const resolved = modelsFromIds(models, MODE_MODEL_IDS[mode]);
  if (resolved.length > 0) {
    return resolved;
  }
  const type: ModelType = mode === "chat" ? "language" : mode === "audio" ? "speech" : mode;
  return models.filter((model) => model.type === type).slice(0, 12);
}

/**
 * Chat catalog deduped to base models — effort variants (`:high`, `:xhigh`)
 * collapse into one row; the thinking budget lives in its own submenu.
 */
export function chatBaseModels(models: GatewayModel[]): GatewayModel[] {
  const seen = new Set<string>();
  const result: GatewayModel[] = [];
  for (const id of MODE_MODEL_IDS.chat) {
    const catalogId = parseModelSelection(id).catalogId;
    if (seen.has(catalogId)) {
      continue;
    }
    seen.add(catalogId);
    const base = models.find((model) => model.id === catalogId);
    if (base) {
      result.push(base);
    }
  }
  if (result.length > 0) {
    return result;
  }
  return models.filter((model) => model.type === "language").slice(0, 12);
}

/** Splits the chat catalog into the primary choices and the More submenu. */
export function groupChatModels(models: GatewayModel[]): {
  primary: GatewayModel[];
  more: GatewayModel[];
} {
  const modelsById = new Map<string, GatewayModel>(models.map((model) => [model.id, model]));
  const primary = PRIMARY_CHAT_MODEL_IDS.map((id) => modelsById.get(id)).filter(
    (model): model is GatewayModel => Boolean(model),
  );
  const primaryIds = new Set<string>(PRIMARY_CHAT_MODEL_IDS);
  const more = models.filter((model) => !primaryIds.has(model.id));
  return { primary, more };
}

/** Every curated model across all creation tabs, in tab order. */
export function curatedModels(models: GatewayModel[]): GatewayModel[] {
  const modes: CreateMode[] = ["chat", "image", "video", "audio"];
  return modes.flatMap((mode) => modelsFromIds(models, MODE_MODEL_IDS[mode]));
}

export function findModel(models: GatewayModel[], id: string): GatewayModel | undefined {
  return resolveSelectionModel(models, id) ?? models.find((model) => model.id === id);
}

export function formatContext(tokens?: number): string {
  if (!tokens) {
    return "";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k ctx`;
  }
  return `${tokens} ctx`;
}

export function formatUsd(amount: number): string {
  if (amount <= 0) {
    return "$0";
  }
  if (amount < 0.01) {
    return `$${amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  if (amount < 10) {
    return `$${amount.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  if (Math.abs(amount - Math.round(amount)) < 0.05) {
    return `$${Math.round(amount)}`;
  }
  return `$${amount.toFixed(2)}`;
}

function perMillion(perToken: number): number {
  return perToken * 1_000_000;
}

/** Compact list rate: in→out per 1M tokens, or per image / second. */
export function formatModelCost(model: GatewayModel): string {
  const pricing = model.pricing;
  if (!pricing) {
    return "";
  }
  if (model.type === "image" && pricing.image != null) {
    return `${formatUsd(pricing.image)}/img`;
  }
  if (model.type === "video" && pricing.videoPerSecond != null) {
    return `${formatUsd(pricing.videoPerSecond)}/s`;
  }
  if (model.type === "video" && pricing.videoPerMillionTokens != null) {
    return `${formatUsd(pricing.videoPerMillionTokens)}/1M`;
  }
  if (model.type === "speech" && pricing.speechChar != null) {
    return `${formatUsd(perMillion(pricing.speechChar))}/1M ch`;
  }
  if (model.type === "transcription" && pricing.transcriptionPerSecond != null) {
    return `${formatUsd(pricing.transcriptionPerSecond)}/s`;
  }
  if (pricing.input != null && pricing.output != null) {
    return `${formatUsd(perMillion(pricing.input))}→${formatUsd(perMillion(pricing.output))}`;
  }
  if (pricing.input != null) {
    return `${formatUsd(perMillion(pricing.input))}/1M`;
  }
  if (pricing.audioInput != null) {
    return `${formatUsd(perMillion(pricing.audioInput))}/1M`;
  }
  return "";
}

export function formatModelCostDetail(model: GatewayModel): string {
  const pricing = model.pricing;
  if (!pricing) {
    return "Pricing unavailable";
  }
  const parts: string[] = [];
  if (pricing.input != null) {
    parts.push(`Input ${formatUsd(perMillion(pricing.input))} / 1M tokens`);
  }
  if (pricing.output != null) {
    parts.push(`Output ${formatUsd(perMillion(pricing.output))} / 1M tokens`);
  }
  if (pricing.image != null) {
    parts.push(`${formatUsd(pricing.image)} per image`);
  }
  if (pricing.videoPerSecond != null) {
    parts.push(`From ${formatUsd(pricing.videoPerSecond)} per second`);
  }
  if (pricing.videoPerMillionTokens != null) {
    parts.push(`${formatUsd(pricing.videoPerMillionTokens)} / 1M video tokens`);
  }
  if (pricing.speechChar != null) {
    parts.push(`${formatUsd(perMillion(pricing.speechChar))} / 1M characters`);
  }
  if (pricing.transcriptionPerSecond != null) {
    parts.push(`${formatUsd(pricing.transcriptionPerSecond)} per second`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Pricing unavailable";
}

function bucket(score: number, low: number, mid: number, high: number): CostTier {
  if (score < low) {
    return "value";
  }
  if (score < mid) {
    return "standard";
  }
  if (score < high) {
    return "premium";
  }
  return "flagship";
}

function blendedCost(model: GatewayModel): number | undefined {
  const pricing = model.pricing;
  if (!pricing) {
    return undefined;
  }

  let score: number | undefined;
  if (model.type === "image" && pricing.image != null) {
    score = pricing.image * 40;
  } else if (model.type === "video" && pricing.videoPerSecond != null) {
    score = pricing.videoPerSecond * 20;
  } else if (model.type === "video" && pricing.videoPerMillionTokens != null) {
    score = pricing.videoPerMillionTokens * 0.4;
  } else if (pricing.input != null) {
    const inputPerM = perMillion(pricing.input);
    const outputPerM = pricing.output != null ? perMillion(pricing.output) : inputPerM * 3;
    score = inputPerM + outputPerM * 0.25;
  } else if (pricing.speechChar != null) {
    score = perMillion(pricing.speechChar) * 0.15;
  } else if (pricing.transcriptionPerSecond != null) {
    score = pricing.transcriptionPerSecond * 80;
  }

  if (score == null) {
    return undefined;
  }

  const effort = parseModelSelection(model.id).reasoningEffort;
  if (effort === "high") {
    return score * 1.4;
  }
  if (effort === "xhigh") {
    return score * 2.2;
  }
  return score;
}

export function modelCostTier(model: GatewayModel): CostTier | undefined {
  const score = blendedCost(model);
  if (score == null) {
    return undefined;
  }
  return bucket(score, 2, 5.5, 10);
}

export function costTierLabel(tier: CostTier): string {
  const labels: Record<CostTier, string> = {
    value: "Value",
    standard: "Standard",
    premium: "Premium",
    flagship: "Flagship",
  };
  return labels[tier];
}

export function providerLabel(ownedBy: string): string {
  const labels: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    meta: "Meta",
    deepseek: "DeepSeek",
    moonshotai: "Moonshot",
    spacexai: "xAI",
    xai: "xAI",
    alibaba: "Alibaba",
    mistral: "Mistral",
    bytedance: "ByteDance",
    klingai: "Kling",
    bfl: "Black Forest",
    amazon: "Amazon",
    cohere: "Cohere",
    elevenlabs: "ElevenLabs",
  };
  return labels[ownedBy] ?? ownedBy;
}

export function typeLabel(type: ModelType): string {
  const labels: Record<ModelType, string> = {
    language: "Chat",
    image: "Image",
    video: "Video",
    speech: "Audio",
    transcription: "Transcribe",
    embedding: "Embed",
    realtime: "Realtime",
    reranking: "Rerank",
    evaluation: "Decide",
  };
  return labels[type];
}

export function composerPlaceholder(mode: CreateMode): string {
  switch (mode) {
    case "image":
      return "Describe the image to create…";
    case "video":
      return "Describe the video — or paste an image link to animate it…";
    case "audio":
      return "Text to speak aloud…";
    default:
      return "Message Gera…";
  }
}
