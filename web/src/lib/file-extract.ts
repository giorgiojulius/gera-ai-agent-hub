/**
 * Knowledge/attachment text extraction. Plain-text formats are read as-is;
 * PDF (text layer, with a vision-model OCR fallback for scans), DOCX, and
 * XLSX/XLS go through lazily imported parsers so the main bundle stays lean.
 * Every extractor returns text capped at the caller's limit with an honest
 * trim marker.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  MAX_FILE_CHARS,
  TEXT_FILE_ACCEPT,
  capKnowledgeText,
  isTextLikeFile,
} from "@/lib/knowledge";
import type { OpenAiContentPart } from "@/lib/types";

/** Accept attribute covering every format knowledge/attachments can ingest. */
export const KNOWLEDGE_FILE_ACCEPT = `${TEXT_FILE_ACCEPT},.pdf,.docx,.xlsx,.xls,application/pdf`;

export type ExtractOptions = {
  /** Cap on returned characters; defaults to the knowledge per-file limit. */
  maxChars?: number;
  /** Called with honest status labels for slow phases (OCR, big scans). */
  onProgress?: (label: string) => void;
};

type ExtractKind = "text" | "pdf" | "docx" | "sheet";

function extractKind(file: File): ExtractKind | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf" || file.type === "application/pdf") {
    return "pdf";
  }
  if (ext === "docx") {
    return "docx";
  }
  if (ext === "xlsx" || ext === "xls") {
    return "sheet";
  }
  return isTextLikeFile(file) ? "text" : null;
}

export function isSupportedKnowledgeFile(file: File): boolean {
  return extractKind(file) !== null;
}

// ------------------------------------------------------------------- OCR

/** Cheap vision model; usage is reported to telemetry by streamCompletion. */
const OCR_MODEL = "google/gemini-3.7-flash";
const OCR_MAX_PAGES = 40;
const OCR_BATCH_PAGES = 4;
/** Target longest edge of a rendered page image — legible without huge payloads. */
const OCR_MAX_EDGE = 1600;
const OCR_BATCH_TIMEOUT_MS = 90_000;

/** Pages 1..min(total, maxPages) grouped into OCR request batches. Pure. */
export function ocrPageBatches(
  totalPages: number,
  batchSize: number = OCR_BATCH_PAGES,
  maxPages: number = OCR_MAX_PAGES,
): number[][] {
  const last = Math.min(totalPages, maxPages);
  const batches: number[][] = [];
  for (let start = 1; start <= last; start += batchSize) {
    const batch: number[] = [];
    for (let page = start; page < start + batchSize && page <= last; page += 1) {
      batch.push(page);
    }
    batches.push(batch);
  }
  return batches;
}

async function renderPageToJpeg(page: PDFPageProxy): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(0.75, OCR_MAX_EDGE / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is unavailable — OCR needs a browser canvas to render pages.");
  }
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  canvas.width = 0;
  canvas.height = 0;
  return dataUrl;
}

/**
 * Transcribes a scanned PDF with the vision model, batch by batch. Partial
 * failure keeps what was read and appends an honest stop marker; a scan that
 * produces no text at all throws.
 */
