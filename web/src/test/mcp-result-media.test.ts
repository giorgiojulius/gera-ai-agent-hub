// Phase 5.3 / 5.4 — binary parts of MCP tool results: images are kept as
// bounded data URLs (5 / 4 MB per call), audio and embedded blobs become
// saveable files (4 MB each), everything over a cap is described in text.
// The engine shows the images to a vision model in a separate user message
// and only leaves the text stub when the model cannot see images.
import { afterEach, describe, expect, it, vi } from "vitest";

import { runEngineTurn, type EngineMessage, type EngineToolOutcome } from "../../../functions/agent-engine";
import { callCloudMcpToolRich, type CloudMcpSession } from "../../../functions/mcp-cloud";
import { extractMcpResultMedia, MCP_MEDIA_MAX_BYTES, MCP_MEDIA_MAX_IMAGES } from "../../../functions/mcp-protocol";
import { modelAcceptsImages, parseModelCatalog, resetModelCatalogCache } from "../../../functions/model-catalog";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Base64 of roughly `bytes` bytes (all zeros). */
function base64OfBytes(bytes: number): string {
  return "A".repeat(Math.ceil(bytes / 3) * 4);
}

describe("extractMcpResultMedia", () => {
  it("keeps image parts as data URLs up to the per-call caps and describes the rest", () => {
    const content = Array.from({ length: MCP_MEDIA_MAX_IMAGES + 2 }, () => ({ type: "image", data: PNG, mimeType: "image/png" }));
    const media = extractMcpResultMedia({ content });
    expect(media.images).toHaveLength(MCP_MEDIA_MAX_IMAGES);
    expect(media.images[0]).toEqual({ dataUrl: `data:image/png;base64,${PNG}`, mimeType: "image/png", bytes: 70 });
    expect(media.files).toEqual([]);
    expect(media.omitted).toEqual([`2 more images omitted (limit ${MCP_MEDIA_MAX_IMAGES} images / 4 MB per call)`]);
  });

  it("enforces the 4 MB image budget per call", () => {
    const big = base64OfBytes(3 * 1024 * 1024);
    const media = extractMcpResultMedia({
      content: [
        { type: "image", data: big, mimeType: "image/jpeg" },
        { type: "image", data: big, mimeType: "image/jpeg" },
        { type: "image", data: PNG },
      ],
    });
    // The second 3 MB image breaks the budget; the small one after it still fits.
    expect(media.images.map((image) => image.mimeType)).toEqual(["image/jpeg", "image/png"]);
    expect(media.images[0].bytes).toBeLessThanOrEqual(MCP_MEDIA_MAX_BYTES);
    expect(media.omitted).toEqual([`1 more image omitted (limit ${MCP_MEDIA_MAX_IMAGES} images / 4 MB per call)`]);
  });

  it("turns audio parts and embedded blobs into files, names them, and notes anything over 4 MB", () => {
    const media = extractMcpResultMedia({
      content: [
        { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///docs/report.pdf", mimeType: "application/pdf", blob: "JVBERi0=" } },
        { type: "resource", resource: { uri: "file:///big.bin", mimeType: "application/octet-stream", blob: base64OfBytes(MCP_MEDIA_MAX_BYTES + 4096) } },
        { type: "text", text: "plain text stays text" },
      ],
    });
    expect(media.images).toEqual([]);
    expect(media.files.map((file) => [file.name, file.mimeType, file.bytes])).toEqual([
      ["audio-1.wav", "audio/wav", 4],
      ["report.pdf", "application/pdf", 5],
    ]);
    expect(media.files[0].dataUrl).toBe("data:audio/wav;base64,UklGRg==");
    expect(media.omitted).toHaveLength(1);
    expect(media.omitted[0]).toMatch(/^big\.bin \(application\/octet-stream, 4\.0 MB\) exceeds the 4 MB attachment limit/);
  });

  it("ships nothing for error results or non-content shapes", () => {
    expect(extractMcpResultMedia({ isError: true, content: [{ type: "image", data: PNG }] })).toEqual({ images: [], files: [], omitted: [] });
    expect(extractMcpResultMedia("text")).toEqual({ images: [], files: [], omitted: [] });
    expect(extractMcpResultMedia({ content: [{ type: "image", data: "" }] }).images).toEqual([]);
  });
});

describe("callCloudMcpToolRich", () => {
  it("returns the text stub plus the media, with omitted notes appended to the text", async () => {
    const content = [
      { type: "text", text: "Here is the chart" },
      ...Array.from({ length: MCP_MEDIA_MAX_IMAGES + 1 }, () => ({ type: "image", data: PNG, mimeType: "image/png" })),
      { type: "audio", data: "UklGRg==", mimeType: "audio/mpeg" },
    ];
    const session: CloudMcpSession = {
      url: "https://mcp.example.com/mcp",
      headers: {},
      omitMcpHeaders: false,
      nextId: 0,
      fetch: async (_url, init) => {
        const frame = JSON.parse(String(init.body)) as { id: number };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content } }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    };
    const result = await callCloudMcpToolRich(session, "chart", {});
    expect(result.text).toContain("Here is the chart");
    expect(result.text).toContain("[image content omitted · image/png");
    expect(result.text).toContain("[1 more image omitted (limit 5 images / 4 MB per call)]");
    expect(result.media.images).toHaveLength(MCP_MEDIA_MAX_IMAGES);
    expect(result.media.files.map((file) => file.name)).toEqual(["audio-1.mp3"]);
  });
});

