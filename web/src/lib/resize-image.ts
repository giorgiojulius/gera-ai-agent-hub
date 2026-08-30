// Browser-side shrinker for images sent to AI models (image editing and
// image-to-video). The binding constraint is Vercel's 4.5 MB request-body
// cap: base64 adds ~33% overhead, so raw bytes must stay near 3 MB per
// request, split across all input images. A single fixed resize is not
// enough — detailed photos need an iterative pixel + quality ladder.
import { isVaultRef, resolveMediaDataUrl } from "@/lib/media-vault";
import type { ChatMessage } from "@/lib/types";

export type UploadImage = {
  /** Raw base64 (no data-URI prefix) — the gateway's `{type:"file"}` envelope. */
  data: string;
  mediaType: string;
};

type LadderStep = { maxEdge: number; quality: number };

const LADDER: readonly LadderStep[] = [
  { maxEdge: 1280, quality: 0.82 },
  { maxEdge: 1024, quality: 0.78 },
  { maxEdge: 832, quality: 0.74 },
  { maxEdge: 640, quality: 0.7 },
  { maxEdge: 512, quality: 0.65 },
];

function stripDataUriPrefix(base64: string): string {
  if (!base64.startsWith("data:")) {
    return base64;
  }
  const comma = base64.indexOf(",");
  return comma === -1 ? base64 : base64.slice(comma + 1);
}

function base64Bytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  try {
    await image.decode();
  } catch {
    throw new Error("Could not decode the attached image.");
  }
  return image;
}

/**
 * Re-encodes an attached image (data URL or media-vault ref) as JPEG under
 * the given raw-byte budget by walking a resize/quality ladder. Transparent
 * areas land on white — JPEG has no alpha channel.
 */
export async function resizeImageForUpload(source: string, maxBytes = 3_000_000): Promise<UploadImage> {
  const dataUrl = isVaultRef(source) ? await resolveMediaDataUrl(source) : source;
  if (!dataUrl || !dataUrl.startsWith("data:image/")) {
    throw new Error("That attachment is not an image the model can take.");
  }
  const image = await loadImage(dataUrl);
  if (image.naturalWidth === 0 || image.naturalHeight === 0) {
    throw new Error("The attached image is empty.");
  }
  const encoded = encodeUnderBudget(image, LADDER, maxBytes);
  if (!encoded) {
    throw new Error("The attached image is too large even after compression — try a smaller one.");
  }
  return { data: stripDataUriPrefix(encoded), mediaType: "image/jpeg" };
}

/** Walks a resize/quality ladder; returns a JPEG data URL under the budget, or null. */
function encodeUnderBudget(
  image: HTMLImageElement,
  ladder: readonly LadderStep[],
  maxBytes: number,
): string | null {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  for (const step of ladder) {
    const scale = Math.min(1, step.maxEdge / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Image processing is unavailable in this browser.");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    const encoded = canvas.toDataURL("image/jpeg", step.quality);
    if (base64Bytes(stripDataUriPrefix(encoded)) <= maxBytes) {
      return encoded;
    }
  }
  return null;
}

/** Chat-vision ladder starts higher than the editing one so screenshot text stays legible. */
const ATTACHMENT_LADDER: readonly LadderStep[] = [
  { maxEdge: 1600, quality: 0.85 },
  { maxEdge: 1280, quality: 0.8 },
  { maxEdge: 1024, quality: 0.75 },
  { maxEdge: 832, quality: 0.7 },
  { maxEdge: 640, quality: 0.65 },
  { maxEdge: 512, quality: 0.6 },
];

/**
 * Best-effort shrink for chat-vision image attachments: an oversized
 * `data:image/*` URL is re-encoded down the ladder to fit the raw-byte
 * budget. Everything else — already-small images, non-images, undecodable
 * bytes (e.g. HEIC on Chrome), environments without canvas — comes back
 * unchanged: sending the original is still better than sending nothing.
 */
export async function shrinkImageDataUrl(dataUrl: string, maxBytes: number): Promise<string> {
  if (!dataUrl.startsWith("data:image/") || base64Bytes(stripDataUriPrefix(dataUrl)) <= maxBytes) {
    return dataUrl;
  }
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return dataUrl;
  }
  try {
    const image = await loadImage(dataUrl);
    if (image.naturalWidth === 0 || image.naturalHeight === 0) {
      return dataUrl;
    }
    return encodeUnderBudget(image, ATTACHMENT_LADDER, maxBytes) ?? dataUrl;
  } catch {
    return dataUrl;
  }
}

/** Raw-byte budget for ALL images riding one chat request — the gateway caps the whole body near 4.5 MB. */
const TURN_IMAGE_BUDGET = 2_600_000;
const MIN_IMAGE_BUDGET = 300_000;
const MAX_IMAGE_BUDGET = 1_400_000;

/**
 * Shrinks oversized image attachments across a whole API turn (attachments
 * replay with the history on every request). The budget is split across all
 * images so the combined request stays under the gateway's body cap. Returns
 * the same references when nothing needed shrinking.
 */
export async function shrinkMessagesForApi(messages: ChatMessage[]): Promise<ChatMessage[]> {
  let imageCount = 0;
  for (const message of messages) {
    for (const item of message.attachments ?? []) {
      if (item.mime.startsWith("image/") && item.dataUrl.startsWith("data:image/")) {
        imageCount += 1;
      }
    }
  }
  if (imageCount === 0) {
    return messages;
  }
  const perImage = Math.min(
    MAX_IMAGE_BUDGET,
    Math.max(MIN_IMAGE_BUDGET, Math.floor(TURN_IMAGE_BUDGET / imageCount)),
  );
  let changedAny = false;
  const shrunk = await Promise.all(
    messages.map(async (message) => {
      const attachments = message.attachments;
      if (!attachments || attachments.length === 0) {
        return message;
      }
      let changed = false;
      const next = await Promise.all(
        attachments.map(async (item) => {
          if (!item.mime.startsWith("image/")) {
            return item;
          }
          const dataUrl = await shrinkImageDataUrl(item.dataUrl, perImage);
          if (dataUrl === item.dataUrl) {
            return item;
          }
          changed = true;
          // The re-encoded copy is a JPEG regardless of the original format.
          return { ...item, dataUrl, mime: "image/jpeg" };
        }),
      );
      if (!changed) {
        return message;
      }
      changedAny = true;
      return { ...message, attachments: next };
    }),
  );
  return changedAny ? shrunk : messages;
}
