import { ArrowLeft, Bot, Cloud, FileText, Loader2, MessageCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useAgent, type AgentDraftInput } from "@/hooks/use-agent";
import { AGENT_TEMPLATES, agentHue, agentMonogram, type AgentTemplate } from "@/lib/agents";
import { newId } from "@/lib/env";
import { KNOWLEDGE_FILE_ACCEPT, extractFileText, isSupportedKnowledgeFile } from "@/lib/file-extract";
import {
  MAX_DOCS_PER_AGENT,
  MAX_REMOTE_FILE_CHARS,
  MAX_TOTAL_KNOWLEDGE_CHARS,
  capKnowledgeText,
  formatDocSize,
  knowledgeChars,
  makeLocalExcerpt,
  planKnowledgePlacement,
} from "@/lib/knowledge";
import { indexKnowledgeDocs } from "@/lib/knowledge-index";
import { deleteKnowledgeText, uploadKnowledgeText } from "@/lib/knowledge-store";
import { modelsForMode, providerLabel } from "@/lib/models";
import { BUILTIN_TOOL_LABEL } from "@/lib/router";
import { groupSkillsByFolder } from "@/lib/skills";
import { TID } from "@/lib/testids";
import type { AgentProfile, BuiltinToolId, KnowledgeDoc, McpServerConfig, Skill } from "@/lib/types";
import { cn } from "@/lib/utils";

const BUILTIN_IDS = Object.keys(BUILTIN_TOOL_LABEL) as BuiltinToolId[];

type Draft = {
  name: string;
  tagline: string;
  systemPrompt: string;
  modelId: string;
  allBuiltins: boolean;
  builtins: BuiltinToolId[];
  allMcp: boolean;
  mcpServerIds: string[];
  allSkills: boolean;
  skillIds: string[];
  knowledge: KnowledgeDoc[];
};

function emptyDraft(): Draft {
  return {
    name: "",
    tagline: "",
    systemPrompt: "",
    modelId: "",
    allBuiltins: true,
    builtins: [...BUILTIN_IDS],
    allMcp: true,
    mcpServerIds: [],
    allSkills: true,
    skillIds: [],
    knowledge: [],
  };
}

function draftFromAgent(agent: AgentProfile): Draft {
  return {
    name: agent.name,
    tagline: agent.tagline,
    systemPrompt: agent.systemPrompt,
    modelId: agent.modelId,
    allBuiltins: agent.builtins === null,
    builtins: agent.builtins ?? [...BUILTIN_IDS],
    allMcp: agent.mcpServerIds === null,
    mcpServerIds: agent.mcpServerIds ?? [],
    allSkills: agent.skillIds === null,
    skillIds: agent.skillIds ?? [],
    knowledge: [...agent.knowledge],
  };
}

function draftToInput(draft: Draft): AgentDraftInput {
  return {
    name: draft.name.trim(),
    tagline: draft.tagline.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    modelId: draft.modelId,
    builtins: draft.allBuiltins ? null : draft.builtins,
    mcpServerIds: draft.allMcp ? null : draft.mcpServerIds,
    skillIds: draft.allSkills ? null : draft.skillIds,
    knowledge: draft.knowledge,
  };
}

