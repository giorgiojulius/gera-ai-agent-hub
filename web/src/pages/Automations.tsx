import {
  ArrowLeft,
  ChevronDown,
  Cloud,
  Copy,
  Loader2,
  MessageCircle,
  Monitor,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import {
  EditorSaveBar,
  EditorSection,
  StudioPageHero,
  StudioPageShell,
} from "@/components/gera/StudioPageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgent } from "@/hooks/use-agent";
import { useAuth } from "@/hooks/use-auth";
import { chatPath } from "@/lib/nav";
import { TID } from "@/lib/testids";
import {
  AUTOMATION_TEMPLATES,
  INTERVAL_OPTIONS,
  WEEKDAYS,
  cloudMcpReadiness,
  describeSchedule,
  formatCountdown,
  newWebhookToken,
  requestCloudRunNow,
  webhookUrlFor,
  type AutomationDraftInput,
  type CloudMcpReadiness,
} from "@/lib/automations";
import { groupSkillsByFolder } from "@/lib/skills";
import type { Automation, AutomationCadence, AutomationRunOn, McpServerConfig, Skill } from "@/lib/types";
import { cn } from "@/lib/utils";

type Draft = {
  name: string;
  prompt: string;
  cadence: AutomationCadence;
  intervalMinutes: number;
  time: string;
  weekday: number;
  agentId: string;
  /** Cursor-style MCP scoping: null = all connected servers. */
  mcpServerIds: string[] | null;
  /** Per-automation skills scoping: null = all enabled skills. */
  skillIds: string[] | null;
  /** Incoming webhook trigger token; null = off. */
  webhookToken: string | null;
  deepResearch: boolean;
  catchUp: boolean;
  runOn: AutomationRunOn;
};

function emptyDraft(): Draft {
  return {
    name: "",
    prompt: "",
    cadence: "daily",
    intervalMinutes: 60,
    time: "09:00",
    weekday: 1,
    agentId: "",
    mcpServerIds: null,
    skillIds: null,
    webhookToken: null,
    deepResearch: false,
    catchUp: true,
    runOn: "server",
  };
}

function draftFromAutomation(automation: Automation): Draft {
  return {
    name: automation.name,
    prompt: automation.prompt,
    cadence: automation.cadence,
    intervalMinutes: automation.intervalMinutes,
    time: automation.time,
    weekday: automation.weekday,
    agentId: automation.agentId ?? "",
    mcpServerIds: automation.mcpServerIds ? [...automation.mcpServerIds] : null,
    skillIds: automation.skillIds ? [...automation.skillIds] : null,
    webhookToken: automation.webhookToken,
    deepResearch: automation.deepResearch,
    catchUp: automation.catchUp,
    runOn: automation.runOn,
  };
}

function draftToInput(draft: Draft, enabled: boolean): AutomationDraftInput {
  return {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    cadence: draft.cadence,
    intervalMinutes: draft.intervalMinutes,
    time: draft.time || "09:00",
    weekday: draft.weekday,
    agentId: draft.agentId || null,
    mcpServerIds: draft.mcpServerIds,
    skillIds: draft.skillIds,
    webhookToken: draft.webhookToken,
    // Cloud runs are plain agent + web tools — no multi-wave research there yet.
    deepResearch: draft.runOn === "server" ? false : draft.deepResearch,
    enabled,
    catchUp: draft.catchUp,
    runOn: draft.runOn,
    // Fresh capture on every save so daily/weekly cloud fires match local time.
    tzOffsetMinutes: new Date().getTimezoneOffset(),
  };
}

const CADENCES: { id: AutomationCadence; label: string }[] = [
  { id: "interval", label: "Every…" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
];

/** Full-page automations workspace: schedule list, templates, and a sectioned editor. */
export default function AutomationsPage() {
  const {
    state,
    agents,
    automations,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    runAutomationNow,
    selectChat,
  } = useAgent();
  const { user } = useAuth();
  const navigate = useNavigate();
  // The editor is URL-driven: /automations/new or /automations/<id>.
  const { automationId } = useParams<{ automationId?: string }>();
  const editingId: string | "new" | null = automationId ?? null;
  /** Which id the draft was last initialized for — survives list re-syncs. */
  const draftInitRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [now, setNow] = useState<number>(() => Date.now());
  const mcpServers = state.settings.mcpServers;
  const skills = state.settings.skills;
  const skillGroups = useMemo(() => groupSkillsByFolder(skills), [skills]);
  const hasSkillFolders = skillGroups.some((group) => group.folder !== null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // The list and the editor behave like separate screens — always start at the top.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [editingId]);

  // Deep links / reloads: initialize the draft once per addressed id. In-app
  // clicks pre-seed it in startNew/startEdit before navigating.
  useEffect(() => {
    if (!automationId) {
      draftInitRef.current = null;
      return;
    }
    if (draftInitRef.current === automationId) {
      return;
    }
    if (automationId === "new") {
      setDraft(emptyDraft());
      draftInitRef.current = "new";
      return;
    }
    const automation = automations.find((item) => item.id === automationId);
    if (automation) {
      setDraft(draftFromAutomation(automation));
      draftInitRef.current = automationId;
    }
  }, [automationId, automations]);

  // An address that never resolves (deleted or foreign) returns to the list —
  // after a short grace so the account profile sync can still deliver it.
  useEffect(() => {
    if (!automationId || automationId === "new" || automations.some((item) => item.id === automationId)) {
      return;
    }
    const timer = window.setTimeout(() => {
      toast.error("Automation not found");
      navigate("/automations", { replace: true });
    }, 2_500);
    return () => window.clearTimeout(timer);
  }, [automationId, automations, navigate]);

  const remainingTemplates = useMemo(
    () => AUTOMATION_TEMPLATES.filter((template) => !automations.some((item) => item.name === template.name)),
    [automations],
  );

  const startNew = () => {
    draftInitRef.current = "new";
    setDraft(emptyDraft());
    navigate("/automations/new");
  };

  const startEdit = (automation: Automation) => {
    draftInitRef.current = automation.id;
    setDraft(draftFromAutomation(automation));
    navigate(`/automations/${automation.id}`);
  };

  const save = () => {
    if (!draft.name.trim() || !draft.prompt.trim()) {
      return;
    }
    if (editingId === "new") {
      createAutomation(draftToInput(draft, true));
    } else if (editingId) {
      const current = automations.find((item) => item.id === editingId);
      updateAutomation(editingId, draftToInput(draft, current?.enabled ?? true));
    }
    navigate("/automations");
  };

  const openThread = (automation: Automation) => {
    selectChat(automation.conversationId);
    navigate(chatPath(automation.conversationId));
  };

  /** Cloud automations trigger on the server; browser ones run right here. */
  const triggerRunNow = (automation: Automation) => {
    if (automation.runOn === "server") {
      void requestCloudRunNow(automation.id).then((result) => {
        if (result.ok) {
          toast.success("Cloud run triggered", {
            description: "The result lands in the automation's thread — usually within a minute.",
          });
          // Nudge sync so the appended run shows up without a tab refocus.
          window.setTimeout(() => window.dispatchEvent(new Event("gera:sync")), 9_000);
          window.setTimeout(() => window.dispatchEvent(new Event("gera:sync")), 25_000);
        } else if (result.error === "sign_in_required") {
          toast.error("Sign in to trigger cloud runs.");
        } else if (result.error === "invite_required") {
          toast.error("Cloud runs need an invited account.");
        } else {
          toast.error(`Cloud run did not start (${result.error ?? "unknown"}).`);
        }
      });
      return;
    }
    runAutomationNow(automation.id);
  };

  // Collapsed-section summaries — the current value stays visible without expanding.
  const runAsSummary = agents.find((agent) => agent.id === draft.agentId)?.name ?? "Gera (default)";
  const webhookSummary = draft.webhookToken ? "On — secret URL fires runs" : "Off";
  const allowedServers = draft.mcpServerIds;
  const mcpSummary =
    mcpServers.length === 0
      ? "No servers connected yet"
      : allowedServers === null
        ? "All connected servers"
        : `${mcpServers.filter((server) => isServerAllowed(allowedServers, server)).length}/${mcpServers.length} allowed`;
  const allowedSkills = draft.skillIds;
  const skillsSummary =
    skills.length === 0
      ? "No skills yet"
      : allowedSkills === null
        ? "All enabled skills"
        : `${allowedSkills.filter((id) => skills.some((skill) => skill.id === id)).length}/${skills.length} allowed`;
  const extrasSummary =
    [draft.deepResearch ? "Deep research" : null, draft.catchUp ? "Catch up on launch" : null]
      .filter(Boolean)
      .join(" · ") || "Nothing extra";

  return (
    <StudioPageShell active="automations">
      {editingId ? (
        <div className="mx-auto max-w-3xl" data-testid={TID.automationEditor}>
          <button
            type="button"
            onClick={() => navigate("/automations")}
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            All automations
          </button>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span
              className={cn(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
                draft.runOn === "server" ? "bg-sky-600/10 text-sky-700" : "bg-ember/10 text-ember",
              )}
            >
              {draft.runOn === "server" ? <Cloud className="h-5 w-5" /> : <Zap className="h-5 w-5" />}
            </span>
            <div className="min-w-0">
              <h1 className="font-display text-3xl tracking-tight">
                {editingId === "new" ? "New automation" : "Edit automation"}
              </h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {draft.name || "Name it, give it a prompt, set a schedule."}
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <EditorSection
              title="Basics"
              description="The prompt fires exactly as written — every run lands in the automation's own thread."
            >
              <div className="space-y-3">
                <Input
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Name — e.g. Morning brief"
                  className="rounded-xl border-border bg-white text-sm"
                />
                <Textarea
                  value={draft.prompt}
                  onChange={(event) => setDraft((prev) => ({ ...prev, prompt: event.target.value }))}
                  placeholder="Prompt to run on schedule — e.g. Find today's AI news and write a digest with links…"
                  className="min-h-[120px] rounded-xl border-border bg-white text-sm"
                />
              </div>
            </EditorSection>

            <EditorSection title="Schedule" description="When it fires — in your local time.">
              <div className="flex flex-wrap items-center gap-1.5">
                {CADENCES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={draft.cadence === item.id}
                    onClick={() => setDraft((prev) => ({ ...prev, cadence: item.id }))}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      draft.cadence === item.id
                        ? "border-ember/60 bg-accent/70 text-foreground"
                        : "border-border/70 bg-card text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {draft.cadence === "interval" ? (
                  <select
                    value={draft.intervalMinutes}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, intervalMinutes: Number(event.target.value) }))
                    }
                    className="h-9 rounded-xl border border-border bg-white px-2.5 text-sm outline-none"
                    aria-label="Repeat interval"
                  >
                    {INTERVAL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                {draft.cadence === "weekly" ? (
                  <select
                    value={draft.weekday}
                    onChange={(event) => setDraft((prev) => ({ ...prev, weekday: Number(event.target.value) }))}
                    className="h-9 rounded-xl border border-border bg-white px-2.5 text-sm outline-none"
                    aria-label="Day of week"
                  >
                    {WEEKDAYS.map((day, index) => (
                      <option key={day} value={index}>
                        {day}
                      </option>
                    ))}
                  </select>
                ) : null}
                {draft.cadence !== "interval" ? (
                  <input
                    type="time"
                    value={draft.time}
                    onChange={(event) => setDraft((prev) => ({ ...prev, time: event.target.value }))}
                    className="h-9 rounded-xl border border-border bg-white px-2.5 text-sm outline-none"
                    aria-label="Run time"
                  />
                ) : null}
              </div>
              <p className="mt-2.5 text-[11px] text-muted-foreground">
                Fires: {describeSchedule(draftToInput(draft, true))}
              </p>
            </EditorSection>

            <EditorSection title="Where it runs">
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                <button
                  type="button"
                  aria-pressed={draft.runOn === "server"}
                  onClick={() => setDraft((prev) => ({ ...prev, runOn: "server" }))}
                  className={cn(
                    "rounded-xl border px-2.5 py-2 text-left transition-colors",
                    draft.runOn === "server" ? "border-ember/60 bg-ember/10" : "border-border/70 hover:bg-muted/50",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-medium",
                      draft.runOn === "server" && "text-ember",
                    )}
                  >
                    <Cloud className="h-3.5 w-3.5" />
                    In the cloud
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">
                    Fires even with the tab closed — results sync into the thread
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={draft.runOn === "browser"}
                  onClick={() => setDraft((prev) => ({ ...prev, runOn: "browser" }))}
                  className={cn(
                    "rounded-xl border px-2.5 py-2 text-left transition-colors",
                    draft.runOn === "browser" ? "border-ember/60 bg-ember/10" : "border-border/70 hover:bg-muted/50",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-medium",
                      draft.runOn === "browser" && "text-ember",
                    )}
                  >
                    <Monitor className="h-3.5 w-3.5" />
                    In this browser
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">
                    Fires while the tab is open — full tools, MCP, deep research
                  </span>
                </button>
              </div>
              {draft.runOn === "server" ? (
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  Honest limits: web search, page reading, SelfSurf, and the scoped MCP servers — keys and sign-ins
                  sync with your account. No deep research. A brand-new schedule can start a few minutes late once;
                  Run now is instant. Needs your synced account — sign in at least once.
                </p>
              ) : null}
            </EditorSection>

            {draft.runOn === "server" ? (
              <AdvancedSection
                title="Webhook trigger"
                summary={webhookSummary}
                description="A secret URL that fires this automation from outside — GitHub webhooks, Stripe, Zapier, anything that can POST."
              >
                <div className="space-y-1.5">
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/60 px-2.5 py-2.5">
                    <span>
                      <span className="flex items-center gap-1.5 text-sm">
                        <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                        Fire on incoming webhook
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        Each delivery lands as a run in the thread — payload included in the prompt
                      </span>
                    </span>
                    <Switch
                      checked={draft.webhookToken !== null}
                      onCheckedChange={(checked) =>
                        setDraft((prev) => ({ ...prev, webhookToken: checked ? newWebhookToken() : null }))
                      }
                      aria-label="Enable webhook trigger"
                    />
                  </label>
                  {draft.webhookToken ? (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Input
                          readOnly
                          value={webhookUrlFor(draft.webhookToken)}
                          onFocus={(event) => event.currentTarget.select()}
                          className="h-9 min-w-[220px] flex-1 rounded-xl border-border bg-white font-mono text-[11px]"
                          aria-label="Webhook URL"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-9 shrink-0 gap-1 rounded-xl border-border"
                          onClick={() => {
                            void navigator.clipboard.writeText(webhookUrlFor(draft.webhookToken ?? ""));
                            toast.success("Webhook URL copied");
                          }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-9 shrink-0 gap-1 rounded-xl border-border"
                          onClick={() => {
                            setDraft((prev) => ({ ...prev, webhookToken: newWebhookToken() }));
                            toast.success("New URL generated", {
                              description: "The old URL stops working once you save.",
                            });
                          }}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          New URL
                        </Button>
                      </div>
                      <p className="text-[10px] leading-relaxed text-muted-foreground">
                        The URL carries its own secret — treat it like a password. Live after save + account sync.
                        POST up to 64 KB (first 16k chars reach the prompt); bursts coalesce, max 12/min. Open the
                        URL in a browser to check it's registered.
                      </p>
                    </>
                  ) : null}
                </div>
              </AdvancedSection>
            ) : null}

            <AdvancedSection
              title="Run as"
              summary={runAsSummary}
              description="Borrow a profile's instructions, model, and tool pool for every run."
            >
              <select
                value={draft.agentId}
                onChange={(event) => setDraft((prev) => ({ ...prev, agentId: event.target.value }))}
                className="h-9 w-full rounded-xl border border-border bg-white px-2.5 text-sm outline-none"
                aria-label="Run as profile"
              >
                <option value="">Gera (default)</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </AdvancedSection>

            <AdvancedSection
              title="MCP servers"
              summary={mcpSummary}
              description="Scope which connected servers this automation may call — per automation, Cursor-style."
            >
              {mcpServers.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border bg-background/60 px-2.5 py-2.5 text-[11px] text-muted-foreground">
                  No MCP servers yet — connect them on the MCP page and they appear here with per-automation
                  toggles, Cursor-style.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/60 px-2.5 py-2">
                    <span>
                      <span className="flex items-center gap-1.5 text-sm">
                        <Plug className="h-3.5 w-3.5 text-muted-foreground" />
                        All connected servers
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        Also covers servers you connect later
                      </span>
                    </span>
                    <Switch
                      checked={draft.mcpServerIds === null}
                      onCheckedChange={(checked) =>
                        setDraft((prev) => ({
                          ...prev,
                          mcpServerIds: checked ? null : mcpServers.map((server) => server.id),
                        }))
                      }
                      aria-label="Allow all MCP servers"
                    />
                  </label>
                  {mcpServers.map((server) => {
                    const allowed = isServerAllowed(draft.mcpServerIds, server);
                    return (
                      <label
                        key={server.id}
                        className={cn(
                          "flex items-center justify-between gap-3 rounded-xl border px-2.5 py-2 transition-opacity",
                          allowed ? "border-border/70 bg-card" : "border-border/50 bg-background/40 opacity-70",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm">{server.name}</span>
                            {draft.runOn === "server" ? <CloudChip readiness={cloudMcpReadiness(server)} /> : null}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {server.tools.length > 0 ? `${server.tools.length} tools` : "not connected yet"}
                            {server.enabled ? "" : " · off on the MCP page"}
                          </span>
                        </span>
                        <Switch
                          checked={allowed}
                          onCheckedChange={(checked) =>
                            setDraft((prev) => ({
                              ...prev,
                              mcpServerIds: toggleServerId(prev.mcpServerIds, mcpServers, server, checked),
                            }))
                          }
                          aria-label={`Allow ${server.name}`}
                        />
                      </label>
                    );
                  })}
                  {draft.runOn === "server" ? (
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      Cloud runs reach every connected server from the backend — keys and sign-ins sync with your
                      account. “Connect first” means this server has no key or sign-in yet.
                    </p>
                  ) : null}
                </div>
              )}
            </AdvancedSection>

            <AdvancedSection
              title="Skills"
              summary={skillsSummary}
              description="Scope which instruction packs ride into this automation's runs — per automation, like MCP."
            >
              {skills.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border bg-background/60 px-2.5 py-2.5 text-[11px] text-muted-foreground">
                  No skills yet — add them on the Skills page and they appear here with per-automation toggles.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/60 px-2.5 py-2">
                    <span>
                      <span className="flex items-center gap-1.5 text-sm">
                        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                        All enabled skills
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        Also covers skills you add later
                      </span>
                    </span>
                    <Switch
                      checked={draft.skillIds === null}
                      onCheckedChange={(checked) =>
                        setDraft((prev) => ({
                          ...prev,
                          skillIds: checked ? null : skills.map((skill) => skill.id),
                        }))
                      }
                      aria-label="Allow all skills"
                    />
                  </label>
                  {skillGroups.map((group) => (
                    <div key={group.folder ?? "__none"} className="space-y-1.5">
                      {hasSkillFolders ? (
                        <p className="px-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                          {group.folder ?? "Other"}
                        </p>
                      ) : null}
                      {group.skills.map((skill) => {
                        const allowed = draft.skillIds === null || draft.skillIds.includes(skill.id);
                        return (
                          <label
                            key={skill.id}
                            className={cn(
                              "flex items-center justify-between gap-3 rounded-xl border px-2.5 py-2 transition-opacity",
                              allowed ? "border-border/70 bg-card" : "border-border/50 bg-background/40 opacity-70",
                            )}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm">{skill.name || "Untitled skill"}</span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {skill.enabled
                                  ? skill.description || "no description"
                                  : "off on the Skills page"}
                              </span>
                            </span>
                            <Switch
                              checked={allowed}
                              onCheckedChange={(checked) =>
                                setDraft((prev) => ({
                                  ...prev,
                                  skillIds: toggleSkillId(prev.skillIds, skills, skill, checked),
                                }))
                              }
                              aria-label={`Allow ${skill.name || "skill"}`}
                            />
                          </label>
                        );
                      })}
                    </div>
                  ))}
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    Each skill's own surface toggles still apply — a skill without the Chat surface stays out of
                    plain runs{draft.runOn === "browser" ? "; Deep research runs use the Deep Research surface" : ""}.
                  </p>
                </div>
              )}
            </AdvancedSection>

            {draft.runOn === "browser" ? (
              <AdvancedSection title="Browser extras" summary={extrasSummary}>
                <div className="space-y-1.5">
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/60 px-2.5 py-2.5">
                    <span>
                      <span className="block text-sm">Deep research</span>
                      <span className="block text-[11px] text-muted-foreground">
                        Multi-wave web research with a cited report on every run
                      </span>
                    </span>
                    <Switch
                      checked={draft.deepResearch}
                      onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, deepResearch: checked }))}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/60 px-2.5 py-2.5">
                    <span>
                      <span className="block text-sm">Catch up on launch</span>
                      <span className="block text-[11px] text-muted-foreground">
                        If a run was missed while the tab was closed, fire it once on your next visit
                      </span>
                    </span>
                    <Switch
                      checked={draft.catchUp}
                      onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, catchUp: checked }))}
                    />
                  </label>
                </div>
              </AdvancedSection>
            ) : null}
          </div>

          <EditorSaveBar
            hint={
              draft.runOn === "server"
                ? "Cloud runs need your synced account — sign in at least once."
                : "Browser runs fire while a Gera tab is open."
            }
            saveLabel={editingId === "new" ? "Create automation" : "Save changes"}
            disabled={!draft.name.trim() || !draft.prompt.trim()}
            onCancel={() => navigate("/automations")}
            onSave={save}
          />
        </div>
      ) : (
        <>
          <StudioPageHero
            title="Automations"
            subtitle="Scheduled prompts that run in the background and land in their own thread — like a teammate on a timer."
            action={
              <Button
                onClick={startNew}
                className="h-10 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground shadow-sm hover:bg-ember/90"
              >
                <Plus className="h-4 w-4" />
                New automation
              </Button>
            }
          />

          <section className="mt-8">
            <h3 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Your automations · {automations.length}
            </h3>
            {!user && automations.some((item) => item.runOn === "server" && item.enabled) ? (
              <p className="mt-3 rounded-2xl border border-gold/40 bg-gold/10 p-3 text-xs leading-relaxed text-foreground">
                You are signed out — cloud automations run from the last settings you synced. Sign in so schedule
                changes made here reach the cloud.
              </p>
            ) : null}
            {automations.length === 0 ? (
              <div className="mt-3 rounded-3xl border border-dashed border-border bg-card/60 px-6 py-14 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-ember/10 text-ember">
                  <Zap className="h-5 w-5" />
                </span>
                <p className="mt-3 font-display text-lg">No automations yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Create one or add a template below — each run lands in its own thread with a notification when it
                  finishes.
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {automations.map((automation) => (
                  <AutomationCard
                    key={automation.id}
                    automation={automation}
                    agentName={agents.find((agent) => agent.id === automation.agentId)?.name}
                    running={state.runningIds.includes(automation.conversationId)}
                    hasThread={state.conversations.some((item) => item.id === automation.conversationId)}
                    now={now}
                    onToggle={(checked) => updateAutomation(automation.id, { enabled: checked })}
                    onRunNow={() => triggerRunNow(automation)}
                    onOpenThread={() => openThread(automation)}
                    onEdit={() => startEdit(automation)}
                    onDelete={() => deleteAutomation(automation.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {remainingTemplates.length > 0 ? (
            <section className="mt-10">
              <h3 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Start from a template
              </h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {remainingTemplates.map((template) => (
                  <div
                    key={template.name}
                    className="flex items-center gap-3 rounded-3xl border border-dashed border-border bg-card/60 px-4 py-3.5"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ember/10 text-ember">
                      <Zap className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{template.name}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {describeSchedule(template)}
                        {template.deepResearch ? " · Deep research" : ""}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 gap-1 rounded-full border-border"
                      onClick={() => createAutomation(template)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <div className="mt-10 max-w-3xl space-y-2 text-[11px] leading-relaxed text-muted-foreground">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em]">Honest fine print</p>
            <p className="flex gap-2">
              <Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-700" />
              <span>
                Cloud — runs on our server even with the tab closed. Chat model, web search, SelfSurf, and the
                automation's MCP servers; keys and sign-ins sync with your account. A fresh schedule can start a few
                minutes late once; Run now is instant.
              </span>
            </p>
            <p className="flex gap-2">
              <Monitor className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Browser — fires while a Gera tab is open, with the full toolset including deep research. Catch-up
                fires a missed schedule once on your next visit.
              </span>
            </p>
            <p className="flex gap-2">
              <Webhook className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Webhook — cloud automations can also fire from a secret URL; each delivery lands as a run in its
                thread. MCP and skills are scoped per automation, like Cursor.
              </span>
            </p>
          </div>
        </>
      )}
    </StudioPageShell>
  );
}

function AutomationCard({
  automation,
  agentName,
  running,
  hasThread,
  now,
  onToggle,
  onRunNow,
  onOpenThread,
  onEdit,
  onDelete,
}: {
  automation: Automation;
  agentName: string | undefined;
  running: boolean;
  hasThread: boolean;
  now: number;
  onToggle: (checked: boolean) => void;
  onRunNow: () => void;
  onOpenThread: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isCloud = automation.runOn === "server";
  return (
    <div className="gera-card rounded-3xl p-4 transition-shadow hover:shadow-md">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl",
            isCloud ? "bg-sky-600/10 text-sky-700" : "bg-ember/10 text-ember",
          )}
        >
          {isCloud ? <Cloud className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{automation.name}</p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{automation.prompt}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <MetaChip label={describeSchedule(automation)} />
            {agentName ? <MetaChip label={agentName} /> : null}
            {automation.deepResearch ? <MetaChip label="Deep research" /> : null}
            {automation.mcpServerIds !== null ? <MetaChip label={`MCP · ${automation.mcpServerIds.length}`} /> : null}
            {automation.skillIds !== null ? <MetaChip label={`Skills · ${automation.skillIds.length}`} /> : null}
            {automation.webhookToken !== null && automation.runOn === "server" ? <MetaChip label="Webhook" /> : null}
          </div>
        </div>
        <Switch checked={automation.enabled} onCheckedChange={onToggle} aria-label={`Toggle ${automation.name}`} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {running ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-ember" />
              <span className="font-medium text-ember">Running now…</span>
            </>
          ) : !automation.enabled ? (
            "Paused"
          ) : isCloud ? (
            <>
              <Cloud className="h-3 w-3 text-sky-700" />
              Fires in the cloud — even with this tab closed
            </>
          ) : (
            <>
              <Monitor className="h-3 w-3" />
              Next run · {formatCountdown(automation.nextRunAt, now)}
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label={`Delete ${automation.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          {hasThread ? (
            <Button size="sm" variant="ghost" className="h-8 gap-1 rounded-full" onClick={onOpenThread}>
              <MessageCircle className="h-3.5 w-3.5" />
              Thread
            </Button>
          ) : null}
          <Button size="sm" variant="outline" className="h-8 gap-1 rounded-full border-border" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1 rounded-full bg-ember px-3.5 text-ember-foreground hover:bg-ember/90"
            onClick={onRunNow}
            disabled={running}
          >
            <Play className="h-3.5 w-3.5" />
            Run now
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Allow-list check mirroring the run-time scoping (row id or catalog id). */
function isServerAllowed(value: string[] | null, server: McpServerConfig): boolean {
  if (value === null) {
    return true;
  }
  return value.includes(server.id) || (server.catalogId ? value.includes(server.catalogId) : false);
}

/** Toggles one server; collapses back to "all" when every server ends up on. */
function toggleServerId(
  value: string[] | null,
  all: McpServerConfig[],
  server: McpServerConfig,
  checked: boolean,
): string[] | null {
  const current = value === null ? all.map((item) => item.id) : value;
  const next = current.filter((id) => id !== server.id && id !== server.catalogId);
  if (checked) {
    next.push(server.id);
  }
  const everyOn = all.every(
    (item) => next.includes(item.id) || (item.catalogId ? next.includes(item.catalogId) : false),
  );
  return everyOn ? null : next;
}

/** Toggles one skill; collapses back to "all" when every skill ends up on. */
function toggleSkillId(value: string[] | null, all: Skill[], skill: Skill, checked: boolean): string[] | null {
  const current = value === null ? all.map((item) => item.id) : value;
  const next = current.filter((id) => id !== skill.id);
  if (checked) {
    next.push(skill.id);
  }
  return all.every((item) => next.includes(item.id)) ? null : next;
}

function CloudChip({ readiness }: { readiness: CloudMcpReadiness }) {
  if (readiness === "ready") {
    return (
      <span className="shrink-0 rounded-full bg-sky-600/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-sky-700">
        cloud ok
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-700">
      connect first
    </span>
  );
}

function MetaChip({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
      {label}
    </span>
  );
}

/**
 * Collapsed-by-default editor card for secondary settings: the header row
 * always shows the current value, so nothing is hidden — expanding is one
 * click and the full controls are unchanged.
 */
function AdvancedSection({
  title,
  summary,
  description,
  children,
}: {
  title: string;
  summary: string;
  description?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <section className="gera-card rounded-3xl">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-left sm:p-5"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          {description ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
          <div className={description ? "mt-3" : undefined}>{children}</div>
        </div>
      ) : null}
    </section>
  );
}
