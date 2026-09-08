import { zodResolver } from "@hookform/resolvers/zod";
import { Box, Copy, Download, ExternalLink } from "lucide-react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BLENDER_BRIDGE_COMMAND,
  BLENDER_BRIDGE_DOWNLOADS_DIR,
  BLENDER_BRIDGE_SCRIPT_PATH,
  BLENDER_BRIDGE_TOKEN_FILE,
  BLENDER_BRIDGE_TOOLS,
  BLENDER_BRIDGE_VERSION,
  BLENDER_MCP_PROXY_COMMAND,
  BLENDER_TUNNEL_COMMAND,
  blenderConnectionInput,
  blenderSetupSchema,
  type BlenderSetupValues,
} from "@/lib/blender-mcp";
import { TID } from "@/lib/testids";

/** Guides local setup with Gera's self-protecting bridge, then verifies it through the normal server-owned MCP flow. */
export function BlenderMcpSetupDialog({
  onClose,
  onConnect,
  initialUrl = "",
}: {
  onClose: () => void;
  onConnect: (input: ReturnType<typeof blenderConnectionInput>) => void;
  initialUrl?: string;
}) {
  const form = useForm<BlenderSetupValues>({
    resolver: zodResolver(blenderSetupSchema),
    defaultValues: { url: initialUrl, auth: "bearer", token: "", clientId: "", clientSecret: "", acknowledged: false },
  });
  const auth = form.watch("auth");

  const submit = (values: BlenderSetupValues) => {
    onConnect(blenderConnectionInput(values));
    form.reset();
    onClose();
  };
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(BLENDER_BRIDGE_COMMAND);
      toast.success("Bridge command copied");
    } catch {
      toast.error("Could not copy. Select the command and copy it manually.");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-testid={TID.blenderSetup} className="max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Box className="h-5 w-5 text-ember" /> Connect Blender MCP</DialogTitle>
          <DialogDescription>
            Your Blender, connected to Gera. This community integration by ahujasid runs on your computer;
            it is not an official Blender cloud service.
          </DialogDescription>
        </DialogHeader>

        <div data-testid={TID.blenderGuide} className="space-y-3 text-xs leading-relaxed">
          <ol className="list-decimal space-y-3 pl-5 marker:font-semibold marker:text-ember">
            <li>
              <strong>Install and start the Blender add-on.</strong> Install Blender 3.0+ and{" "}
              <a className="text-ember underline" href="https://docs.astral.sh/uv/getting-started/installation/" target="_blank" rel="noreferrer">uv</a>{" "}
              (it brings Python along). Download <code>addon.py</code> from the{" "}
              <a className="text-ember underline" href="https://github.com/ahujasid/blender-mcp#installing-the-blender-addon" target="_blank" rel="noreferrer">upstream repository</a>,
              install it in Blender → Preferences → Add-ons, then enable it. In the 3D viewport press N →
              MCP for Blender / BlenderMCP → Start MCP Server (older versions: Connect to Claude).
              Keep Blender open. Port <code>9876</code> is a local TCP socket, not an MCP HTTP URL.
            </li>
            <li>
              <strong>Run the Gera bridge on the same computer.</strong> Download <code>gera-blender-bridge.py</code> into any
              folder and run the command there. It starts <code>uvx blender-mcp</code> for you, serves it at{" "}
              <code>http://127.0.0.1:8000/mcp</code> and answers <strong>401</strong> to every request without its own Bearer
              token (generated once, kept in <code>{BLENDER_BRIDGE_TOKEN_FILE}</code>, printed at start). <code>--tunnel</code> opens
              a free Cloudflare quick tunnel through{" "}
              <a className="text-ember underline" href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noreferrer">cloudflared</a>{" "}
              and prints the HTTPS address to paste — no Cloudflare account, Access application or service token.
              Quit other Blender MCP clients first — run only one bridge.
              <div className="mt-2 rounded-xl border border-border bg-muted/60 p-3">
                <code className="block select-text whitespace-pre-wrap break-words text-[11px]">{BLENDER_BRIDGE_COMMAND}</code>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <Button type="button" size="sm" variant="ghost" className="h-8 gap-1 px-0 text-xs" onClick={() => void copyCommand()}>
                    <Copy className="h-3 w-3" /> Copy command
                  </Button>
                  <Button asChild size="sm" variant="ghost" className="h-8 gap-1 px-0 text-xs">
                    <a data-testid={TID.blenderDownload} href={BLENDER_BRIDGE_SCRIPT_PATH} download="gera-blender-bridge.py">
                      <Download className="h-3 w-3" /> Download gera-blender-bridge.py
                    </a>
                  </Button>
                </div>
              </div>
              <span className="mt-1 block text-muted-foreground">
                Python standard library only — nothing to install besides uv, and no <code>mcp</code> package release can break it.
              </span>
              <span className="mt-1 block text-muted-foreground">
                Bridge {BLENDER_BRIDGE_VERSION} adds <code>{BLENDER_BRIDGE_TOOLS[0]}</code> and <code>{BLENDER_BRIDGE_TOOLS[1]}</code>: Gera fetches
                GLB/FBX/OBJ/USD files and textures from public URLs on your computer with browser-grade headers, retries and resume, verifies
                them, saves them under <code>{BLENDER_BRIDGE_DOWNLOADS_DIR}</code> and imports them into the open scene — no more 403s from CDNs
                or downloads stuck inside Blender. Running an older bridge? Download the script again, restart it, then press Re-check on the
                Blender card so the new tools appear.
              </span>
            </li>
            <li>
              <strong>Paste the address and token below.</strong> Endpoint <code>https://….trycloudflare.com/mcp</code>, authentication
              “Bridge token”, then Connect &amp; verify (give the tunnel about 10 seconds first). The quick-tunnel address changes
              whenever cloudflared restarts, the token does not — reopen this dialog from the Blender card to update it.
              Want a permanent address? Run the bridge without <code>--tunnel</code> and point any HTTPS tunnel at{" "}
              <code>http://127.0.0.1:8000</code> (e.g. <code>{BLENDER_TUNNEL_COMMAND}</code>, an ngrok static domain or a named
              Cloudflare Tunnel); Cloudflare Access service tokens still work through the option below.
            </li>
          </ol>
          <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-3 text-amber-900">
            Only the token stands between the internet and your Blender: keep it private, never expose ports 8000 or 9876
            directly, and check that <code>curl -i https://…/mcp</code> without a token returns 401 before connecting.
            Blender tools can run Python and change files: save your work, disable tools you do not need, and consider{" "}
            <Link to="/settings" onClick={onClose} className="underline">Settings → Toolkit → Confirm write tools</Link>.
          </div>
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">Using the third-party mcp-proxy instead?</summary>
            <p className="mt-1">
              Pin its MCP dependency — a plain <code>uvx mcp-proxy</code> now installs <code>mcp 2.0</code> and fails with{" "}
              <code>ImportError: cannot import name &apos;request_ctx&apos;</code>. It has no authentication of its own, so keep it
              behind Cloudflare Access with a Service Auth policy and choose “Cloudflare Access service token” below.
            </p>
            <code className="mt-1 block select-text whitespace-pre-wrap break-words text-[11px]">{BLENDER_MCP_PROXY_COMMAND}</code>
            <a className="mt-1 inline-flex items-center gap-1 text-ember underline" href="https://github.com/sparfenyuk/mcp-proxy/issues/235" target="_blank" rel="noreferrer">
              Upstream issue <ExternalLink className="h-3 w-3" />
            </a>
          </details>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4 border-t border-border pt-4" noValidate>
            <FormField control={form.control} name="url" render={({ field }) => (
              <FormItem><FormLabel>Public HTTPS bridge endpoint</FormLabel><FormControl>
                <Input {...field} data-testid={TID.blenderEndpoint} placeholder="https://your-tunnel.trycloudflare.com/mcp" autoComplete="off" spellCheck={false} />
              </FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="auth" render={({ field }) => (
              <FormItem><FormLabel>Bridge authentication</FormLabel>
                <Select value={field.value} onValueChange={(value) => {
                  field.onChange(value);
                  form.setValue("token", "");
                  form.setValue("clientId", "");
                  form.setValue("clientSecret", "");
                }}><FormControl><SelectTrigger data-testid={TID.blenderAuth}><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="bearer">Bridge token (printed by gera-blender-bridge.py)</SelectItem>
                    <SelectItem value="cloudflare">Cloudflare Access service token (own tunnel)</SelectItem>
                  </SelectContent>
                </Select><FormMessage />
              </FormItem>
            )} />
            {auth === "cloudflare" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField control={form.control} name="clientId" render={({ field }) => (
                  <FormItem><FormLabel>Client ID</FormLabel><FormControl><Input {...field} data-testid={TID.blenderClientId} autoComplete="off" spellCheck={false} placeholder="…access" /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="clientSecret" render={({ field }) => (
                  <FormItem><FormLabel>Client Secret</FormLabel><FormControl><Input {...field} data-testid={TID.blenderClientSecret} type="password" autoComplete="off" /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
            ) : (
              <FormField control={form.control} name="token" render={({ field }) => (
                <FormItem><FormLabel>Bridge token</FormLabel><FormControl><Input {...field} data-testid={TID.blenderToken} type="password" autoComplete="off" placeholder="Token printed when the bridge started" /></FormControl><FormMessage /></FormItem>
              )} />
            )}
            <FormField control={form.control} name="acknowledged" render={({ field }) => (
              <FormItem><div className="flex items-start gap-2"><FormControl><Checkbox data-testid={TID.blenderAcknowledge} checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} /></FormControl>
                <FormLabel className="text-xs font-normal leading-relaxed">My HTTPS bridge requires authentication. I understand that its tools can run code in my Blender.</FormLabel>
              </div><FormMessage /></FormItem>
            )} />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Credentials go to your account's server vault, not chat or browser storage. Connect checks the MCP handshake and tools/list;
              it does not prove Blender is open. After connecting, ask Gera: “Use Blender get_scene_info to inspect my scene without changing it.”
            </p>
            <div data-testid={TID.blenderErrors} role="status" className="text-xs text-destructive">
              {Object.keys(form.formState.errors).length > 0 ? "Check the highlighted fields. No connection has been attempted." : ""}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" data-testid={TID.blenderCancel} onClick={onClose}>Cancel</Button>
              <Button type="submit" data-testid={TID.blenderConnect}>Connect & verify</Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
