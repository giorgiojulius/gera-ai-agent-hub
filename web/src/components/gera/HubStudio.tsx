import {
  Brain,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Pencil,
  Plus,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAgent } from "@/hooks/use-agent";
import { CHART_COLORS } from "@/lib/artifacts";
import {
  addMemory,
  addTask,
  addTracker,
  dailyTotals,
  dayKey,
  formatValue,
  formatWhen,
  logEntry,
  removeEntry,
  removeMemory,
  removeTask,
  removeTracker,
  toggleTask,
  updateTracker,
} from "@/lib/life";
import type { LifeState, PersonalTask, Tracker, TrackerKind } from "@/lib/types";
import { cn } from "@/lib/utils";

type HubTab = "trackers" | "tasks" | "memory";
type UpdateLife = (updater: (prev: LifeState) => LifeState) => void;

function parseInput(value: string): number | null {
  const cleaned = value.trim().replace(",", ".");
  if (!cleaned) {
    return null;
  }
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5",
        danger ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="rounded-2xl border border-dashed border-border/80 bg-card/50 px-4 py-5 text-center text-xs leading-relaxed text-muted-foreground">
      {text}
    </p>
  );
}

/** Personal hub page content: memory, custom trackers, and tasks the agent keeps. */
export function HubStudio() {
  const { state, updateLife } = useAgent();
  const life = state.life;
  // The active hub tab lives in the address (?tab=tasks|memory).
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab: HubTab = rawTab === "tasks" || rawTab === "memory" ? rawTab : "trackers";
  const setTab = (next: HubTab) => {
    setSearchParams(next === "trackers" ? {} : { tab: next });
  };

  const openCount = useMemo(() => life.tasks.filter((task) => !task.done).length, [life.tasks]);
  const tabs: { id: HubTab; label: string; count: number }[] = [
    { id: "trackers", label: "Trackers", count: life.trackers.length },
    { id: "tasks", label: "Tasks", count: openCount },
    { id: "memory", label: "Memory", count: life.memories.length },
  ];

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid w-full grid-cols-3 gap-1 rounded-xl border border-border/70 bg-secondary/50 p-1 sm:w-auto sm:min-w-[340px]">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                tab === item.id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              {item.count > 0 ? (
                <span className="rounded-full bg-foreground/5 px-1.5 text-[10px] tabular-nums text-muted-foreground">
                  {item.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <label className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-3 py-2 sm:max-w-md">
          <span className="text-xs">
            <span className="font-medium">Share with agent</span>
            <span className="block text-muted-foreground">
              {life.shareWithAgent
                ? "Gera reads this hub every turn and saves from chat"
                : "Private — Gera can't see or update the hub"}
            </span>
          </span>
          <Switch
            checked={life.shareWithAgent}
            onCheckedChange={(checked) => updateLife((prev) => ({ ...prev, shareWithAgent: checked }))}
          />
        </label>
      </div>

      <div className="mt-5">
        {tab === "trackers" ? <TrackersSection life={life} updateLife={updateLife} /> : null}
        {tab === "tasks" ? <TasksSection life={life} updateLife={updateLife} /> : null}
        {tab === "memory" ? <MemorySection life={life} updateLife={updateLife} /> : null}
        <p className="mt-6 max-w-2xl text-[11px] leading-relaxed text-muted-foreground/80">
          Saved locally in this browser. Every agent write shows up in chat as a “Personal hub updated” card,
          so you can audit and undo anything here.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- trackers

function TrackersSection({ life, updateLife }: { life: LifeState; updateLife: UpdateLife }) {
  const [formOpen, setFormOpen] = useState<boolean>(false);
  return (
    <div className="space-y-3">
      {formOpen ? (
        <div className="max-w-xl">
          <NewTrackerForm
            onCancel={() => setFormOpen(false)}
            onCreate={(input) => {
              updateLife((prev) => addTracker(prev, input));
              setFormOpen(false);
            }}
          />
        </div>
      ) : (
        <Button
          variant="outline"
          className="w-full justify-center gap-2 rounded-xl border-dashed bg-card/50 sm:w-auto sm:px-8"
          onClick={() => setFormOpen(true)}
        >
          <Plus className="h-4 w-4" /> New tracker
        </Button>
      )}
      {life.trackers.length === 0 && !formOpen ? (
        <div className="max-w-2xl">
          <EmptyHint text="Nothing tracked yet. Just tell Gera in chat — “drank 2 glasses of water”, “spent 1500 ₽ on groceries”, “weight 82.4” — and trackers appear here automatically." />
        </div>
      ) : null}
      <div className="grid items-start gap-3 md:grid-cols-2">
        {life.trackers.map((tracker) => (
          <TrackerCard key={tracker.id} tracker={tracker} life={life} updateLife={updateLife} />
        ))}
      </div>
    </div>
  );
}

function NewTrackerForm({
  onCreate,
  onCancel,
}: {
  onCreate: (input: { name: string; unit: string; kind: TrackerKind; goal: number | null }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState<string>("");
  const [unit, setUnit] = useState<string>("");
  const [goal, setGoal] = useState<string>("");
  const [kind, setKind] = useState<TrackerKind>("number");
  const canSave = name.trim().length > 0;

  return (
    <div className="space-y-2.5 rounded-2xl border border-border/80 bg-card p-3.5 shadow-sm">
      <p className="text-xs font-medium">New tracker</p>
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name — Water, Spending, Weight…"
        className="h-9 rounded-xl"
      />
      <div className="flex gap-1.5">
        {(["number", "check"] as TrackerKind[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setKind(item)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              kind === item
                ? "border-ember bg-ember/10 font-medium text-ember"
                : "border-border/70 text-muted-foreground hover:text-foreground",
            )}
          >
            {item === "number" ? "Amount" : "Yes / no"}
          </button>
        ))}
      </div>
      {kind === "number" ? (
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            placeholder="Unit — glasses, ₽, kg"
            className="h-9 rounded-xl"
          />
          <Input
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Daily goal (optional)"
            inputMode="decimal"
            className="h-9 rounded-xl"
          />
        </div>
      ) : null}
      <div className="flex justify-end gap-1.5 pt-0.5">
        <Button variant="ghost" className="h-8 rounded-xl px-3 text-xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          className="h-8 rounded-xl bg-ember px-3.5 text-xs text-ember-foreground hover:bg-ember/90"
          disabled={!canSave}
          onClick={() =>
            onCreate({
              name: name.trim(),
              unit: kind === "check" ? "" : unit.trim(),
              kind,
              goal: kind === "check" ? null : parseInput(goal),
            })
          }
        >
          Add tracker
        </Button>
      </div>
    </div>
  );
}

function TrackerCard({
  tracker,
  life,
  updateLife,
}: {
  tracker: Tracker;
  life: LifeState;
  updateLife: UpdateLife;
}) {
  const [editing, setEditing] = useState<boolean>(false);
  const [logInput, setLogInput] = useState<string>("");
  const color = CHART_COLORS[tracker.color % CHART_COLORS.length];
  const totals = useMemo(() => dailyTotals(life.entries, tracker.id, 14), [life.entries, tracker.id]);
  const today = totals[totals.length - 1]?.total ?? 0;
  const recent = useMemo(
    () => life.entries.filter((entry) => entry.trackerId === tracker.id).slice(-4).reverse(),
    [life.entries, tracker.id],
  );
  const doneToday = tracker.kind === "check" && today > 0;
  const progress = tracker.goal !== null && tracker.goal > 0 ? Math.min(100, (today / tracker.goal) * 100) : null;

  const log = () => {
    const value = parseInput(logInput) ?? 1;
    updateLife((prev) => logEntry(prev, tracker.id, value));
    setLogInput("");
  };

  const markToday = () => {
    if (doneToday) {
      const todayKey = dayKey(Date.now());
      updateLife((prev) => ({
        ...prev,
        entries: prev.entries.filter(
          (entry) => !(entry.trackerId === tracker.id && dayKey(entry.at) === todayKey),
        ),
      }));
    } else {
      updateLife((prev) => logEntry(prev, tracker.id, 1));
    }
  };

  const remove = () => {
    if (window.confirm(`Delete “${tracker.name}” and all its entries?`)) {
      updateLife((prev) => removeTracker(prev, tracker.id));
    }
  };

  return (
    <div className="rounded-2xl border border-border/80 bg-card p-3.5 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="min-w-0 truncate text-sm font-medium">{tracker.name}</span>
        {tracker.unit ? (
          <span className="shrink-0 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {tracker.unit}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton icon={Pencil} label="Edit" onClick={() => setEditing((value) => !value)} />
          <IconButton icon={Trash2} label="Delete" danger onClick={remove} />
        </div>
      </div>

      {editing ? (
        <TrackerEditForm tracker={tracker} updateLife={updateLife} onClose={() => setEditing(false)} />
      ) : (
        <>
          <div className="mt-2 flex items-baseline justify-between text-xs text-muted-foreground">
            <span>
              Today: <span className="font-semibold text-foreground">{formatValue(today)}</span>
              {tracker.goal !== null ? ` / ${formatValue(tracker.goal)}` : ""}
              {tracker.unit ? ` ${tracker.unit}` : ""}
            </span>
            <span>14 days</span>
          </div>
          {progress !== null ? (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progress}%`, backgroundColor: color }}
              />
            </div>
          ) : null}
          <Sparkline totals={totals} color={color} />

          {tracker.kind === "check" ? (
            <Button
              variant={doneToday ? "secondary" : "outline"}
              className="mt-2.5 h-8 w-full gap-1.5 rounded-xl text-xs"
              onClick={markToday}
            >
              {doneToday ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" /> Done today — tap to undo
                </>
              ) : (
                "Mark today"
              )}
            </Button>
          ) : (
            <div className="mt-2.5 flex gap-1.5">
              <Input
                value={logInput}
                onChange={(event) => setLogInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    log();
                  }
                }}
                placeholder={`+1${tracker.unit ? ` ${tracker.unit}` : ""}`}
                inputMode="decimal"
                className="h-8 rounded-xl text-xs"
              />
              <Button
                className="h-8 shrink-0 rounded-xl bg-ember px-3.5 text-xs text-ember-foreground hover:bg-ember/90"
                onClick={log}
              >
                Log
              </Button>
            </div>
          )}

          {recent.length > 0 ? (
            <div className="mt-2.5 space-y-1 border-t border-border/60 pt-2">
              {recent.map((entry) => (
                <div key={entry.id} className="group flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="shrink-0 tabular-nums">
                    {new Date(entry.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                  <span className="shrink-0 font-medium text-foreground">
                    {formatValue(entry.value)}
                    {tracker.unit ? ` ${tracker.unit}` : ""}
                  </span>
                  {entry.note ? <span className="min-w-0 truncate">· {entry.note}</span> : null}
                  <button
                    type="button"
                    aria-label="Delete entry"
                    onClick={() => updateLife((prev) => removeEntry(prev, entry.id))}
                    className="ml-auto shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function TrackerEditForm({
  tracker,
  updateLife,
  onClose,
}: {
  tracker: Tracker;
  updateLife: UpdateLife;
  onClose: () => void;
}) {
  const [name, setName] = useState<string>(tracker.name);
  const [unit, setUnit] = useState<string>(tracker.unit);
  const [goal, setGoal] = useState<string>(tracker.goal !== null ? String(tracker.goal) : "");

  const save = () => {
    const trimmed = name.trim();
    updateLife((prev) =>
      updateTracker(prev, tracker.id, {
        name: trimmed || tracker.name,
        unit: unit.trim(),
        goal: parseInput(goal),
      }),
    );
    onClose();
  };

  return (
    <div className="mt-2.5 space-y-2">
      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" className="h-8 rounded-xl text-xs" />
      <div className="grid grid-cols-2 gap-2">
        <Input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="Unit" className="h-8 rounded-xl text-xs" />
        <Input
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="Daily goal"
          inputMode="decimal"
          className="h-8 rounded-xl text-xs"
        />
      </div>
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" className="h-7 rounded-lg px-2.5 text-xs" onClick={onClose}>
          Cancel
        </Button>
        <Button className="h-7 rounded-lg bg-ember px-3 text-xs text-ember-foreground hover:bg-ember/90" onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

function Sparkline({ totals, color }: { totals: { day: string; total: number }[]; color: string }) {
  const max = Math.max(1, ...totals.map((item) => item.total));
  return (
    <div className="mt-2 flex h-9 items-end gap-[3px]">
      {totals.map((item) => (
        <div
          key={item.day}
          title={`${item.day}: ${formatValue(item.total)}`}
          className="flex-1 rounded-[3px]"
          style={{
            height: `${item.total > 0 ? Math.max(14, (item.total / max) * 100) : 6}%`,
            backgroundColor: item.total > 0 ? color : "rgba(35, 20, 28, 0.08)",
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- tasks

function TasksSection({ life, updateLife }: { life: LifeState; updateLife: UpdateLife }) {
  const [text, setText] = useState<string>("");
  const [due, setDue] = useState<string>("");
  const [showDone, setShowDone] = useState<boolean>(false);

  const open = useMemo(
    () =>
      life.tasks
        .filter((task) => !task.done)
        .sort(
          (a, b) =>
            (a.due ?? Number.MAX_SAFE_INTEGER) - (b.due ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt,
        ),
    [life.tasks],
  );
  const done = useMemo(
    () =>
      life.tasks
        .filter((task) => task.done)
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
        .slice(0, 30),
    [life.tasks],
  );

  const add = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const ts = due ? new Date(due).getTime() : Number.NaN;
    updateLife((prev) => addTask(prev, trimmed, Number.isFinite(ts) ? ts : null));
    setText("");
    setDue("");
  };

  return (
    <div className="max-w-2xl space-y-3">
      <div className="space-y-2 rounded-2xl border border-border/80 bg-card p-3 shadow-sm">
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              add();
            }
          }}
          placeholder="Add a task — “Call the bank”…"
          className="h-9 rounded-xl"
        />
        <div className="flex gap-1.5">
          <Input
            type="datetime-local"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            className="h-8 rounded-xl text-xs"
          />
          <Button
            className="h-8 shrink-0 rounded-xl bg-ember px-3.5 text-xs text-ember-foreground hover:bg-ember/90"
            disabled={!text.trim()}
            onClick={add}
          >
            Add
          </Button>
        </div>
      </div>

      {open.length === 0 && done.length === 0 ? (
        <EmptyHint text="No tasks. Ask Gera to “remind me to…” in any thread, or add one here — due dates included." />
      ) : null}

      <div className="space-y-1.5">
        {open.map((task) => (
          <TaskRow key={task.id} task={task} updateLife={updateLife} />
        ))}
      </div>

      {done.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setShowDone((value) => !value)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showDone ? "" : "-rotate-90")} />
            Completed ({done.length})
          </button>
          {showDone ? (
            <div className="mt-1.5 space-y-1.5">
              {done.map((task) => (
                <TaskRow key={task.id} task={task} updateLife={updateLife} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({ task, updateLife }: { task: PersonalTask; updateLife: UpdateLife }) {
  const overdue = !task.done && task.due !== null && task.due < Date.now();
  return (
    <div className="group flex items-start gap-2.5 rounded-xl border border-border/70 bg-card px-3 py-2.5">
      <button
        type="button"
        onClick={() => updateLife((prev) => toggleTask(prev, task.id))}
        className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-ember"
        aria-label={task.done ? "Reopen task" : "Complete task"}
      >
        {task.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm leading-snug", task.done && "text-muted-foreground line-through")}>{task.text}</p>
        {task.due !== null ? (
          <p
            className={cn(
              "mt-0.5 flex items-center gap-1 text-[11px]",
              overdue ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            <CalendarClock className="h-3 w-3" />
            {formatWhen(task.due)}
            {overdue ? " · overdue" : ""}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Delete task"
        onClick={() => updateLife((prev) => removeTask(prev, task.id))}
        className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- memory

function MemorySection({ life, updateLife }: { life: LifeState; updateLife: UpdateLife }) {
  const [text, setText] = useState<string>("");

  const add = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    updateLife((prev) => addMemory(prev, trimmed));
    setText("");
  };

  return (
    <div className="max-w-2xl space-y-3">
      <label className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-3 py-2.5">
        <span className="text-xs">
          <span className="font-medium">Memory</span>
          <span className="block text-muted-foreground">
            {life.memoryEnabled
              ? "Gera saves new facts from chat and uses them in replies"
              : "Off — Gera won't save new facts or use saved ones"}
          </span>
        </span>
        <Switch
          checked={life.memoryEnabled}
          onCheckedChange={(checked) => updateLife((prev) => ({ ...prev, memoryEnabled: checked }))}
        />
      </label>
      <div className="flex gap-1.5">
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              add();
            }
          }}
          placeholder="A fact Gera should always remember…"
          className="h-9 rounded-xl"
        />
        <Button
          className="h-9 shrink-0 rounded-xl bg-ember px-3.5 text-xs text-ember-foreground hover:bg-ember/90"
          disabled={!text.trim()}
          onClick={add}
        >
          Add
        </Button>
      </div>

      {life.memories.length === 0 ? (
        <EmptyHint text="Empty so far. Share preferences and facts in chat — “remember I'm vegetarian” — and Gera keeps them in mind in every reply." />
      ) : null}

      <div className="space-y-1.5">
        {life.memories.map((memory) => (
          <div key={memory.id} className="group flex items-start gap-2.5 rounded-xl border border-border/70 bg-card px-3 py-2.5">
            <Brain className="mt-0.5 h-4 w-4 shrink-0 text-ember/70" />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug">{memory.text}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {memory.category ? (
                  <span className="rounded-full bg-foreground/5 px-1.5 py-px">{memory.category}</span>
                ) : null}
                {new Date(memory.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </p>
            </div>
            <button
              type="button"
              aria-label="Forget"
              onClick={() => updateLife((prev) => removeMemory(prev, memory.id))}
              className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
