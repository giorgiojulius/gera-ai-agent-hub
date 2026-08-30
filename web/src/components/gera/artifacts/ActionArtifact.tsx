import {
  Brain,
  CheckCircle2,
  CirclePlus,
  ListPlus,
  NotebookPen,
  Trash2,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { memo, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { describeOp, parseLifeOps, type OpChipKind } from "@/lib/life";
import { describeSkillOp, parseSkillOps } from "@/lib/skill-ops";
import { cn } from "@/lib/utils";

import { CodeBlock } from "./CodeBlock";

const CHIP_ICONS: Record<OpChipKind, LucideIcon> = {
  memory: Brain,
  log: TrendingUp,
  create: CirclePlus,
  task: ListPlus,
  done: CheckCircle2,
  delete: Trash2,
};

const CHIP_TONES: Record<OpChipKind, string> = {
  memory: "text-ember",
  log: "text-ember",
  create: "text-ember",
  task: "text-foreground",
  done: "text-emerald-600",
  delete: "text-destructive",
};

/**
 * Renders a ```action fence as an audit trail of agent writes: personal hub
 * ops (memory, tracker logs, tasks) and skill edits. Purely presentational —
 * the ops are applied once by the send pipeline, so re-renders and reloads
 * never double-write.
 */
export const ActionArtifact = memo(function ActionArtifact({ code, streaming }: { code: string; streaming: boolean }) {
  const navigate = useNavigate();
  const { chips, skillsOnly } = useMemo(() => {
    const life = parseLifeOps(code).map(describeOp);
    const skills = parseSkillOps(code).map(describeSkillOp);
    return { chips: [...life, ...skills], skillsOnly: life.length === 0 && skills.length > 0 };
  }, [code]);

  if (chips.length === 0) {
    if (streaming) {
      return (
        <div className="my-3 flex items-center gap-2 rounded-2xl border border-border/80 bg-card px-3.5 py-2.5 shadow-sm">
          <NotebookPen className="h-3.5 w-3.5 animate-pulse text-ember" />
          <span className="text-xs text-muted-foreground">Saving changes…</span>
        </div>
      );
    }
    return <CodeBlock code={code} language="json" />;
  }

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/70 bg-foreground/[0.03] px-3.5 py-2">
        <NotebookPen className="h-3.5 w-3.5 shrink-0 text-ember" />
        <span className="text-xs font-medium">{skillsOnly ? "Skills updated" : "Personal hub updated"}</span>
        <button
          type="button"
          onClick={() => navigate(skillsOnly ? "/skills" : "/hub")}
          className="ml-auto shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-ember transition-colors hover:bg-ember/10"
        >
          {skillsOnly ? "Open skills" : "Open hub"}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3.5 py-3">
        {chips.map((chip, index) => {
          const Icon = CHIP_ICONS[chip.kind];
          return (
            <span
              key={index}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs"
            >
              <Icon className={cn("h-3 w-3 shrink-0", CHIP_TONES[chip.kind])} />
              <span className="truncate">{chip.label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
});
