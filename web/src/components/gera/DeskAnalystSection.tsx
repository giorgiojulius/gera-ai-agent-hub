import { useMutation } from "@tanstack/react-query";
import { ArrowUp, BrainCircuit, Loader2, RotateCcw } from "lucide-react";
import { memo, useCallback, useState, type FormEvent, type KeyboardEvent } from "react";

import { MarkdownBody } from "@/components/gera/Markdown";
import { askDeskAnalyst, type DeskAnalystTurn, type DeskStatsRange } from "@/lib/projects";
import { TID } from "@/lib/testids";
import { cn } from "@/lib/utils";

type AnalystMessage = DeskAnalystTurn & { modelId?: string; basis?: string };

/** Ready-made deep-analysis questions; the analyst answers in the question's language. */
export const ANALYST_PRESETS: Array<{ id: string; label: string; question: string }> = [
  {
    id: "exec",
    label: "Executive summary",
    question:
      "Give me an executive summary of team performance for this range: the 3 most important findings, the biggest risk, and the top 3 actions with an owner and a measurable target.",
  },
  {
    id: "coach",
    label: "Who needs coaching",
    question:
      "Rank teammates by who needs coaching most. For each: the recurring failure pattern from the grade reasons, a real reply snippet that shows it, and one concrete behavior to practice.",
  },
  {
    id: "rootcause",
    label: "Why replies fail",
    question:
      "Cluster the bad replies into root-cause categories (missed context, wrong facts, slow, canned tone, no next step…). Show counts per category as a chart and which teammates each category hits.",
  },
  {
    id: "sla",
    label: "Speed & SLA",
    question:
      "Analyze reply speed: median, p90, share within 1 hour per teammate, the worst hours and weekdays from the load heatmap, and whether slow replies are also graded worse. Suggest staffing changes.",
  },
  {
    id: "trend",
    label: "Trend & forecast",
    question:
      "How are volume, quality and speed trending week over week? Is anything getting worse? Chart it and say what to expect next week if nothing changes.",
  },
  {
    id: "best",
    label: "Best practices",
    question:
      "Which teammate replies are the strongest examples? Extract a short playbook of what the best replies do differently, with real snippets the team can copy.",
  },
];

/**
 * "Ask the analyst" — a chat over the desk's harvested replies, grades,
 * coaching and the transcripts behind bad replies, answered by the newest
 * Opus at xhigh effort. Follow-ups keep the thread; nothing is stored.
 */
export const DeskAnalystSection = memo(function DeskAnalystSection({
  projectId,
  screenId,
  range,
}: {
  projectId: string;
  screenId: string;
  range: DeskStatsRange;
}) {
  const [messages, setMessages] = useState<AnalystMessage[]>([]);
  const [draft, setDraft] = useState<string>("");
  const ask = useMutation({
    mutationFn: (input: { question: string; history: DeskAnalystTurn[] }) =>
      askDeskAnalyst(projectId, { screenId, question: input.question, history: input.history, range }),
  });

  const send = useCallback(
    (question: string) => {
      const text = question.trim();
      if (!text || ask.isPending) {
        return;
      }
      // History is the thread BEFORE this question — the question itself travels separately.
      const history = messages.map((message) => ({ role: message.role, content: message.content }));
      setDraft("");
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      ask.mutate({ question: text, history }, {
        onSuccess: (result) => {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: result.answer,
              modelId: result.modelId,
              basis: `${result.basis.replies} replies · ${result.basis.graded} graded · ${result.basis.transcripts} transcripts`,
            },
          ]);
        },
        onError: () => {
          // Drop the unanswered question so a retry does not duplicate it in history.
          setMessages((prev) => prev.slice(0, -1));
          setDraft(text);
        },
      });
    },
    [ask, messages],
  );

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    send(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(draft);
    }
  };

  return (
    <section
      className="mb-3 overflow-hidden rounded-2xl border border-ember/30 bg-gradient-to-b from-ember/[0.06] to-card"
      data-testid={TID.screenDeskAnalyst}
    >
      <div className="flex items-center gap-2 px-3.5 pt-3.5">
        <BrainCircuit className="h-4 w-4 text-ember" />
        <p className="text-xs font-semibold">Ask the analyst</p>
        <span className="rounded-full border border-ember/30 bg-ember/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ember">
          Opus · xhigh
        </span>
        {messages.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setMessages([]);
              ask.reset();
            }}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" />
            New thread
          </button>
        ) : null}
      </div>
      <p className="px-3.5 pt-1 text-[11px] leading-relaxed text-muted-foreground">
        Ask anything about this range — it reads every collected reply, grade reason, coaching note and the
        transcripts behind bad replies, then answers with real numbers and charts.
      </p>

      <div className="flex flex-wrap gap-1.5 px-3.5 pt-2.5">
        {ANALYST_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            disabled={ask.isPending}
            onClick={() => send(preset.question)}
            data-testid={TID.screenDeskAnalystPreset}
            className="rounded-full border border-border/70 bg-card px-2.5 py-1 text-[11px] font-medium transition-all hover:border-ember/50 hover:text-ember active:scale-95 disabled:opacity-50"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {messages.length > 0 ? (
        <div className="mt-3 space-y-2.5 px-3.5">
          {messages.map((message, index) =>
            message.role === "user" ? (
              <div key={index} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-foreground px-3 py-2 text-[12px] leading-relaxed text-background">
                  {message.content}
                </p>
              </div>
            ) : (
              <div
                key={index}
                className="rounded-2xl rounded-bl-md border border-border/60 bg-background px-3 py-2.5"
                data-testid={TID.screenDeskAnalystAnswer}
              >
                <MarkdownBody text={message.content} className="text-[12.5px]" />
                {message.modelId ? (
                  <p className="mt-2 border-t border-border/50 pt-1.5 text-[9.5px] text-muted-foreground">
                    {message.modelId} · xhigh · {message.basis}
                  </p>
                ) : null}
              </div>
            ),
          )}
          {ask.isPending ? (
            <div className="flex items-center gap-2 rounded-2xl border border-dashed border-ember/40 px-3 py-2.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-ember" />
              Opus is reasoning over the data — deep answers can take a minute or two.
            </div>
          ) : null}
        </div>
      ) : null}

      {ask.isError ? (
        <p className="mx-3.5 mt-3 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-600">
          {ask.error instanceof Error ? ask.error.message : "The analyst could not answer."}
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="m-3.5 flex items-end gap-2 rounded-xl border border-border/70 bg-card p-1.5 focus-within:border-ember/50">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          maxLength={2000}
          placeholder="e.g. Why did quality drop last week? Who is slowest at night?"
          aria-label="Ask the analyst"
          data-testid={TID.screenDeskAnalystInput}
          className="max-h-32 min-h-[32px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/70"
        />
        <button
          type="submit"
          disabled={!draft.trim() || ask.isPending}
          aria-label="Send question"
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ember text-white transition-all active:scale-90",
            "disabled:opacity-40",
          )}
        >
          {ask.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </form>
    </section>
  );
});
