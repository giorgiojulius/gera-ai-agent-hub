import { zodResolver } from "@hookform/resolvers/zod";
import { Box, Copy, ExternalLink } from "lucide-react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BLENDER_BRIDGE_COMMAND, blenderConnectionInput, blenderSetupSchema, type BlenderSetupValues } from "@/lib/blender-mcp";
import { TID } from "@/lib/testids";

/** Guides local setup, then verifies the user's protected bridge through the normal server-owned MCP flow. */
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
    defaultValues: { url: initialUrl, auth: "cloudflare", token: "", clientId: "", clientSecret: "", acknowledged: false },
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
              <strong>Install and start the Blender add-on.</strong> Install Blender 3.0+, Python 3.10+ and{" "}
              <a className="text-ember underline" href="https://docs.astral.sh/uv/getting-started/installation/" target="_blank" rel="noreferrer">uv</a>.
              Download <code>addon.py</code> from the{" "}
              <a className="text-ember underline" href="https://github.com/ahujasid/blender-mcp#installing-the-blender-addon" target="_blank" rel="noreferrer">upstream repository</a>,
              install it in Blender → Preferences → Add-ons, then enable it. In the 3D viewport press N →
              MCP for Blender / BlenderMCP → Start MCP Server (older versions: Connect to Claude).
              Keep Blender open. Port <code>9876</code> is a local TCP socket, not an MCP HTTP URL.
            </li>
            <li>
              <strong>Run the bridge on the same computer.</strong> Quit other Blender MCP clients first —
              run only one bridge. This command starts the stdio server and exposes Streamable HTTP at{" "}
              <code>http://127.0.0.1:8000/mcp</code>, with upstream telemetry disabled.
              <div className="mt-2 rounded-xl border border-border bg-muted/60 p-3">
                <code className="block select-text whitespace-pre-wrap break-words text-[11px]">{BLENDER_BRIDGE_COMMAND}</code>
                <Button type="button" size="sm" variant="ghost" className="mt-1 h-8 gap-1 px-0 text-xs" onClick={() => void copyCommand()}>
                  <Copy className="h-3 w-3" /> Copy command
                </Button>
              </div>
              <a className="mt-1 inline-flex items-center gap-1 text-ember underline" href="https://github.com/sparfenyuk/mcp-proxy" target="_blank" rel="noreferrer">
                Bridge documentation <ExternalLink className="h-3 w-3" />
              </a>
            </li>
            <li>
              <strong>Protect it before publishing an HTTPS address.</strong> Recommended: create a Cloudflare Access
              self-hosted application for your hostname, with a <strong>Service Auth</strong> policy allowing only
              your service token. Then route a named Cloudflare Tunnel on that hostname to{" "}
              <code>http://127.0.0.1:8000</code>. Set its HTTP Host Header to <code>127.0.0.1:8000</code> if the bridge rejects the host.
              Enter the resulting <code>https://your-host/mcp</code> URL below, plus the service token's Client ID and Client Secret.
              An ordinary browser-login policy is not sufficient for Gera's server requests.
              <a className="ml-1 text-ember underline" href="https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/" target="_blank" rel="noreferrer">Service-token guide</a>.
              Alternatively use your own HTTPS reverse proxy that enforces Bearer authentication.
            </li>
          </ol>
          <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-3 text-amber-900">
            The local bridge has no built-in authentication. Never expose ports 8000 or 9876 directly or use an
            unprotected public tunnel. Check that requests without credentials are denied before connecting.
            Blender tools can run Python and change files: save your work, disable tools you do not need, and consider{" "}
            <Link to="/settings" onClick={onClose} className="underline">Settings → Toolkit → Confirm write tools</Link>.
          </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4 border-t border-border pt-4" noValidate>
            <FormField control={form.control} name="url" render={({ field }) => (
              <FormItem><FormLabel>Public HTTPS bridge endpoint</FormLabel><FormControl>
                <Input {...field} data-testid={TID.blenderEndpoint} placeholder="https://blender.your-domain.com/mcp" autoComplete="off" spellCheck={false} />
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
                  <SelectContent><SelectItem value="cloudflare">Cloudflare Access service token</SelectItem><SelectItem value="bearer">Bearer token (protected reverse proxy)</SelectItem></SelectContent>
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
                <FormItem><FormLabel>Bearer token</FormLabel><FormControl><Input {...field} data-testid={TID.blenderToken} type="password" autoComplete="off" placeholder="Token enforced by your HTTPS proxy" /></FormControl><FormMessage /></FormItem>
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
