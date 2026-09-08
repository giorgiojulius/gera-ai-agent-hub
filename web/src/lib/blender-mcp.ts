import { z } from "zod";

import { safePublicHttpsUrl } from "../../../functions/network-safety";

/** Served from Gera's own origin. Standard library only, so an unrelated `mcp` package release cannot break it. */
export const BLENDER_BRIDGE_SCRIPT_PATH = "/gera-blender-bridge.py";

/** Where the bridge keeps the token it generates on first start (printed at every start). */
export const BLENDER_BRIDGE_TOKEN_FILE = "~/.gera/blender-bridge.token";

/**
 * Starts upstream `uvx blender-mcp` on stdio, serves it on loopback behind the bridge's own
 * Bearer token and, with `--tunnel`, prints a Cloudflare quick-tunnel address to paste into Gera.
 */
export const BLENDER_BRIDGE_COMMAND = "uv run gera-blender-bridge.py --tunnel";

/** Any HTTPS tunnel works because the bridge itself answers 401 without the token. */
export const BLENDER_TUNNEL_COMMAND = "cloudflared tunnel --url http://127.0.0.1:8000";

/**
 * The third-party bridge, pinned. `mcp-proxy` 0.12 declares `mcp>=1.17.0` with no upper bound, so a
 * plain `uvx mcp-proxy` resolves `mcp==2.0.0` (2026-07-28), which removed `request_ctx` and fails on
 * import. It has no authentication of its own, so it must stay behind Cloudflare Access.
 */
export const BLENDER_MCP_PROXY_COMMAND =
  'uvx --with "mcp<2" mcp-proxy --host 127.0.0.1 --port 8000 -e DISABLE_TELEMETRY true -- uvx blender-mcp';

/** Gera cannot reach the add-on socket or launch a local stdio process. */
export function blenderEndpointError(value: string): string | undefined {
  const url = safePublicHttpsUrl(value.trim());
  if (!url) {
    return "Use a public HTTPS bridge URL. Gera cannot reach localhost, LAN addresses or a stdio command.";
  }
  if (url.search || url.hash) {
    return "Use an endpoint without query parameters or fragments. Put credentials in the fields below, not the URL.";
  }
  if (url.port === "9876") {
    return "Port 9876 is Blender's TCP socket, not an HTTP MCP endpoint. Use the bridge's HTTPS /mcp URL.";
  }
  if (["github.com", "raw.githubusercontent.com", "blender.org", "www.blender.org"].includes(url.hostname)) {
    return "This is a website or source-code URL, not your Blender MCP bridge.";
  }
  return undefined;
}

/** Validates the explicit secure-bridge setup without retaining secrets in error messages. */
export const blenderSetupSchema = z.object({
  url: z.string().trim().superRefine((value, ctx) => {
    const message = blenderEndpointError(value);
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }),
  auth: z.enum(["cloudflare", "bearer"]),
  token: z.string().trim(),
  clientId: z.string().trim(),
  clientSecret: z.string().trim(),
  acknowledged: z.boolean().refine((value) => value, "Confirm that the HTTPS bridge is protected before connecting."),
}).superRefine((value, ctx) => {
  const required = value.auth === "bearer" ? ["token"] as const : ["clientId", "clientSecret"] as const;
  for (const key of required) {
    if (!value[key] || /[\r\n]/.test(value[key])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Enter a valid credential without line breaks." });
    }
  }
});

/** Form fields are ephemeral: only the connection request carries credentials to the vault. */
export type BlenderSetupValues = z.infer<typeof blenderSetupSchema>;

/** Builds an ordinary remote MCP request with stable Blender catalog identity, never a local URL. */
export function blenderConnectionInput(input: BlenderSetupValues) {
  const values = blenderSetupSchema.parse(input);
  return {
    catalogId: "blender",
    name: "Blender MCP",
    url: values.url,
    authMode: values.auth === "cloudflare" ? "headers" as const : "bearer" as const,
    token: values.auth === "bearer" ? values.token : "",
    headersJson: values.auth === "cloudflare" ? JSON.stringify({
      "CF-Access-Client-Id": values.clientId,
      "CF-Access-Client-Secret": values.clientSecret,
    }) : "",
  };
}
