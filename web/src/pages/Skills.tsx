import { ArrowLeft, FolderOpen, Pencil, Plug, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import {
  EditorSaveBar,
  EditorSection,
  StudioPageHero,
  StudioPageShell,
} from "@/components/gera/StudioPageShell";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgent } from "@/hooks/use-agent";
import { agentHue } from "@/lib/agents";
import {
  MAX_SKILL_CONNECTORS,
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_FOLDER_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILLS,
  SKILL_SURFACE_LABEL,
  SKILL_SURFACES,
  SKILL_TEMPLATE_GROUPS,
  addAllTemplates,
  groupSkillsByFolder,
  newSkill,
  renameSkillFolder,
  setFolderSurface,
  skillFolderNames,
  skillFromTemplate,
  type SkillFolderGroup,
  type SkillTemplate,
} from "@/lib/skills";
import { TID } from "@/lib/testids";
import type { McpServerConfig, Skill, SkillSurface } from "@/lib/types";
import { cn } from "@/lib/utils";

type Draft = {
  name: string;
  description: string;
  content: string;
  folder: string;
  surfaces: Record<SkillSurface, boolean>;
  /** Bound MCP connectors — armed whenever this skill rides a chat run. */
  mcpServerIds: string[];
};

function emptyDraft(): Draft {
  return {
    name: "",
    description: "",
    content: "",
    folder: "",
    surfaces: { chat: true, research: true, julius: true },
    mcpServerIds: [],
  };
}

function draftFromSkill(skill: Skill): Draft {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    folder: skill.folder ?? "",
    surfaces: { ...skill.surfaces },
    mcpServerIds: [...(skill.mcpServerIds ?? [])],
  };
}

/** Resolved connector names for a skill's pins plus how many point at removed servers. */
function connectorMeta(skill: Skill, servers: McpServerConfig[]): { names: string[]; stale: number } {
  const names: string[] = [];
  let stale = 0;
  for (const id of skill.mcpServerIds ?? []) {
    const server = servers.find((item) => item.id === id);
    if (server) {
      names.push(server.name);
    } else {
      stale += 1;
    }
  }
  return { names, stale };
}

/**
 * Full-page skills workspace: reusable instruction packs that ride into chat
 * turns, Deep Research runs, and Julius panels. Profiles narrow the set per
 * teammate in the profile editor.
 */
