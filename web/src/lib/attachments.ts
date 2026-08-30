// Composer attachment intake — files become model-ready attachments: text is
// extracted where possible (so the model reads content, not base64), images
// go straight into the disk-backed media vault.
import { newId } from "@/lib/env";
import { extractFileText, isSupportedKnowledgeFile } from "@/lib/file-extract";
import { vaultDataUrl } from "@/lib/media-vault";
import { shrinkImageDataUrl } from "@/lib/resize-image";
import type { Attachment } from "@/lib/types";

/**
 * Raw-byte cap per attached image. The WHOLE model request (system prompt,
 * history, tools and every image) must fit the AI gateway's ~4.5 MB body
 * cap, so oversized photos are re-encoded once at intake — the vault then
 * only ever holds a copy the model can actually receive.
 */
const INTAKE_IMAGE_BYTES = 1_400_000;

export async function fileToAttachment(file: File): Promise<Attachment> {
  // Text-like files — including PDF/DOCX/XLSX via extraction — carry text the
  // model can actually read; images keep their data URL for vision input.
  if (!file.type.startsWith("image/") && isSupportedKnowledgeFile(file)) {
    try {
      const text = await extractFileText(file);
      return {
        id: newId(),
        name: file.name,
        mime: file.type || "text/plain",
        dataUrl: "",
        text,
      };
    } catch {
      // Extraction failed (e.g. scanned PDF) — fall through to the raw path.
    }
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
  let mime = file.type || "application/octet-stream";
  let payload = dataUrl;
  // A phone photo is 4–12 MB — far past the gateway's request cap. Shrink
  // fails soft (HEIC, corrupt bytes): the original is kept unchanged.
  if (mime.startsWith("image/")) {
    payload = await shrinkImageDataUrl(dataUrl, INTAKE_IMAGE_BYTES);
    if (payload !== dataUrl) {
      mime = "image/jpeg";
    }
  }
  return {
    id: newId(),
    name: file.name,
    mime,
    // Disk-backed from the first moment — the composer holds a tiny ref.
    dataUrl: await vaultDataUrl(payload),
  };
}
