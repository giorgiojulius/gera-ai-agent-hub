// Run pause cards — the live run stopped to ask the user something:
//
// - elicitation: an MCP server asked for input. The form is built from the
//   fields the server requested (strings, numbers, booleans, enums); Accept
//   sends the validated values through /runs/answer, Decline and Cancel answer
//   without content; the server-side 5-minute timeout cancels otherwise;
// - confirmation: the MCP policy wants a write / destructive tool approved.
//   The card names the server and tool, shows a redacted argument preview,
//   and offers Run once / Always allow in this chat / Decline; 10 minutes
//   without a decision declines on the user's behalf.

import { Loader2, MessageSquareWarning, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAgent } from "@/hooks/agent-context";
import { errorFromUnknown } from "@/lib/errors";
import { answerRunPause, type RunPauseAnswer } from "@/lib/server-run";
import { runPauseFieldTid, TID } from "@/lib/testids";
import type { ElicitationField, RunPauseRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

type FieldValue = string | boolean;

function initialValues(fields: ElicitationField[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const field of fields) {
    if (field.type === "boolean") {
      out[field.name] = field.default === true;
    } else if (field.default !== undefined) {
      out[field.name] = String(field.default);
    } else {
      out[field.name] = "";
    }
  }
  return out;
}

/** Client-side mirror of the server validation — the server re-checks and reports field errors. */
function localErrors(fields: ElicitationField[], values: Record<string, FieldValue>): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    const label = field.title ?? field.name;
    const raw = values[field.name];
    if (field.type === "boolean") {
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      if (field.required) errors.push(`${label} is required`);
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      const value = Number(text);
      if (!Number.isFinite(value)) errors.push(`${label} must be a number`);
      else if (field.type === "integer" && !Number.isInteger(value)) errors.push(`${label} must be a whole number`);
      else if (field.minimum !== undefined && value < field.minimum) errors.push(`${label} must be at least ${field.minimum}`);
      else if (field.maximum !== undefined && value > field.maximum) errors.push(`${label} must be at most ${field.maximum}`);
      continue;
    }
    if (field.minLength !== undefined && text.length < field.minLength) errors.push(`${label} must be at least ${field.minLength} characters`);
    if (field.maxLength !== undefined && text.length > field.maxLength) errors.push(`${label} must be at most ${field.maxLength} characters`);
  }
  return errors;
}

function toContent(fields: ElicitationField[], values: Record<string, FieldValue>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.type === "boolean") {
      out[field.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      continue;
    }
    out[field.name] = field.type === "number" || field.type === "integer" ? Number(text) : text;
  }
  return out;
}

function remainingLabel(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  if (seconds >= 60) {
    return `${Math.ceil(seconds / 60)} min left`;
  }
  return `${seconds}s left`;
}

export function RunPauseCard({ request, conversationId }: { request: RunPauseRequest; conversationId: string }) {
  if (request.kind === "confirmation") {
    return <RunConfirmCard request={request} conversationId={conversationId} />;
  }
  return <ElicitationCard request={request} conversationId={conversationId} />;
}