/** Full-page profiles workspace: card grid, templates, and a sectioned editor. */
export default function ProfilesPage() {
  const { state, models, agents, createAgent, updateAgent, deleteAgent, newChatWithAgent } = useAgent();
  const navigate = useNavigate();
  // The editor is URL-driven: /profiles/new or /profiles/<id>.
  const { profileId } = useParams<{ profileId?: string }>();
  const editingId: string | "new" | null = profileId ?? null;
  /** Which id the draft was last initialized for — survives settings syncs. */
  const draftInitRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [extracting, setExtracting] = useState<string | null>(null);
  const knowledgeFileRef = useRef<HTMLInputElement>(null);

  // The list and the editor behave like separate screens — always start at the top.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [editingId]);

  // Deep links / reloads: initialize the draft once per addressed id. In-app
  // clicks pre-seed it in startNew/startEdit before navigating.
  useEffect(() => {
    if (!profileId) {
      draftInitRef.current = null;
      return;
    }
    if (draftInitRef.current === profileId) {
      return;
    }
    if (profileId === "new") {
      setDraft(emptyDraft());
      draftInitRef.current = "new";
      return;
    }
    const agent = agents.find((item) => item.id === profileId);
    if (agent) {
      setDraft(draftFromAgent(agent));
      draftInitRef.current = profileId;
    }
  }, [profileId, agents]);

  // An address that never resolves (deleted or foreign) returns to the list —
  // after a short grace so the account profile sync can still deliver it.
  useEffect(() => {
    if (!profileId || profileId === "new" || agents.some((item) => item.id === profileId)) {
      return;
    }
    const timer = window.setTimeout(() => {
      toast.error("Profile not found");
      navigate("/profiles", { replace: true });
    }, 2_500);
    return () => window.clearTimeout(timer);
  }, [profileId, agents, navigate]);

  /** Total knowledge chars across every OTHER profile — the shared budget guard. */
  const otherAgentsKnowledge = useMemo(
    () =>
      agents
        .filter((agent) => agent.id !== editingId)
        .reduce((sum, agent) => sum + knowledgeChars(agent.knowledge), 0),
    [agents, editingId],
  );

  const addKnowledgeFiles = async (files: File[]) => {
    setExtracting("Reading…");
    try {
      let docs = [...draft.knowledge];
      for (const file of files) {
        if (!isSupportedKnowledgeFile(file)) {
          toast.error(`"${file.name}" is not supported`, {
            description: "Knowledge accepts text and code files plus PDF, DOCX, and XLSX.",
          });
          continue;
        }
        if (docs.length >= MAX_DOCS_PER_AGENT) {
          toast.error(`Limit: ${MAX_DOCS_PER_AGENT} files per profile`);
          break;
        }
        setExtracting(`Reading "${file.name}"…`);
        let text = "";
        try {
          text = await extractFileText(file, {
            maxChars: MAX_REMOTE_FILE_CHARS,
            onProgress: (label) => setExtracting(label),
          });
        } catch (error) {
          toast.error(`Could not read "${file.name}"`, {
            description: error instanceof Error ? error.message : "Extraction failed.",
          });
          continue;
        }
        if (text.trim().length === 0) {
          toast.error(`"${file.name}" is empty`);
          continue;
        }
        const budgetLeft = MAX_TOTAL_KNOWLEDGE_CHARS - otherAgentsKnowledge - knowledgeChars(docs);
        if (planKnowledgePlacement(text.length, budgetLeft) === "local") {
          docs = [...docs, { id: newId(), name: file.name, text, addedAt: Date.now() }];
          continue;
        }
        // Cloud placement: the full text goes to the account's R2 space; the
        // synced profile blob keeps a short excerpt as the offline fallback.
        const excerpt = makeLocalExcerpt(text);
        if (excerpt.length > budgetLeft) {
          toast.error("Local sync budget is full", {
            description: "Even a short preview doesn't fit. Remove some knowledge files first.",
          });
          break;
        }
        setExtracting(`Uploading "${file.name}" to cloud…`);
        const id = newId();
        try {
          const key = await uploadKnowledgeText(id, text);
          docs = [
            ...docs,
            { id, name: file.name, text: excerpt, r2Key: key, fullChars: text.length, addedAt: Date.now() },
          ];
        } catch (error) {
          const message = error instanceof Error ? error.message : "Upload failed.";
          const trimmed = capKnowledgeText(text);
          if (trimmed.length <= budgetLeft) {
            docs = [...docs, { id, name: file.name, text: trimmed, addedAt: Date.now() }];
            toast.warning(`"${file.name}" kept as a trimmed local copy`, {
              description: `Cloud storage is unavailable: ${message}`,
            });
          } else {
            toast.error(`Could not store "${file.name}"`, { description: message });
          }
        }
      }
      setDraft((prev) => ({ ...prev, knowledge: docs }));
      // Warm the semantic index in the background — retrieval works without it.
      void indexKnowledgeDocs(docs);
    } finally {
      setExtracting(null);
    }
  };

  const chatModels = useMemo(() => modelsForMode(models, "chat"), [models]);
  const remainingTemplates = useMemo(
    () => AGENT_TEMPLATES.filter((template) => !agents.some((agent) => agent.name === template.name)),
    [agents],
  );

  const startNew = () => {
    draftInitRef.current = "new";
    setDraft(emptyDraft());
    navigate("/profiles/new");
  };

  const startEdit = (agent: AgentProfile) => {
    draftInitRef.current = agent.id;
    setDraft(draftFromAgent(agent));
    navigate(`/profiles/${agent.id}`);
  };

  const save = () => {
    if (!draft.name.trim()) {
      return;
    }
    // Cloud objects for docs removed during this edit are deleted on save (not
    // on chip removal), so cancelling the editor never breaks a saved doc.
    const before = editingId !== "new" ? agents.find((agent) => agent.id === editingId)?.knowledge ?? [] : [];
    const kept = new Set(draft.knowledge.map((doc) => doc.r2Key).filter(Boolean));
    for (const doc of before) {
      if (doc.r2Key && !kept.has(doc.r2Key)) {
        void deleteKnowledgeText(doc.r2Key);
      }
    }
    if (editingId === "new") {
      createAgent(draftToInput(draft));
    } else if (editingId) {
      updateAgent(editingId, draftToInput(draft));
    }
    navigate("/profiles");
  };

  const addTemplate = (template: AgentTemplate) => {
    createAgent({
      ...template,
      builtins: template.builtins ? [...template.builtins] : null,
      mcpServerIds: template.mcpServerIds ? [...template.mcpServerIds] : null,
      skillIds: template.skillIds ? [...template.skillIds] : null,
      knowledge: [...template.knowledge],
    });
  };

  const openChat = (agent: AgentProfile) => {
    newChatWithAgent(agent.id);
    navigate("/");
  };

  return (
    <StudioPageShell active="profiles">
      {editingId ? (
        <div className="mx-auto max-w-3xl" data-testid={TID.profileEditor}>
          <button
            type="button"
            onClick={() => navigate("/profiles")}
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            All profiles
          </button>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span
              className={cn(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl font-display text-lg",
                agentHue(draft.name || "Profile"),
              )}
            >
              {agentMonogram(draft.name || "?")}
            </span>
            <div className="min-w-0">
              <h1 className="font-display text-3xl tracking-tight">
                {editingId === "new" ? "New profile" : "Edit profile"}
              </h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {draft.name || "Give it a name and a job."}
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <EditorSection
              title="Identity"
              description="Who this profile is and how it must behave in every chat."
            >
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={draft.name}
                    onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                    placeholder="Name — e.g. Slack teammate"
                    className="rounded-xl border-border bg-white text-sm"
                  />
                  <Input
                    value={draft.tagline}
                    onChange={(event) => setDraft((prev) => ({ ...prev, tagline: event.target.value }))}
                    placeholder="Tagline — what it does"
                    className="rounded-xl border-border bg-white text-sm"
                  />
                </div>
                <Textarea
                  value={draft.systemPrompt}
                  onChange={(event) => setDraft((prev) => ({ ...prev, systemPrompt: event.target.value }))}
                  placeholder="Instructions: who this profile is, how it writes, what it must and must not do…"
                  className="min-h-[160px] rounded-xl border-border bg-white text-sm"
                />
              </div>
            </EditorSection>

            <EditorSection
              title="Model"
              description="Overrides the composer model in this profile's chats."
            >
              <select
                value={draft.modelId}
                onChange={(event) => setDraft((prev) => ({ ...prev, modelId: event.target.value }))}
                className="h-9 w-full rounded-xl border border-border bg-white px-2.5 text-sm outline-none"
                aria-label="Preferred model"
              >
                <option value="">Composer model (default)</option>
                {chatModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {providerLabel(model.owned_by)} — {model.name}
                  </option>
                ))}
              </select>
            </EditorSection>

            <EditorSection
              title="Built-in tools"
              description="Web search, images, code and more — limit which ones this profile can reach."
            >
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">All tools enabled</span>
                <Switch
                  checked={draft.allBuiltins}
                  onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, allBuiltins: checked }))}
                />
              </label>
              {!draft.allBuiltins ? (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {BUILTIN_IDS.map((id) => (
                    <PoolChip
                      key={id}
                      label={BUILTIN_TOOL_LABEL[id]}
                      active={draft.builtins.includes(id)}
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          builtins: prev.builtins.includes(id)
                            ? prev.builtins.filter((item) => item !== id)
                            : [...prev.builtins, id],
                        }))
                      }
                    />
                  ))}
                </div>
              ) : null}
            </EditorSection>

            <EditorSection
              title="MCP servers"
              description="Scope which connected servers this profile may call — Cursor-style."
            >
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">All connected servers</span>
                <Switch
                  checked={draft.allMcp}
                  onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, allMcp: checked }))}
                />
              </label>
              {!draft.allMcp ? (
                state.settings.mcpServers.length > 0 ? (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {state.settings.mcpServers.map((server) => (
                      <PoolChip
                        key={server.id}
                        label={server.name || "Server"}
                        dot={server.status === "connected"}
                        active={draft.mcpServerIds.includes(server.id)}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            mcpServerIds: prev.mcpServerIds.includes(server.id)
                              ? prev.mcpServerIds.filter((item) => item !== server.id)
                              : [...prev.mcpServerIds, server.id],
                          }))
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    No MCP servers added yet — connect some on the MCP page first.
                  </p>
                )
              ) : null}
            </EditorSection>

            <EditorSection
              title="Skills"
              description="Reusable instruction packs from the Skills page — scope which ones this profile carries into its runs."
            >
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">All enabled skills</span>
                <Switch
                  checked={draft.allSkills}
                  onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, allSkills: checked }))}
                />
              </label>
              {!draft.allSkills ? (
                state.settings.skills.length > 0 ? (
                  <GroupedSkillChips
                    skills={state.settings.skills}
                    isActive={(id) => draft.skillIds.includes(id)}
                    onToggle={(id) =>
                      setDraft((prev) => ({
                        ...prev,
                        skillIds: prev.skillIds.includes(id)
                          ? prev.skillIds.filter((item) => item !== id)
                          : [...prev.skillIds, id],
                      }))
                    }
                  />
                ) : (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    No skills yet — create some on the Skills page first.
                  </p>
                )
              ) : null}
            </EditorSection>

            <EditorSection
              title="Knowledge"
              description="Files the profile answers from — text and code plus PDF, DOCX, XLSX. Scanned PDFs are read with OCR (a vision model transcribes up to 40 pages). Small files sync inside your profile; big ones live in your account's cloud space and are fetched when needed. Each turn injects the excerpts most relevant to the message — keyword matching fused with a semantic index; offline it falls back to keywords over local copies."
            >
              <input
                ref={knowledgeFileRef}
                type="file"
                accept={KNOWLEDGE_FILE_ACCEPT}
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  if (files.length > 0) {
                    void addKnowledgeFiles(files);
                  }
                  event.target.value = "";
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 rounded-full border-border"
                disabled={extracting !== null}
                onClick={() => knowledgeFileRef.current?.click()}
              >
                {extracting !== null ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                <span className="max-w-[240px] truncate">{extracting ?? "Add files"}</span>
              </Button>
              {draft.knowledge.length > 0 ? (
                <div className="mt-2.5 space-y-1.5">
                  {draft.knowledge.map((doc) => (
                    <div
                      key={doc.id}
                      className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-2.5 py-2"
                    >
                      {doc.r2Key ? (
                        <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs">{doc.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {formatDocSize(doc.fullChars ?? doc.text.length)}
                        {doc.r2Key ? " · cloud" : ""}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${doc.name}`}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            knowledge: prev.knowledge.filter((item) => item.id !== doc.id),
                          }))
                        }
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </EditorSection>
          </div>

          <EditorSaveBar
            hint={editingId === "new" ? "Profiles live on this page — hit Chat on a card to start a thread." : "Changes apply to every chat with this profile."}
            saveLabel={editingId === "new" ? "Create profile" : "Save changes"}
            disabled={!draft.name.trim()}
            onCancel={() => navigate("/profiles")}
            onSave={save}
          />
        </div>
      ) : (
        <>
          <StudioPageHero
            title="Profiles"
            subtitle="Reusable teammates — each with its own instructions, model, tool pool, and knowledge. Start a chat with one, or design your own."
            action={
              <Button
                onClick={startNew}
                className="h-10 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground shadow-sm hover:bg-ember/90"
              >
                <Plus className="h-4 w-4" />
                New profile
              </Button>
            }
          />

          <section className="mt-8">
            <h3 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Your profiles · {agents.length}
            </h3>
            {agents.length === 0 ? (
              <div className="mt-3 rounded-3xl border border-dashed border-border bg-card/60 px-6 py-14 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-ember/10 text-ember">
                  <Bot className="h-5 w-5" />
                </span>
                <p className="mt-3 font-display text-lg">No profiles yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Create your first profile or start from a template below.
                </p>
              </div>
            ) : (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {agents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    servers={state.settings.mcpServers}
                    skills={state.settings.skills}
                    modelName={chatModels.find((model) => model.id === agent.modelId)?.name}
                    onChat={() => openChat(agent)}
                    onEdit={() => startEdit(agent)}
                    onDelete={() => deleteAgent(agent.id)}
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
                    <span
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-display text-sm",
                        agentHue(template.name),
                      )}
                    >
                      {agentMonogram(template.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{template.name}</p>
                      <p className="truncate text-[11px] text-muted-foreground">{template.tagline}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 gap-1 rounded-full border-border"
                      onClick={() => addTemplate(template)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </StudioPageShell>
  );
}

function AgentCard({
  agent,
  servers,
  skills,
  modelName,
  onChat,
  onEdit,
  onDelete,
}: {
  agent: AgentProfile;
  servers: McpServerConfig[];
  skills: Skill[];
  modelName: string | undefined;
  onChat: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const mcpSummary =
    agent.mcpServerIds === null
      ? "All MCP"
      : `${agent.mcpServerIds.filter((id) => servers.some((server) => server.id === id || server.catalogId === id)).length}/${agent.mcpServerIds.length} MCP`;
  const builtinSummary = agent.builtins === null ? "All tools" : `${agent.builtins.length} tools`;
  // Shown only when the workspace has skills or the profile narrows them —
  // an empty workspace stays uncluttered.
  const skillsSummary =
    agent.skillIds === null
      ? skills.length > 0
        ? "All skills"
        : null
      : `${agent.skillIds.filter((id) => skills.some((skill) => skill.id === id)).length}/${agent.skillIds.length} skills`;
  const knowledgeSummary =
    agent.knowledge.length > 0 ? `${agent.knowledge.length} ${agent.knowledge.length === 1 ? "doc" : "docs"}` : null;

  return (
    <div className="gera-card flex flex-col rounded-3xl p-4 transition-shadow hover:shadow-md">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl font-display text-lg",
            agentHue(agent.name),
          )}
        >
          {agentMonogram(agent.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{agent.name}</p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {agent.tagline || "Custom profile"}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        <MetaChip label={modelName ?? (agent.modelId ? agent.modelId.split("/")[1] : "Composer model")} />
        <MetaChip label={builtinSummary} />
        <MetaChip label={mcpSummary} />
        {skillsSummary ? <MetaChip label={skillsSummary} /> : null}
        {knowledgeSummary ? <MetaChip label={knowledgeSummary} /> : null}
      </div>
      <div className="mt-4 flex items-center gap-1.5 border-t border-border/50 pt-3">
        <Button
          size="sm"
          className="h-8 gap-1 rounded-full bg-ember px-3.5 text-ember-foreground hover:bg-ember/90"
          onClick={onChat}
        >
          <MessageCircle className="h-3.5 w-3.5" />
          Chat
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1 rounded-full border-border" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={`Delete ${agent.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function MetaChip({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
      {label}
    </span>
  );
}

/** Skill chips grouped by folder — mirrors the Skills page organization. */
function GroupedSkillChips({
  skills,
  isActive,
  onToggle,
}: {
  skills: Skill[];
  isActive: (id: string) => boolean;
  onToggle: (id: string) => void;
}) {
  const groups = groupSkillsByFolder(skills);
  const labeled = groups.some((group) => group.folder !== null);
  return (
    <div className="mt-2.5 space-y-2.5">
      {groups.map((group) => (
        <div key={group.folder ?? "__none"}>
          {labeled ? (
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {group.folder ?? "Other"}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {group.skills.map((skill) => (
              <PoolChip
                key={skill.id}
                label={skill.name || "Skill"}
                dot={skill.enabled}
                active={isActive(skill.id)}
                onClick={() => onToggle(skill.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PoolChip({
  label,
  active,
  dot,
  onClick,
}: {
  label: string;
  active: boolean;
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-ember/60 bg-accent/70 text-foreground"
          : "border-border/70 bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : null}
      {label}
    </button>
  );
}