async function ocrScannedPdf(
  doc: PDFDocumentProxy,
  maxChars: number,
  onProgress?: (label: string) => void,
): Promise<string> {
  const { streamCompletion } = await import("@/lib/chat");
  const total = Math.min(doc.numPages, OCR_MAX_PAGES);
  const parts: string[] = [];
  let collected = 0;

  for (const batch of ocrPageBatches(doc.numPages)) {
    const span = batch.length === 1 ? `page ${batch[0]}` : `pages ${batch[0]}–${batch[batch.length - 1]}`;
    onProgress?.(`OCR: ${span} of ${total}…`);
    const images: string[] = [];
    for (const pageNo of batch) {
      images.push(await renderPageToJpeg(await doc.getPage(pageNo)));
    }
    const instruction =
      `These are scanned pages ${batch.join(", ")} of a PDF. Transcribe ALL text verbatim, in reading order. ` +
      `Start each page with a line exactly "[page N]" using its given number. Plain text only — no commentary, ` +
      `no markdown fences. If a page has no readable text, output just its "[page N]" line.`;
    const content: OpenAiContentPart[] = [
      { type: "text", text: instruction },
      ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ];
    try {
      const completion = await streamCompletion({
        modelId: OCR_MODEL,
        messages: [{ role: "user", content }],
        tools: [],
        handlers: { onText: () => undefined, signal: AbortSignal.timeout(OCR_BATCH_TIMEOUT_MS) },
      });
      const text = completion.content.trim();
      if (text.length > 0) {
        parts.push(text);
        collected += text.length;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      if (parts.length === 0) {
        throw new Error(`OCR failed: ${message}`);
      }
      parts.push(`… [OCR stopped at page ${batch[0]}: ${message}]`);
      break;
    }
    if (collected > maxChars + 4_000) {
      break; // already past the caller's cap — no point paying for more pages
    }
  }

  if (doc.numPages > OCR_MAX_PAGES) {
    parts.push(`… [OCR covers the first ${OCR_MAX_PAGES} of ${doc.numPages} pages]`);
  }
  const out = parts.join("\n\n");
  if (out.replace(/\[page \d+\]/g, "").trim().length < 20) {
    throw new Error("OCR could not read this scan — the pages produced no text.");
  }
  return out;
}

// ------------------------------------------------------------- extractors

async function extractPdf(
  file: File,
  maxChars: number,
  onProgress?: (label: string) => void,
): Promise<string> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    let collected = 0;
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim();
      if (text.length > 0) {
        pages.push(`[page ${pageNo}]\n${text}`);
        collected += text.length;
      }
      if (collected > maxChars + 4_000) {
        break; // already past the cap — no point parsing hundreds more pages
      }
    }
    // A "PDF" whose pages have almost no extractable text is a scan — OCR it.
    if (collected < Math.min(doc.numPages, 5) * 12) {
      onProgress?.("No text layer — reading the scan with OCR…");
      return await ocrScannedPdf(doc, maxChars, onProgress);
    }
    return pages.join("\n\n");
  } finally {
    void task.destroy();
  }
}

async function extractDocx(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  const text = result.value.replace(/\n{3,}/g, "\n\n").trim();
  if (text.length === 0) {
    throw new Error("No text found in this document.");
  }
  return text;
}

async function extractSheet(file: File, maxChars: number): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const parts: string[] = [];
  let collected = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) {
      continue;
    }
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    if (csv.length === 0) {
      continue;
    }
    parts.push(`[sheet: ${name}]\n${csv}`);
    collected += csv.length;
    if (collected > maxChars + 4_000) {
      break;
    }
  }
  if (parts.length === 0) {
    throw new Error("No data found in this spreadsheet.");
  }
  return parts.join("\n\n");
}

/**
 * Extracts readable text from a supported file, capped at
 * `options.maxChars` (default: the knowledge per-file limit). Scanned PDFs
 * go through vision-model OCR; throws with a user-facing message when
 * nothing is extractable.
 */
export async function extractFileText(file: File, options: ExtractOptions = {}): Promise<string> {
  const maxChars = options.maxChars ?? MAX_FILE_CHARS;
  const kind = extractKind(file);
  switch (kind) {
    case "pdf":
      return capKnowledgeText(await extractPdf(file, maxChars, options.onProgress), maxChars);
    case "docx":
      return capKnowledgeText(await extractDocx(file), maxChars);
    case "sheet":
      return capKnowledgeText(await extractSheet(file, maxChars), maxChars);
    case "text":
      return capKnowledgeText(await file.text(), maxChars);
    default:
      throw new Error("Unsupported file type.");
  }
}
