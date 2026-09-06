// Composer menus for MCP prompts (`/`) and resources (`@`). The hook owns the
// trigger detection, inventory loading, filtering, and keyboard handling; the
// panel is presentational; the dialog collects prompt arguments / template
// variables. All protocol work happens on the account shard (mcp-inventory.ts).

import { AtSign, FileText, Loader2, Server, SlashSquare, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  detectComposerMenuTrigger,
  fetchMcpInventory,
  menuEligibleServers,
  type ComposerMenuTrigger,
  type McpInventory,
  type McpPromptInfo,
  type McpResourceInfo,
  type McpResourceTemplateInfo,
} from "@/lib/mcp-inventory";
import { composerMcpItemTid, mcpArgsFieldTid, TID } from "@/lib/testids";
import type { McpServerConfig } from "@/lib/types";
import { cn } from "@/lib/utils";
import { connectorCacheKey, subscribeConnectorCaches } from "@/lib/connector-cache-scope";

export type ComposerMcpItem =
  | { kind: "prompt"; server: McpServerConfig; prompt: McpPromptInfo; key: string; label: string; hint: string }
  | { kind: "resource"; server: McpServerConfig; resource: McpResourceInfo; key: string; label: string; hint: string }
  | { kind: "template"; server: McpServerConfig; template: McpResourceTemplateInfo; key: string; label: string; hint: string };

type InventoryState = { status: "loading" } | { status: "ready"; value: McpInventory } | { status: "error"; message: string };

const MAX_ITEMS = 40;

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}

/** Menu label for a prompt (`/mcp:<server>:<prompt>`) and a resource (`@<server>/<uri>`). */
export function promptToken(server: Pick<McpServerConfig, "id">, prompt: Pick<McpPromptInfo, "name">): string {
  return `/mcp:${server.id}:${prompt.name}`;
}

export function resourceToken(server: Pick<McpServerConfig, "id">, uri: string): string {
  return `@${server.id}/${uri}`;
}