/** SSE body for one gateway round. */
function sse(chunks: unknown[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]"].join("\n\n") + "\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

type GatewayCall = { messages: EngineMessage[] };

/** Stubs the gateway: round 1 asks for `tool`, round 2 answers with text. Records every request body. */
function stubGateway(tool: string): GatewayCall[] {
  const calls: GatewayCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as GatewayCall;
      calls.push(body);
      if (calls.length === 1) {
        return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: tool, arguments: "{}" } }] } }] },
        ]);
      }
      return sse([{ choices: [{ delta: { content: "I looked at the picture." } }] }, { usage: { total_tokens: 3 } }]);
    }),
  );
  return calls;
}

describe("images from tool results reach the model only when it can see them", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetModelCatalogCache();
  });

  const outcome: EngineToolOutcome = {
    text: "[image content omitted · image/png · 92 base64 chars]",
    images: [`data:image/png;base64,${PNG}`],
    files: [{ name: "audio-1.wav", mime: "audio/wav", dataUrl: "data:audio/wav;base64,UklGRg==", bytes: 4 }],
  };

  async function turn(acceptsImages: boolean, persist: boolean) {
    const calls = stubGateway("mcp_srv_chart");
    const stored: string[] = [];
    const result = await runEngineTurn({
      authKey: "k",
      modelId: "openai/gpt-5",
      gatewayUrl: "https://fake-gateway.workers.dev/v1/chat/completions",
      apiMessages: [{ role: "user", content: "Show me the chart" }],
      tools: [{ type: "function", function: { name: "mcp_srv_chart", description: "chart", parameters: { type: "object", properties: {} } } }],
      executeTool: async () => outcome,
      handlers: { onText: () => undefined },
      acceptsImages,
      ...(persist
        ? {
            persistMedia: (items) =>
              items.map((item) => {
                stored.push(item.kind);
                return `gera-cloud:v1:run:${stored.length - 1}`;
              }),
          }
        : {}),
    });
    return { calls, result, stored };
  }

  it("vision model: a separate user message with image parts follows the tool result", async () => {
    const { calls, result, stored } = await turn(true, true);
    expect(calls).toHaveLength(2);
    const second = calls[1].messages;
    const toolIndex = second.findIndex((message) => message.role === "tool");
    expect(toolIndex).toBeGreaterThan(0);
    const vision = second[toolIndex + 1];
    expect(vision.role).toBe("user");
    expect(Array.isArray(vision.content)).toBe(true);
    const parts = vision.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: "text", text: "Images returned by mcp_srv_chart (1):" });
    expect(parts[1].type).toBe("image_url");
    expect(parts[1].image_url?.url).toBe(`data:image/png;base64,${PNG}`);
    // The record and the turn carry persisted refs, never the bytes.
    expect(stored).toEqual(["image", "audio"]);
    expect(result.toolCalls[0].images).toEqual(["gera-cloud:v1:run:0"]);
    expect(result.toolCalls[0].files).toEqual([{ name: "audio-1.wav", mime: "audio/wav", url: "gera-cloud:v1:run:1", bytes: 4 }]);
    expect(result.images).toEqual(["gera-cloud:v1:run:0"]);
    expect(JSON.stringify(result.toolCalls)).not.toContain(PNG);
    expect(result.content).toBe("I looked at the picture.");
  });

  it("text-only model: the tool result keeps its stub and no image parts are sent", async () => {
    const { calls, result } = await turn(false, false);
    const second = calls[1].messages;
    expect(second.some((message) => Array.isArray(message.content))).toBe(false);
    const toolMessage = second.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("[image content omitted");
    // Without a media store the images stay inline on the turn (the surface decides).
    expect(result.images).toEqual([`data:image/png;base64,${PNG}`]);
    expect(result.toolCalls[0].images).toBeUndefined();
  });

  it("the gateway catalog decides vision for background runs, cached for ten minutes, unknown → no", async () => {
    const catalog = { data: [{ id: "openai/gpt-5", modalities: { input: ["text", "image"] } }, { id: "text-only/model", modalities: { input: ["text"] } }, { id: "no-modalities" }] };
    expect([...parseModelCatalog(catalog).keys()]).toEqual(["openai/gpt-5", "text-only/model", "no-modalities"]);
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return new Response(JSON.stringify(catalog), { status: 200 });
    }) as unknown as typeof fetch;
    const url = "https://catalog.test/v1/models";
    expect(await modelAcceptsImages("openai/gpt-5:high", { url, fetch: fetchImpl })).toBe(true);
    expect(await modelAcceptsImages("text-only/model", { url, fetch: fetchImpl })).toBe(false);
    expect(await modelAcceptsImages("no-modalities", { url, fetch: fetchImpl })).toBe(false);
    expect(await modelAcceptsImages("unknown/model", { url, fetch: fetchImpl })).toBe(false);
    expect(fetches).toBe(1);
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await modelAcceptsImages("openai/gpt-5", { url: "https://catalog.test/broken", fetch: failing })).toBe(false);
  });
});