/** Write-tool confirmation: Run once / Always allow in this chat / Decline. */
function RunConfirmCard({ request, conversationId }: { request: RunPauseRequest; conversationId: string }) {
  const { approveMcpTool } = useAgent();
  const [busy, setBusy] = useState<RunPauseAnswer["action"] | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const toolName = request.confirm?.toolName ?? "tool";
  const destructive = request.confirm?.risk === "destructive";
  const preview = request.confirm?.argumentsPreview ?? "";

  const answer = async (action: "accept" | "always" | "decline") => {
    if (busy) {
      return;
    }
    setBusy(action);
    try {
      const result = await answerRunPause(conversationId, request.id, { action });
      if (!result.ok) {
        if (result.reason === "not_found" || result.reason === "not_running") {
          toast.message("This confirmation was already answered or the run has moved on.");
        } else {
          toast.error("Could not send the decision", { description: result.reason ?? "unknown error" });
        }
        return;
      }
      if (action === "always") {
        // Later runs of this thread carry the approval, so the card never returns for this tool.
        approveMcpTool(conversationId, { serverId: request.serverId, toolName });
      }
    } catch (error) {
      toast.error("Could not send the decision", { description: errorFromUnknown(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid={TID.runConfirmCard}
      className={cn(
        "mb-3 rounded-2xl border p-3 shadow-sm",
        destructive
          ? "border-destructive/40 bg-[linear-gradient(180deg,hsl(var(--destructive)/0.08),transparent_70%)]"
          : "border-ember/40 bg-[linear-gradient(180deg,hsl(var(--ember)/0.08),transparent_70%)]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl",
            destructive ? "bg-destructive/15 text-destructive" : "bg-ember/15 text-ember",
          )}
        >
          <ShieldAlert className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium">
              Run <code className="rounded bg-foreground/[0.06] px-1 font-mono text-[12px]">{toolName}</code> on {request.serverName}?
            </span>
            <span
              className={cn(
                "rounded-full border px-1.5 py-px text-[10px] font-medium",
                destructive
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-700",
              )}
            >
              {destructive ? "destructive" : "writes data"}
            </span>
            <span className="text-[11px] text-muted-foreground">MCP policy · the run is paused · {remainingLabel(request.expiresAt, now)}</span>
          </div>
          {request.message ? (
            <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">{request.message}</p>
          ) : null}
        </div>
      </div>
      {preview ? (
        <pre className="mt-2.5 max-h-48 overflow-auto rounded-xl border border-border/60 bg-background/80 px-3 py-2 text-[11px] leading-relaxed">
          {preview}
        </pre>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-testid={TID.runConfirmOnce}
          className="h-8 rounded-full"
          disabled={busy !== null}
          onClick={() => void answer("accept")}
        >
          {busy === "accept" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Run once
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid={TID.runConfirmAlways}
          className="h-8 rounded-full border-border"
          disabled={busy !== null}
          onClick={() => void answer("always")}
        >
          {busy === "always" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Always allow in this chat
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid={TID.runConfirmDecline}
          className="h-8 rounded-full text-muted-foreground"
          disabled={busy !== null}
          onClick={() => void answer("decline")}
        >
          Decline
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">Secrets in the arguments are masked; the decision is journaled.</span>
      </div>
    </div>
  );
}

/** MCP elicitation form card. */
function ElicitationCard({ request, conversationId }: { request: RunPauseRequest; conversationId: string }) {
  const [values, setValues] = useState<Record<string, FieldValue>>(() => initialValues(request.fields));
  const [busy, setBusy] = useState<RunPauseAnswer["action"] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState<boolean>(false);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const clientErrors = useMemo(() => localErrors(request.fields, values), [request.fields, values]);

  const answer = async (action: RunPauseAnswer["action"]) => {
    if (busy) {
      return;
    }
    if (action === "accept") {
      setTouched(true);
      if (clientErrors.length > 0) {
        setErrors(clientErrors);
        return;
      }
    }
    setBusy(action);
    try {
      const result = await answerRunPause(
        conversationId,
        request.id,
        action === "accept" ? { action, content: toContent(request.fields, values) } : { action },
      );
      if (!result.ok) {
        if (result.errors && result.errors.length > 0) {
          setErrors(result.errors);
        } else if (result.reason === "not_found" || result.reason === "not_running") {
          toast.message("This question was already answered or the run has moved on.");
        } else {
          toast.error("Could not send the answer", { description: result.reason ?? "unknown error" });
        }
      } else {
        setErrors([]);
      }
    } catch (error) {
      toast.error("Could not send the answer", { description: errorFromUnknown(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid={TID.runPauseCard}
      className="mb-3 rounded-2xl border border-ember/40 bg-[linear-gradient(180deg,hsl(var(--ember)/0.08),transparent_70%)] p-3 shadow-sm"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-ember/15 text-ember">
          <MessageSquareWarning className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium">{request.serverName} needs your input</span>
            <span className="text-[11px] text-muted-foreground">MCP · the run is paused · {remainingLabel(request.expiresAt, now)}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{request.message}</p>
        </div>
      </div>
      {request.fields.length > 0 ? (
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          {request.fields.map((field) => {
            const label = field.title ?? field.name;
            const value = values[field.name];
            const invalid = touched && field.required && field.type !== "boolean" && !(typeof value === "string" && value.trim());
            return (
              <label key={field.name} className={cn("block space-y-1 text-xs", field.type === "boolean" && "sm:col-span-2")}>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground">{field.required ? "required" : "optional"}</span>
                </span>
                {field.description ? <span className="block text-[11px] text-muted-foreground">{field.description}</span> : null}
                {field.type === "boolean" ? (
                  <span className="flex items-center gap-2 pt-0.5">
                    <Switch
                      data-testid={runPauseFieldTid(field.name)}
                      checked={value === true}
                      onCheckedChange={(checked) => setValues((prev) => ({ ...prev, [field.name]: checked }))}
                    />
                    <span className="text-[11px] text-muted-foreground">{value === true ? "Yes" : "No"}</span>
                  </span>
                ) : field.enum && field.enum.length > 0 ? (
                  <Select
                    value={typeof value === "string" ? value : ""}
                    onValueChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
                  >
                    <SelectTrigger data-testid={runPauseFieldTid(field.name)} className={cn("h-9 border-border bg-white text-sm", invalid && "border-destructive")}>
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                      {field.enum.map((option, index) => (
                        <SelectItem key={option} value={option} className="text-sm">
                          {field.enumLabels?.[index] ?? option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    data-testid={runPauseFieldTid(field.name)}
                    type={field.type === "number" || field.type === "integer" ? "number" : field.format === "email" ? "email" : field.format === "date" ? "date" : "text"}
                    inputMode={field.type === "number" || field.type === "integer" ? "decimal" : undefined}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
                    className={cn("h-9 border-border bg-white text-sm", invalid && "border-destructive")}
                  />
                )}
              </label>
            );
          })}
        </div>
      ) : null}
      {errors.length > 0 ? <p className="mt-2 text-[11px] text-destructive">{errors.join(" · ")}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-testid={TID.runPauseAccept}
          className="h-8 rounded-full"
          disabled={busy !== null}
          onClick={() => void answer("accept")}
        >
          {busy === "accept" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {request.fields.length > 0 ? "Send answer" : "Accept"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid={TID.runPauseDecline}
          className="h-8 rounded-full border-border"
          disabled={busy !== null}
          onClick={() => void answer("decline")}
        >
          Decline
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 rounded-full text-muted-foreground"
          disabled={busy !== null}
          onClick={() => void answer("cancel")}
        >
          Cancel
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">Your answer goes only to {request.serverName}.</span>
      </div>
    </div>
  );
}