export type ComposerMcpMenu = {
  open: boolean;
  trigger: ComposerMenuTrigger | null;
  items: ComposerMcpItem[];
  loading: boolean;
  errors: string[];
  highlight: number;
  setHighlight: (index: number) => void;
  /** Returns true when the key was consumed by the menu. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  select: (item: ComposerMcpItem) => void;
  close: () => void;
};

/**
 * Drives the `/` and `@` menus from the input text and caret. Inventories load
 * lazily per eligible server the first time a menu of that kind opens.
 */
export function useComposerMcpMenu(params: {
  input: string;
  caret: number;
  servers: McpServerConfig[];
  enabled: boolean;
  onSelect: (item: ComposerMcpItem, trigger: ComposerMenuTrigger) => void;
}): ComposerMcpMenu {
  const { input, caret, servers, enabled, onSelect } = params;
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<number>(0);
  const [inventories, setInventories] = useState<Record<string, InventoryState>>({});
  useEffect(() => subscribeConnectorCaches(() => setInventories({})), []);

  const trigger = useMemo(() => (enabled ? detectComposerMenuTrigger(input, caret) : null), [enabled, input, caret]);
  const eligible = useMemo(
    () => (trigger ? menuEligibleServers(servers, trigger.kind === "prompt" ? "prompts" : "resources") : []),
    [servers, trigger],
  );
  const tokenKey = trigger ? `${trigger.kind}:${trigger.start}` : null;
  const open = Boolean(trigger) && eligible.length > 0 && dismissedToken !== tokenKey;

  useEffect(() => {
    if (!open) {
      return;
    }
    for (const server of eligible) {
      if (inventories[server.id]) {
        continue;
      }
      const scope = connectorCacheKey(server.id);
      setInventories((prev) => ({ ...prev, [server.id]: { status: "loading" } }));
      fetchMcpInventory(server.id)
        .then((value) => { if (scope === connectorCacheKey(server.id)) setInventories((prev) => ({ ...prev, [server.id]: { status: "ready", value } })); })
        .catch((error: unknown) => { if (scope === connectorCacheKey(server.id)) setInventories((prev) => ({ ...prev, [server.id]: { status: "error", message: error instanceof Error ? error.message : "Could not list this server" } })); });
    }
  }, [open, eligible, inventories]);

  const items = useMemo((): ComposerMcpItem[] => {
    if (!trigger || !open) {
      return [];
    }
    const out: ComposerMcpItem[] = [];
    for (const server of eligible) {
      const state = inventories[server.id];
      if (!state || state.status !== "ready") {
        continue;
      }
      if (trigger.kind === "prompt") {
        for (const prompt of state.value.prompts) {
          if (!matches(trigger.query, prompt.name, prompt.title, prompt.description, server.name, server.id)) {
            continue;
          }
          const argCount = prompt.arguments?.length ?? 0;
          out.push({
            kind: "prompt",
            server,
            prompt,
            key: `${server.id}:${prompt.name}`,
            label: prompt.title ?? prompt.name,
            hint: [prompt.description, argCount > 0 ? `${argCount} argument${argCount === 1 ? "" : "s"}` : "no arguments"]
              .filter(Boolean)
              .join(" · "),
          });
        }
      } else {
        for (const resource of state.value.resources) {
          if (!matches(trigger.query, resource.name, resource.title, resource.uri, resource.description, server.name)) {
            continue;
          }
          out.push({
            kind: "resource",
            server,
            resource,
            key: `${server.id}:${resource.uri}`,
            label: resource.title ?? resource.name,
            hint: [resource.uri, resource.mimeType].filter(Boolean).join(" · "),
          });
        }
        for (const template of state.value.resourceTemplates) {
          if (!matches(trigger.query, template.name, template.title, template.uriTemplate, template.description, server.name)) {
            continue;
          }
          out.push({
            kind: "template",
            server,
            template,
            key: `${server.id}:${template.uriTemplate}`,
            label: template.title ?? template.name,
            hint: `${template.uriTemplate} · template`,
          });
        }
      }
    }
    return out.slice(0, MAX_ITEMS);
  }, [eligible, inventories, open, trigger]);

  useEffect(() => {
    setHighlight(0);
  }, [trigger?.kind, trigger?.query, items.length]);

  const loading = open && eligible.some((server) => inventories[server.id]?.status !== "ready" && inventories[server.id]?.status !== "error");
  const errors = open
    ? eligible.flatMap((server) => {
        const state = inventories[server.id];
        return state?.status === "error" ? [`${server.name}: ${state.message}`] : [];
      })
    : [];

  const close = useCallback(() => {
    setDismissedToken(tokenKey);
  }, [tokenKey]);

  const select = useCallback(
    (item: ComposerMcpItem) => {
      if (!trigger) {
        return;
      }
      onSelect(item, trigger);
    },
    [onSelect, trigger],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) {
        return false;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((index) => (items.length === 0 ? 0 : (index + 1) % items.length));
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((index) => (items.length === 0 ? 0 : (index - 1 + items.length) % items.length));
        return true;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        const item = items[highlight];
        if (item) {
          event.preventDefault();
          select(item);
          return true;
        }
        if (loading) {
          event.preventDefault();
          return true;
        }
      }
      return false;
    },
    [close, highlight, items, loading, open, select],
  );

  return { open, trigger, items, loading, errors, highlight, setHighlight, onKeyDown, select, close };
}

