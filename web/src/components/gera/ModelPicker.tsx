import { Check, ChevronLeft, ChevronRight, ChevronsUpDown, RotateCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAgent } from "@/hooks/use-agent";
import {
  DEFAULT_CHAT_MODEL,
  MODE_LABEL,
  REASONING_EFFORTS,
  type ReasoningEffort,
  chatBaseModels,
  costTierLabel,
  effortLabel,
  formatContext,
  formatModelCost,
  formatModelCostDetail,
  modelCostTier,
  modelIdForMode,
  modelsForMode,
  parseModelSelection,
  providerLabel,
  withEffort,
} from "@/lib/models";
import { TID, effortOptionTid, modelOptionTid } from "@/lib/testids";
import type { CostTier, GatewayModel } from "@/lib/types";
import { cn } from "@/lib/utils";

const TIER_CLASS: Record<CostTier, string> = {
  value: "bg-emerald-600/10 text-emerald-700",
  standard: "bg-foreground/5 text-muted-foreground",
  premium: "bg-ember/10 text-ember",
  flagship: "bg-gold/15 text-gold",
};

/** Honest budget hints — how much silent thinking the gateway asks the model for. */
const EFFORT_HINTS: Record<ReasoningEffort, string> = {
  low: "Minimal thinking — fastest replies",
  medium: "Balanced thinking",
  high: "Deeper thinking on hard steps",
  xhigh: "Maximum thinking budget",
};

type PickerView = "root" | "model" | "effort";

/**
 * Compact model selector in the composer's bottom rail. Chat mode opens a
 * Cursor-style root menu — Model and Effort rows with submenus plus Reset to
 * default; media modes go straight to their flat catalog. Model and effort are
 * orthogonal: switching one keeps the other.
 */
