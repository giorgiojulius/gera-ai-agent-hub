import { z } from "zod";

import { safePublicHttpsUrl } from "../../../functions/network-safety";

/** Upstream stdio server exposed on loopback only. Authentication belongs at the HTTPS edge. */
export const BLENDER_BRIDGE_COMMAND =
  "uvx mcp-proxy --host 127.0.0.1 --port 8000 -e DISABLE_TELEMETRY true -- uvx blender-mcp";

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