/** Floating list above the textarea. */
export function ComposerMcpMenuPanel({ menu }: { menu: ComposerMcpMenu }) {
  if (!menu.open || !menu.trigger) {
    return null;
  }
  const isPrompt = menu.trigger.kind === "prompt";
  return (
    <div
      data-testid={TID.composerMcpMenu}
      role="listbox"
      aria-label={isPrompt ? "MCP prompts" : "MCP resources"}
      className="absolute inset-x-3 bottom-full z-30 mb-2 max-h-72 overflow-y-auto rounded-2xl border border-border/80 bg-popover p-1.5 text-popover-foreground shadow-[0_18px_48px_-20px_hsl(var(--ember)/0.45)]"
    >
      <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {isPrompt ? <SlashSquare className="h-3.5 w-3.5 text-ember" /> : <AtSign className="h-3.5 w-3.5 text-ember" />}
        <span>{isPrompt ? "MCP prompts" : "MCP resources"}</span>
        {menu.loading ? <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" /> : null}
      </div>
      {menu.items.length === 0 && !menu.loading ? (
        <p className="px-2 pb-2 pt-1 text-xs text-muted-foreground">
          {menu.errors.length > 0
            ? menu.errors.join(" · ")
            : isPrompt
              ? "No prompts match — connected servers offer none with this name."
              : "No resources match — connected servers offer none with this name."}
        </p>
      ) : null}
      {menu.items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="option"
          aria-selected={index === menu.highlight}
          data-testid={composerMcpItemTid(item.kind, item.server.id, item.kind === "prompt" ? item.prompt.name : item.kind === "resource" ? item.resource.uri : item.template.uriTemplate)}
          onMouseEnter={() => menu.setHighlight(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => menu.select(item)}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
            index === menu.highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
          )}
        >
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-ember/10 text-ember">
            {item.kind === "prompt" ? <Sparkles className="h-3.5 w-3.5" /> : item.kind === "template" ? <Server className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium">{item.label}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{item.server.name}</span>
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">{item.hint}</span>
          </span>
        </button>
      ))}
      {menu.items.length > 0 && menu.errors.length > 0 ? (
        <p className="px-2 pb-1 pt-1.5 text-[11px] text-amber-700/90">{menu.errors.join(" · ")}</p>
      ) : null}
    </div>
  );
}

export type McpArgsField = { name: string; label?: string; description?: string; required: boolean };

/** Prompt arguments / template variables form. Submitting with a missing required field is refused inline. */
export function McpArgsDialog({
  open,
  title,
  description,
  fields,
  submitLabel,
  busy,
  onSubmit,
  onClose,
  footer,
}: {
  open: boolean;
  title: string;
  description?: string;
  fields: McpArgsField[];
  submitLabel: string;
  busy?: boolean;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<boolean>(false);
  useEffect(() => {
    if (open) {
      setValues({});
      setTouched(false);
    }
  }, [open, fields]);
  const missing = fields.filter((field) => field.required && !(values[field.name] ?? "").trim());
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent data-testid={TID.mcpArgsDialog} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (missing.length > 0 || busy) {
              return;
            }
            const filled: Record<string, string> = {};
            for (const field of fields) {
              const value = values[field.name] ?? "";
              if (value.trim() || field.required) {
                filled[field.name] = value;
              }
            }
            onSubmit(filled);
          }}
        >
          {fields.map((field) => (
            <label key={field.name} className="block space-y-1 text-xs">
              <span className="flex items-baseline gap-1.5">
                <span className="font-medium">{field.label ?? field.name}</span>
                <span className="text-muted-foreground">{field.required ? "required" : "optional"}</span>
              </span>
              {field.description ? <span className="block text-[11px] text-muted-foreground">{field.description}</span> : null}
              <Input
                data-testid={mcpArgsFieldTid(field.name)}
                value={values[field.name] ?? ""}
                onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
                className={cn(
                  "h-9 border-border bg-white text-sm",
                  touched && field.required && !(values[field.name] ?? "").trim() && "border-destructive",
                )}
                autoFocus={fields[0]?.name === field.name}
              />
            </label>
          ))}
          {touched && missing.length > 0 ? (
            <p className="text-[11px] text-destructive">Fill in: {missing.map((field) => field.label ?? field.name).join(", ")}</p>
          ) : null}
          {footer}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" className="rounded-full" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" data-testid={TID.mcpArgsSubmit} className="rounded-full" disabled={busy}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