export default function SkillsPage() {
  const { state, patchSettings } = useAgent();
  const skills = state.settings.skills;
  const servers = state.settings.mcpServers;
  const navigate = useNavigate();
  // The editor is URL-driven: /skills/new or /skills/<id>.
  const { skillId } = useParams<{ skillId?: string }>();
  const editingId: string | "new" | null = skillId ?? null;
  /** Which id the draft was last initialized for — survives settings syncs. */
  const draftInitRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  // Template picked for a full-text look before adopting — card click opens it.
  const [preview, setPreview] = useState<SkillTemplate | null>(null);

  // The list and the editor behave like separate screens — always start at the top.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [editingId]);

  // Deep links / reloads: initialize the draft once per addressed id. In-app
  // clicks pre-seed it in startNew/startEdit before navigating.
  useEffect(() => {
    if (!skillId) {
      draftInitRef.current = null;
      return;
    }
    if (draftInitRef.current === skillId) {
      return;
    }
    if (skillId === "new") {
      setDraft(emptyDraft());
      draftInitRef.current = "new";
      return;
    }
    const skill = skills.find((item) => item.id === skillId);
    if (skill) {
      setDraft(draftFromSkill(skill));
      draftInitRef.current = skillId;
    }
  }, [skillId, skills]);

  // An address that never resolves (deleted or foreign) returns to the list —
  // after a short grace so the account profile sync can still deliver it.
  useEffect(() => {
    if (!skillId || skillId === "new" || skills.some((item) => item.id === skillId)) {
      return;
    }
    const timer = window.setTimeout(() => {
      toast.error("Skill not found");
      navigate("/skills", { replace: true });
    }, 2_500);
    return () => window.clearTimeout(timer);
  }, [skillId, skills, navigate]);

  // Catalog groups minus the templates already adopted (matched by name).
  const templateGroups = useMemo(
    () =>
      SKILL_TEMPLATE_GROUPS.map((group) => ({
        ...group,
        templates: group.templates.filter(
          (template) => !skills.some((skill) => skill.name === template.name),
        ),
      })).filter((group) => group.templates.length > 0),
    [skills],
  );
  const remainingCount = templateGroups.reduce((sum, group) => sum + group.templates.length, 0);

  const groups = useMemo(() => groupSkillsByFolder(skills), [skills]);
  const hasFolders = groups.some((group) => group.folder !== null);
  const folderNames = useMemo(() => skillFolderNames(skills), [skills]);

  const startNew = (folder: string = "") => {
    if (skills.length >= MAX_SKILLS) {
      toast.error(`Limit: ${MAX_SKILLS} skills`);
      return;
    }
    draftInitRef.current = "new";
    setDraft({ ...emptyDraft(), folder });
    navigate("/skills/new");
  };

  const startEdit = (skill: Skill) => {
    draftInitRef.current = skill.id;
    setDraft(draftFromSkill(skill));
    navigate(`/skills/${skill.id}`);
  };

  const save = () => {
    const name = draft.name.trim().slice(0, MAX_SKILL_NAME_CHARS);
    const description = draft.description.trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS);
    const content = draft.content.trim().slice(0, MAX_SKILL_CONTENT_CHARS);
    const folder = draft.folder.trim().slice(0, MAX_SKILL_FOLDER_CHARS);
    // Pins to servers that no longer exist are pruned on save (the editor
    // disclosed them); an empty binding is stored as absent, keeping blobs lean.
    const boundIds = draft.mcpServerIds
      .filter((id) => servers.some((server) => server.id === id))
      .slice(0, MAX_SKILL_CONNECTORS);
    const mcpServerIds = boundIds.length > 0 ? boundIds : undefined;
    if (!name || !content) {
      return;
    }
    if (editingId === "new") {
      const skill: Skill = {
        ...newSkill(),
        name,
        description,
        content,
        folder,
        surfaces: { ...draft.surfaces },
        mcpServerIds,
      };
      patchSettings({ skills: [skill, ...skills].slice(0, MAX_SKILLS) });
    } else if (editingId) {
      patchSettings({
        skills: skills.map((skill) =>
          skill.id === editingId
            ? { ...skill, name, description, content, folder, surfaces: { ...draft.surfaces }, mcpServerIds }
            : skill,
        ),
      });
    }
    navigate("/skills");
  };

  const toggleConnector = (id: string) => {
    setDraft((prev) => {
      if (prev.mcpServerIds.includes(id)) {
        return { ...prev, mcpServerIds: prev.mcpServerIds.filter((item) => item !== id) };
      }
      if (prev.mcpServerIds.length >= MAX_SKILL_CONNECTORS) {
        toast.error(`Limit: ${MAX_SKILL_CONNECTORS} connectors per skill`);
        return prev;
      }
      return { ...prev, mcpServerIds: [...prev.mcpServerIds, id] };
    });
  };

  const toggleEnabled = (id: string, enabled: boolean) => {
    patchSettings({ skills: skills.map((skill) => (skill.id === id ? { ...skill, enabled } : skill)) });
  };

  const remove = (id: string) => {
    // Profiles referencing the dead skill drop it from their allow-lists too —
    // no dangling ids posing as a real narrowing.
    patchSettings({
      skills: skills.filter((skill) => skill.id !== id),
      agents: state.settings.agents.map((agent) =>
        agent.skillIds ? { ...agent, skillIds: agent.skillIds.filter((item) => item !== id) } : agent,
      ),
    });
  };

  const addTemplate = (template: SkillTemplate) => {
    if (skills.length >= MAX_SKILLS) {
      toast.error(`Limit: ${MAX_SKILLS} skills`);
      return;
    }
    patchSettings({ skills: [skillFromTemplate(template), ...skills] });
  };

  const addAll = () => {
    const { skills: next, added, skipped } = addAllTemplates(skills);
    if (added === 0) {
      toast.error(`Limit: ${MAX_SKILLS} skills`);
      return;
    }
    patchSettings({ skills: next });
    if (skipped > 0) {
      // The cap is disclosed, never silent.
      toast.warning(`Added ${added} — ${skipped} didn't fit the ${MAX_SKILLS}-skill limit`);
    } else {
      toast.success(`Added ${added} ${added === 1 ? "skill" : "skills"}`);
    }
  };

  const noSurfaces = !draft.surfaces.chat && !draft.surfaces.research && !draft.surfaces.julius;
  const staleDraftPins = draft.mcpServerIds.filter(
    (id) => !servers.some((server) => server.id === id),
  ).length;

  return (
    <StudioPageShell active="skills">
      {editingId ? (
        <div className="mx-auto max-w-3xl" data-testid={TID.skillEditor}>
          <button
            type="button"
            onClick={() => navigate("/skills")}
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            All skills
          </button>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span
              className={cn(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
                agentHue(draft.name || "Skill"),
              )}
            >
              <Sparkles className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 className="font-display text-3xl tracking-tight">
                {editingId === "new" ? "New skill" : "Edit skill"}
              </h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {draft.name || "Name it after the way of working it teaches."}
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <EditorSection
              title="Identity"
              description="A clear name plus a one-line hint the model uses to decide when this skill applies."
            >
              <div className="space-y-3">
                <Input
                  value={draft.name}
                  maxLength={MAX_SKILL_NAME_CHARS}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Name — e.g. Executive brief"
                  className="rounded-xl border-border bg-white text-sm"
                />
                <Input
                  value={draft.description}
                  maxLength={MAX_SKILL_DESCRIPTION_CHARS}
                  onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
                  placeholder="When to apply — e.g. strategic questions that need a decision-ready answer"
                  className="rounded-xl border-border bg-white text-sm"
                />
                <Input
                  value={draft.folder}
                  maxLength={MAX_SKILL_FOLDER_CHARS}
                  list="skill-folder-options"
                  onChange={(event) => setDraft((prev) => ({ ...prev, folder: event.target.value }))}
                  placeholder="Folder — optional, e.g. Engineering"
                  className="rounded-xl border-border bg-white text-sm"
                />
                <datalist id="skill-folder-options">
                  {folderNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Skills in one folder can be flipped per tool in one click on the skills list.
                </p>
              </div>
            </EditorSection>

            <EditorSection
              title="Applies to"
              description="Which runs carry this skill: regular chats, Deep Research runs, Julius panels. Profiles can narrow further in the profile editor."
            >
              <div className="flex flex-wrap gap-1.5">
                {SKILL_SURFACES.map((surface) => (
                  <SurfaceChip
                    key={surface}
                    label={SKILL_SURFACE_LABEL[surface]}
                    active={draft.surfaces[surface]}
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        surfaces: { ...prev.surfaces, [surface]: !prev.surfaces[surface] },
                      }))
                    }
                  />
                ))}
              </div>
              {noSurfaces ? (
                <p className="mt-2 text-[11px] text-destructive">
                  Every surface is off — this skill will never reach a run until one is enabled.
                </p>
              ) : null}
            </EditorSection>

            <EditorSection
              title="Connectors"
              description="MCP connectors this skill brings along: whenever the skill rides a chat run, their tools are armed automatically — the auto-router can't drop them. Profiles and automations that exclude a connector still win."
            >
              {servers.length === 0 ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  No connectors configured yet — add GitHub, Slack, or any MCP server on the{" "}
                  <Link to="/mcp" className="text-ember underline-offset-2 hover:underline">
                    Connections page
                  </Link>
                  , then bind them here.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {servers.map((server) => (
                      <ConnectorChip
                        key={server.id}
                        name={server.name}
                        connected={server.enabled && server.status === "connected"}
                        active={draft.mcpServerIds.includes(server.id)}
                        onClick={() => toggleConnector(server.id)}
                      />
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    Applies to chats (including chat automations). Deep Research and Julius don't
                    take MCP tools, so bindings don't reach them.
                  </p>
                  {staleDraftPins > 0 ? (
                    <p className="mt-1 text-[11px] text-destructive">
                      {staleDraftPins} bound connector{staleDraftPins === 1 ? "" : "s"} no longer
                      exist{staleDraftPins === 1 ? "s" : ""} and will be removed on save.
                    </p>
                  ) : null}
                </>
              )}
            </EditorSection>

            <EditorSection
              title="Instructions"
              description="The instructions injected into matching runs. Write them like you'd brief a teammate: what to do, how to format, what to avoid."
            >
              <Textarea
                value={draft.content}
                maxLength={MAX_SKILL_CONTENT_CHARS}
                onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
                placeholder={
                  "e.g. Present every comparison as a markdown table with criteria as rows…"
                }
                className="min-h-[220px] rounded-xl border-border bg-white text-sm"
              />
              <p className="mt-1.5 text-right text-[11px] text-muted-foreground">
                {draft.content.length.toLocaleString()} / {MAX_SKILL_CONTENT_CHARS.toLocaleString()}
              </p>
            </EditorSection>
          </div>

          <EditorSaveBar
            hint={
              editingId === "new"
                ? "Skills apply to new runs the moment they're saved."
                : "Changes apply to every future run that carries this skill."
            }
            saveLabel={editingId === "new" ? "Create skill" : "Save changes"}
            disabled={!draft.name.trim() || !draft.content.trim()}
            onCancel={() => navigate("/skills")}
            onSave={save}
          />
        </div>
      ) : (
        <>
          <StudioPageHero
            title="Skills"
            subtitle="Reusable instruction packs — write one once and it rides into chats, Deep Research runs, and Julius panels. Folders group related skills so you can flip a whole set per tool in one click."
            action={
              <Button
                onClick={() => startNew()}
                className="h-10 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground shadow-sm hover:bg-ember/90"
              >
                <Plus className="h-4 w-4" />
                New skill
              </Button>
            }
          />

          <section className="mt-8">
            <h3 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Your skills · {skills.length}
            </h3>
            {skills.length === 0 ? (
              <div className="mt-3 rounded-3xl border border-dashed border-border bg-card/60 px-6 py-14 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-ember/10 text-ember">
                  <Sparkles className="h-5 w-5" />
                </span>
                <p className="mt-3 font-display text-lg">No skills yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Create your first skill or start from a template below — it applies to every
                  matching run automatically.
                </p>
              </div>
            ) : hasFolders ? (
              <div className="mt-3 space-y-7">
                {groups.map((group) => {
                  const folder = group.folder;
                  return (
                    <FolderSection
                      key={folder ?? "__ungrouped"}
                      group={group}
                      servers={servers}
                      onBulkSurface={(surface, on) =>
                        patchSettings({ skills: setFolderSurface(skills, folder, surface, on) })
                      }
                      onRename={
                        folder === null
                          ? undefined
                          : (to) => patchSettings({ skills: renameSkillFolder(skills, folder, to) })
                      }
                      onNewSkill={() => startNew(folder ?? "")}
                      onToggleSkill={toggleEnabled}
                      onEditSkill={startEdit}
                      onDeleteSkill={remove}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {skills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    servers={servers}
                    onToggle={(enabled) => toggleEnabled(skill.id, enabled)}
                    onEdit={() => startEdit(skill)}
                    onDelete={() => remove(skill.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {remainingCount > 0 ? (
            <section className="mt-10">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  Start from a template · {remainingCount}
                </h3>
                {remainingCount > 1 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 rounded-full border-border"
                    onClick={addAll}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add all
                  </Button>
                ) : null}
              </div>
              {templateGroups.map((group) => (
                <div key={group.id} className="mt-5">
                  <p className="text-sm font-medium">{group.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{group.hint}</p>
                  <div className="mt-2.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {group.templates.map((template) => (
                      <div
                        key={template.name}
                        className="flex items-center gap-3 rounded-3xl border border-dashed border-border bg-card/60 px-4 py-3.5 transition-colors hover:border-border/90 hover:bg-card"
                      >
                        <button
                          type="button"
                          onClick={() => setPreview(template)}
                          title="Preview the full instructions"
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        >
                          <span
                            className={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                              agentHue(template.name),
                            )}
                          >
                            <Sparkles className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{template.name}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {template.description}
                            </span>
                          </span>
                        </button>
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
                </div>
              ))}
            </section>
          ) : null}
          <TemplatePreviewDialog
            template={preview}
            onClose={() => setPreview(null)}
            onAdd={(template) => {
              addTemplate(template);
              setPreview(null);
            }}
          />
        </>
      )}
    </StudioPageShell>
  );
}

/**
 * Full-text look at a catalog template before adopting it: complete
 * instructions, where it applies, and the folder it lands in — the card's
 * truncated line never has to be trusted blindly.
 */
function TemplatePreviewDialog({
  template,
  onClose,
  onAdd,
}: {
  template: SkillTemplate | null;
  onClose: () => void;
  onAdd: (template: SkillTemplate) => void;
}) {
  return (
    <Dialog open={template !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {template ? (
        <DialogContent className="gap-0 rounded-3xl p-0">
          <DialogHeader className="border-b border-border/60 px-5 pb-4 pt-5 text-left sm:text-left">
            <div className="flex items-center gap-3 pr-6">
              <span
                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                  agentHue(template.name),
                )}
              >
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="truncate text-base">{template.name}</DialogTitle>
                <DialogDescription className="mt-1 text-xs leading-relaxed">
                  {template.description}
                </DialogDescription>
              </div>
            </div>
            <div className="flex flex-wrap gap-1 pt-2">
              {template.folder ? <MetaChip label={`📁 ${template.folder}`} /> : null}
              {SKILL_SURFACES.filter((surface) => template.surfaces[surface]).map((surface) => (
                <MetaChip key={surface} label={SKILL_SURFACE_LABEL[surface]} />
              ))}
            </div>
          </DialogHeader>
          <div className="max-h-[46vh] overflow-y-auto px-5 py-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Instructions — injected into matching runs
            </p>
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed">{template.content}</p>
          </div>
          <DialogFooter className="gap-2 border-t border-border/60 px-5 py-3.5">
            <Button variant="ghost" className="h-9 rounded-full px-4" onClick={onClose}>
              Close
            </Button>
            <Button
              className="h-9 gap-1.5 rounded-full bg-ember px-4 text-ember-foreground hover:bg-ember/90"
              onClick={() => onAdd(template)}
            >
              <Plus className="h-4 w-4" />
              Add skill
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * One folder of skills: header with per-surface bulk toggles (the fast way to
 * assign a whole folder to a tool), inline rename, and the member cards.
 */
function FolderSection({
  group,
  servers,
  onBulkSurface,
  onRename,
  onNewSkill,
  onToggleSkill,
  onEditSkill,
  onDeleteSkill,
}: {
  group: SkillFolderGroup;
  servers: McpServerConfig[];
  onBulkSurface: (surface: SkillSurface, on: boolean) => void;
  onRename?: (to: string) => void;
  onNewSkill: () => void;
  onToggleSkill: (id: string, enabled: boolean) => void;
  onEditSkill: (skill: Skill) => void;
  onDeleteSkill: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<boolean>(false);
  const [name, setName] = useState<string>("");

  const commitRename = () => {
    setRenaming(false);
    const next = name.trim();
    if (onRename && next && next !== group.folder) {
      onRename(next);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        {renaming ? (
          <Input
            value={name}
            autoFocus
            maxLength={MAX_SKILL_FOLDER_CHARS}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitRename();
              } else if (event.key === "Escape") {
                setRenaming(false);
              }
            }}
            className="h-8 w-44 rounded-lg border-border bg-white text-sm"
          />
        ) : (
          <p className="text-sm font-medium">
            {group.folder ?? "No folder"}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {group.skills.length}
            </span>
          </p>
        )}
        {onRename && !renaming ? (
          <button
            type="button"
            onClick={() => {
              setName(group.folder ?? "");
              setRenaming(true);
            }}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Rename folder ${group.folder ?? ""}`}
            title="Rename folder"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {SKILL_SURFACES.map((surface) => (
            <FolderSurfaceChip
              key={surface}
              surface={surface}
              skills={group.skills}
              onToggle={(on) => onBulkSurface(surface, on)}
            />
          ))}
          <button
            type="button"
            onClick={onNewSkill}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`New skill in ${group.folder ?? "no folder"}`}
            title="New skill here"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
        {group.skills.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            servers={servers}
            onToggle={(enabled) => onToggleSkill(skill.id, enabled)}
            onEdit={() => onEditSkill(skill)}
            onDelete={() => onDeleteSkill(skill.id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Folder-level surface toggle: shows how many member skills ride the surface
 * and flips them all at once. Partial states disclose the count — never a
 * silent "looks on but half is off".
 */
function FolderSurfaceChip({
  surface,
  skills,
  onToggle,
}: {
  surface: SkillSurface;
  skills: Skill[];
  onToggle: (on: boolean) => void;
}) {
  const total = skills.length;
  const on = skills.filter((skill) => skill.enabled && skill.surfaces[surface]).length;
  const all = on === total && total > 0;
  const label = SKILL_SURFACE_LABEL[surface];
  return (
    <button
      type="button"
      onClick={() => onToggle(!all)}
      aria-pressed={all}
      title={
        all
          ? `Turn ${label} off for all ${total} skills in this folder`
          : `Turn ${label} on for all ${total} skills in this folder`
      }
      className={cn(
        "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
        all
          ? "border-ember/60 bg-accent/70 text-foreground"
          : on > 0
            ? "border-border bg-card text-foreground"
            : "border-border/70 bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {on > 0 && !all ? (
        <span className="text-[10px] text-muted-foreground">
          {on}/{total}
        </span>
      ) : null}
    </button>
  );
}

function SkillCard({
  skill,
  servers,
  onToggle,
  onEdit,
  onDelete,
}: {
  skill: Skill;
  servers: McpServerConfig[];
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const surfaces = SKILL_SURFACES.filter((surface) => skill.surfaces[surface]);
  const connectors = connectorMeta(skill, servers);
  return (
    <div
      className={cn(
        "gera-card flex flex-col rounded-3xl p-4 transition-shadow hover:shadow-md",
        !skill.enabled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
            agentHue(skill.name),
          )}
        >
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{skill.name}</p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {skill.description || "Custom skill"}
          </p>
        </div>
        <Switch
          checked={skill.enabled}
          onCheckedChange={onToggle}
          aria-label={skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {surfaces.length > 0 ? (
          surfaces.map((surface) => <MetaChip key={surface} label={SKILL_SURFACE_LABEL[surface]} />)
        ) : (
          <MetaChip label="No surfaces" />
        )}
        {connectors.names.map((name) => (
          <span
            key={name}
            className="flex items-center gap-1 rounded-full bg-ember/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-ember"
          >
            <Plug className="h-2.5 w-2.5" />
            {name}
          </span>
        ))}
        {connectors.stale > 0 ? <MetaChip label={`${connectors.stale} removed`} /> : null}
      </div>
      <div className="mt-4 flex items-center gap-1.5 border-t border-border/50 pt-3">
        <Button size="sm" variant="outline" className="h-8 gap-1 rounded-full border-border" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={`Delete ${skill.name}`}
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

function SurfaceChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
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
      {label}
    </button>
  );
}

/**
 * Connector binding chip: pick state plus an honest connection dot — a bound
 * but disconnected server is visible before it ever fails a run.
 */
function ConnectorChip({
  name,
  connected,
  active,
  onClick,
}: {
  name: string;
  connected: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={connected ? name : `${name} — not connected right now`}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-ember/60 bg-accent/70 text-foreground"
          : "border-border/70 bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      <Plug className="h-3 w-3" />
      {name}
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-muted-foreground/40")}
      />
    </button>
  );
}
