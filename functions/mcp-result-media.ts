import { isRecord } from "./mcp-protocol-shared";

export const MCP_MEDIA_MAX_IMAGES = 5;
export const MCP_MEDIA_MAX_BYTES = 4 * 1024 * 1024;
export type McpResultImage = { dataUrl: string; mimeType: string; bytes: number };
export type McpResultFile = { name: string; mimeType: string; dataUrl: string; bytes: number };
export type McpResultMedia = { images: McpResultImage[]; files: McpResultFile[]; omitted: string[] };
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
function describeBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function fileNameFor(mimeType: string, uri: string, index: number): string {
  const fromUri = uri.split(/[/\\]/).pop()?.split("?")[0] ?? "";
  if (fromUri && fromUri.length <= 120) return fromUri;
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9.+-]/gi, "") ?? "";
  const ext = subtype === "mpeg" ? "mp3" : subtype || "bin";
  return `${mimeType.startsWith("audio/") ? "audio" : "file"}-${index + 1}.${ext}`;
}
/** Bounded binary attachments from MCP results. Errors never ship media. */
export function extractMcpResultMedia(result: unknown): McpResultMedia {
  const media: McpResultMedia = { images: [], files: [], omitted: [] };
  if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) return media;
  let imageBytes = 0;
  let imagesOver = 0;
  let fileIndex = 0;
  for (const part of result.content) {
    if (!isRecord(part)) continue;
    if (part.type === "image" && typeof part.data === "string" && part.data.length > 0) {
      const mimeType = typeof part.mimeType === "string" && /^image\//i.test(part.mimeType) ? part.mimeType : "image/png";
      const bytes = base64Bytes(part.data);
      if (media.images.length >= MCP_MEDIA_MAX_IMAGES || imageBytes + bytes > MCP_MEDIA_MAX_BYTES) { imagesOver += 1; continue; }
      imageBytes += bytes;
      media.images.push({ dataUrl: `data:${mimeType};base64,${part.data}`, mimeType, bytes });
      continue;
    }
    let blob = "";
    let mimeType = "";
    let uri = "";
    if (part.type === "audio" && typeof part.data === "string" && part.data.length > 0) {
      blob = part.data;
      mimeType = typeof part.mimeType === "string" && part.mimeType ? part.mimeType : "audio/wav";
    } else if (part.type === "resource" && isRecord(part.resource) && typeof part.resource.blob === "string" && part.resource.blob.length > 0) {
      blob = part.resource.blob;
      mimeType = typeof part.resource.mimeType === "string" && part.resource.mimeType ? part.resource.mimeType : "application/octet-stream";
      uri = typeof part.resource.uri === "string" ? part.resource.uri : "";
    } else { continue; }
    const bytes = base64Bytes(blob);
    const name = fileNameFor(mimeType, uri, fileIndex);
    fileIndex += 1;
    if (bytes > MCP_MEDIA_MAX_BYTES) { media.omitted.push(`${name} (${mimeType}, ${describeBytes(bytes)}) exceeds the 4 MB attachment limit and was not attached`); continue; }
    media.files.push({ name, mimeType, dataUrl: `data:${mimeType};base64,${blob}`, bytes });
  }
  if (imagesOver > 0) media.omitted.push(`${imagesOver} more image${imagesOver === 1 ? "" : "s"} omitted (limit ${MCP_MEDIA_MAX_IMAGES} images / 4 MB per call)`);
  return media;
}