export function ModelPicker() {
  const { models, modelsLoading, state, setModelId, activeModel, mode } = useAgent();
  const [open, setOpen] = useState<boolean>(false);
  const [view, setView] = useState<PickerView>("root");
  const [query, setQuery] = useState<string>("");

  const isChat = mode === "chat";
  const selectedId = modelIdForMode(state.settings, mode);
  const selection = parseModelSelection(selectedId);
  const baseModel = useMemo(
    () => models.find((model) => model.id === selection.catalogId),
    [models, selection.catalogId],
  );

  const catalog = useMemo(
    () => (isChat ? chatBaseModels(models) : modelsForMode(models, mode)),
    [models, mode, isChat],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? catalog.filter((model) => matchesQuery(model, q)) : catalog;
  }, [catalog, query]);

  const activeCost = activeModel ? formatModelCost(activeModel) : "";
  const triggerName = isChat ? baseModel?.name ?? selection.catalogId : activeModel?.name ?? selectedId;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setView(isChat ? "root" : "model");
      setQuery("");
    }
  };

  const pickModel = (model: GatewayModel) => {
    setModelId(isChat ? withEffort(model.id, selection.reasoningEffort) : model.id);
    setOpen(false);
  };

  const pickEffort = (effort?: ReasoningEffort) => {
    setModelId(withEffort(selection.catalogId, effort));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={TID.modelPickerTrigger}
          title={activeModel ? formatModelCostDetail(activeModel) : `Choose ${MODE_LABEL[mode].toLowerCase()} model`}
          className="flex h-8 min-w-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground"
        >
          <span className="max-w-[8.5rem] truncate sm:max-w-[14rem]">{triggerName}</span>
          {isChat && selection.reasoningEffort ? (
            <span className="hidden shrink-0 text-muted-foreground/70 sm:inline">
              {effortLabel(selection.reasoningEffort)}
            </span>
          ) : null}
          {activeCost ? (
            <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground/70 md:inline">{activeCost}</span>
          ) : null}
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        className={cn(
          "flex max-h-[min(70vh,var(--radix-popover-content-available-height))] flex-col overflow-hidden rounded-2xl border-border bg-popover p-0 shadow-2xl",
          view === "model" ? "w-[min(92vw,30rem)]" : "w-[min(92vw,18rem)]",
        )}
      >
        {view === "root" ? (
          <div className="overflow-y-auto p-1.5">
            <button
              type="button"
              data-testid={TID.modelPickerModelRow}
              onClick={() => setView("model")}
              className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-foreground/5"
            >
              <span>Model</span>
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className="max-w-[10rem] truncate">{triggerName}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </span>
            </button>
            <button
              type="button"
              data-testid={TID.modelPickerEffortRow}
              onClick={() => setView("effort")}
              className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-foreground/5"
            >
              <span>Effort</span>
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className="truncate">
                  {selection.reasoningEffort ? effortLabel(selection.reasoningEffort) : "Default"}
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </span>
            </button>
            <div className="mx-2 my-1.5 h-px bg-border/70" />
            <button
              type="button"
              data-testid={TID.modelPickerReset}
              onClick={() => {
                setModelId(DEFAULT_CHAT_MODEL);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <span>Reset to default</span>
              <RotateCcw className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </button>
          </div>
        ) : null}

        {view === "effort" ? (
          <div className="overflow-y-auto p-1.5">
            <BackHeader label="Effort" onBack={() => setView("root")} />
            {[
              { effort: undefined, label: "Default", hint: "The model's own thinking budget" },
              ...REASONING_EFFORTS.map((effort) => ({
                effort,
                label: effortLabel(effort),
                hint: EFFORT_HINTS[effort],
              })),
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                data-testid={effortOptionTid(option.effort ?? "default")}
                onClick={() => pickEffort(option.effort)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-foreground/5",
                  selection.reasoningEffort === option.effort && "bg-ember/10",
                )}
              >
                <Check
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    selection.reasoningEffort === option.effort ? "text-ember" : "opacity-0",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{option.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{option.hint}</span>
                </span>
              </button>
            ))}
            <p className="px-2.5 pb-1.5 pt-2 text-[10px] leading-relaxed text-muted-foreground">
              Thinking tokens bill as output; models without adjustable reasoning ignore this.
            </p>
          </div>
        ) : null}

        {view === "model" ? (
          <>
            {isChat ? (
              <div className="shrink-0 px-1.5 pt-1.5">
                <BackHeader label="Model" onBack={() => setView("root")} />
              </div>
            ) : null}
            <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${MODE_LABEL[mode].toLowerCase()} models…`}
                className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <p className="px-2 py-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {MODE_LABEL[mode]} models · {catalog.length} curated
              </p>
              {modelsLoading && catalog.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading catalog…</p>
              ) : null}
              {!modelsLoading && filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</p>
              ) : null}
              {filtered.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  selected={isChat ? model.id === selection.catalogId : model.id === selectedId}
                  onSelect={() => pickModel(model)}
                />
              ))}
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function BackHeader({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-1 flex w-full items-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
    >
      <ChevronLeft className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function matchesQuery(model: GatewayModel, query: string): boolean {
  const tier = modelCostTier(model);
  const haystack = [
    model.id,
    model.name,
    model.owned_by,
    formatModelCost(model),
    tier ? costTierLabel(tier) : "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: GatewayModel;
  selected: boolean;
  onSelect: () => void;
}) {
  const cost = formatModelCost(model);
  const tier = modelCostTier(model);
  const detail = formatModelCostDetail(model);
  const context = formatContext(model.context_window);

  return (
    <button
      type="button"
      data-testid={modelOptionTid(model.id)}
      onClick={onSelect}
      title={detail}
      className={cn(
        "flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-foreground/5",
        selected && "bg-ember/10",
      )}
    >
      <Check className={cn("h-3.5 w-3.5 shrink-0", selected ? "text-ember" : "opacity-0")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{model.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {providerLabel(model.owned_by)}
          {context ? ` · ${context}` : ""}
          {model.description ? ` · ${model.description}` : ""}
        </span>
      </span>
      {cost || tier ? (
        <span className="shrink-0 text-right">
          {tier ? (
            <span className={cn("inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider", TIER_CLASS[tier])}>
              {costTierLabel(tier)}
            </span>
          ) : null}
          {cost ? <span className="mt-0.5 block font-mono text-[10px] tabular-nums text-muted-foreground">{cost}</span> : null}
        </span>
      ) : null}
    </button>
  );
}
