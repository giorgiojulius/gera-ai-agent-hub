// Skills are reusable instruction packs that ride into chat turns, Deep
// Research runs, and Julius panels — with per-surface toggles and per-profile
// narrowing (null = all, like the builtins/MCP pools). These tests pin the
// normalization (skills live in the synced profile blob), the scoping rules,
// and the prompt-block format shared by browser and cloud runs.
import { describe, expect, it } from "vitest";

import { normalizeStoredSettings } from "@/lib/history";
import {
  MAX_SKILL_CONNECTORS,
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_FOLDER_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILLS,
  MAX_SKILLS_BLOCK_CHARS,
  SKILL_TEMPLATE_GROUPS,
  SKILL_TEMPLATES,
  addAllTemplates,
  buildSkillsBlock,
  filterSkillsByIds,
  groupSkillsByFolder,
  newSkill,
  normalizeSkills,
  renameSkillFolder,
  setFolderSurface,
  setSkillSurface,
  skillFolderNames,
  skillFromTemplate,
  skillPinnedServerIds,
  skillsForSurface,
  type SkillConnectorRef,
} from "@/lib/skills";
import type { Skill } from "@/lib/types";

function makeSkill(patch: Partial<Skill>): Skill {
  return { ...newSkill(), name: "Skill", content: "Do the thing.", ...patch };
}

describe("skills normalization", () => {
  it("returns [] for garbage and drops entries with neither name nor instructions", () => {
    expect(normalizeSkills(undefined)).toEqual([]);
    expect(normalizeSkills("nope")).toEqual([]);
    expect(normalizeSkills([null, 42, "x", { enabled: true }, { name: " ", content: "" }])).toEqual([]);
  });

  it("defaults legacy entries (no surfaces field) to every surface on", () => {
    const [skill] = normalizeSkills([{ name: "Old", content: "Rules." }]);
    expect(skill.surfaces).toEqual({ chat: true, research: true, julius: true });
    expect(skill.enabled).toBe(true);
    expect(skill.id.length).toBeGreaterThan(0);
  });

  it("keeps explicit surface offs and the enabled flag", () => {
    const [skill] = normalizeSkills([
      { name: "Picky", content: "Rules.", enabled: false, surfaces: { research: false } },
    ]);
    expect(skill.enabled).toBe(false);
    expect(skill.surfaces).toEqual({ chat: true, research: false, julius: true });
  });

  it("caps content length and the number of skills", () => {
    const huge = "x".repeat(MAX_SKILL_CONTENT_CHARS + 500);
    const many = Array.from({ length: MAX_SKILLS + 5 }, (_, index) => ({
      name: `S${index}`,
      content: index === 0 ? huge : "ok",
    }));
    const skills = normalizeSkills(many);
    expect(skills).toHaveLength(MAX_SKILLS);
    expect(skills[0].content).toHaveLength(MAX_SKILL_CONTENT_CHARS);
  });

  it("normalizes connector pins: dedupes, drops junk, caps, absent when empty", () => {
    const [pinned] = normalizeSkills([
      { name: "Pinned", content: "x", mcpServerIds: ["srv1", "srv1", " ", 42, "srv2"] },
    ]);
    expect(pinned.mcpServerIds).toEqual(["srv1", "srv2"]);
    const [over] = normalizeSkills([
      {
        name: "Over",
        content: "x",
        mcpServerIds: Array.from({ length: MAX_SKILL_CONNECTORS + 3 }, (_, index) => `s${index}`),
      },
    ]);
    expect(over.mcpServerIds).toHaveLength(MAX_SKILL_CONNECTORS);
    const [bare] = normalizeSkills([{ name: "Bare", content: "x" }]);
    expect(bare.mcpServerIds).toBeUndefined();
    const [junk] = normalizeSkills([{ name: "Junk", content: "x", mcpServerIds: "GitHub" }]);
    expect(junk.mcpServerIds).toBeUndefined();
  });

  it("rides through normalizeStoredSettings and defaults agents to all skills", () => {
    const settings = normalizeStoredSettings({
      skills: [{ id: "s1", name: "Brief", content: "TL;DR first." }],
      agents: [
        { id: "a1", name: "Scoped", skillIds: ["s1"] },
        { id: "a2", name: "Open" },
      ],
    });
    expect(settings.skills).toHaveLength(1);
    expect(settings.skills[0].id).toBe("s1");
    expect(settings.agents.find((agent) => agent.id === "a1")?.skillIds).toEqual(["s1"]);
    expect(settings.agents.find((agent) => agent.id === "a2")?.skillIds).toBeNull();
    // A blob without skills (every install before this feature) stays valid.
    expect(normalizeStoredSettings({}).skills).toEqual([]);
  });
});

describe("skillsForSurface", () => {
  const skills: Skill[] = [
    makeSkill({ id: "all", name: "Everywhere" }),
    makeSkill({ id: "off", name: "Disabled", enabled: false }),
    makeSkill({ id: "res", name: "Research only", surfaces: { chat: false, research: true, julius: false } }),
    makeSkill({ id: "empty", name: "Blank", content: "   " }),
  ];

  it("filters by enabled flag, surface, and non-empty instructions", () => {
    expect(skillsForSurface(skills, "chat").map((skill) => skill.id)).toEqual(["all"]);
    expect(skillsForSurface(skills, "research").map((skill) => skill.id)).toEqual(["all", "res"]);
    expect(skillsForSurface(skills, "julius").map((skill) => skill.id)).toEqual(["all"]);
  });

  it("honors profile narrowing: null = all, [] = none, subset = subset", () => {
    expect(skillsForSurface(skills, "research", { skillIds: null }).map((skill) => skill.id)).toEqual([
      "all",
      "res",
    ]);
    expect(skillsForSurface(skills, "research", { skillIds: [] })).toEqual([]);
    expect(skillsForSurface(skills, "research", { skillIds: ["res"] }).map((skill) => skill.id)).toEqual([
      "res",
    ]);
    // Ids of deleted skills in an allow-list simply never match.
    expect(skillsForSurface(skills, "chat", { skillIds: ["ghost"] })).toEqual([]);
  });
});

describe("buildSkillsBlock", () => {
  it("is empty for no skills and formats name, hint, and instructions", () => {
    expect(buildSkillsBlock([])).toBe("");
    const block = buildSkillsBlock([
      makeSkill({ name: "Tables", description: "Comparing options.", content: "Use markdown tables." }),
    ]);
    expect(block).toContain("SKILLS —");
    expect(block).toContain("### Skill: Tables");
    expect(block).toContain("When to apply: Comparing options.");
    expect(block).toContain("Use markdown tables.");
    expect(block).toContain("a direct user request always wins over a skill");
    // Skills steer HOW the agent works — they must never become the task
    // itself (the old header let thin research prompts "research the skills").
    expect(block).toContain("never the task itself");
  });

  it("omits skills past the budget with an honest note instead of silent truncation", () => {
    const big = makeSkill({ name: "Big", content: "y".repeat(MAX_SKILLS_BLOCK_CHARS - 100) });
    const extra = makeSkill({ name: "Extra", content: "z".repeat(500) });
    const block = buildSkillsBlock([big, extra]);
    expect(block).toContain("### Skill: Big");
    expect(block).not.toContain("### Skill: Extra");
    expect(block).toContain("1 enabled skill omitted");
  });

  it("skips the hint line when the description is blank", () => {
    const block = buildSkillsBlock([makeSkill({ name: "Bare", description: "" })]);
    expect(block).not.toContain("When to apply:");
  });

  it("discloses armed, down, and missing connectors — only when a pool is given", () => {
    const pool: SkillConnectorRef[] = [
      { id: "gh", name: "GitHub", enabled: true, status: "connected" },
      { id: "slack", name: "Slack", enabled: true, status: "error" },
    ];
    const skill = makeSkill({ name: "Ship", mcpServerIds: ["gh", "slack", "ghost"] });
    const block = buildSkillsBlock([skill], pool);
    expect(block).toContain("Connectors armed with this skill: GitHub");
    expect(block).toContain("Bound but not connected right now: Slack");
    expect(block).toContain("1 bound connector is not in this run's tool pool");
    // No pool (research/Julius runs take no MCP tools) — no promises at all.
    const bare = buildSkillsBlock([skill]);
    expect(bare).not.toContain("Connectors armed");
    expect(bare).not.toContain("Bound but not connected");
    // A pool without pins adds nothing.
    const unpinned = buildSkillsBlock([makeSkill({ name: "Plain" })], pool);
    expect(unpinned).not.toContain("Connectors armed");
  });
});

describe("skillPinnedServerIds", () => {
  it("unions pins across skills without duplicates", () => {
    const skills = [
      makeSkill({ name: "A", mcpServerIds: ["gh", "slack"] }),
      makeSkill({ name: "B", mcpServerIds: ["gh", "linear"] }),
      makeSkill({ name: "C" }),
    ];
    expect(skillPinnedServerIds(skills)).toEqual(["gh", "slack", "linear"]);
    expect(skillPinnedServerIds([])).toEqual([]);
  });
});

describe("skill templates", () => {
  it("are valid, within caps, uniquely named, and reach at least one surface", () => {
    const names = new Set(SKILL_TEMPLATES.map((template) => template.name));
    expect(names.size).toBe(SKILL_TEMPLATES.length);
    // The whole catalog must fit a fresh workspace in one "Add all".
    expect(SKILL_TEMPLATES.length).toBeLessThanOrEqual(MAX_SKILLS);
    for (const template of SKILL_TEMPLATES) {
      expect(template.name.trim().length).toBeGreaterThan(0);
      expect(template.name.length).toBeLessThanOrEqual(MAX_SKILL_NAME_CHARS);
      expect(template.description.trim().length).toBeGreaterThan(0);
      expect(template.description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_CHARS);
      expect(template.content.trim().length).toBeGreaterThan(0);
      expect(template.content.length).toBeLessThanOrEqual(MAX_SKILL_CONTENT_CHARS);
      expect(template.enabled).toBe(true);
      expect(Object.values(template.surfaces).some(Boolean)).toBe(true);
    }
  });

  it("groups flatten to the flat catalog and every group is non-empty and labeled", () => {
    expect(SKILL_TEMPLATE_GROUPS.flatMap((group) => group.templates)).toEqual(SKILL_TEMPLATES);
    const ids = new Set(SKILL_TEMPLATE_GROUPS.map((group) => group.id));
    expect(ids.size).toBe(SKILL_TEMPLATE_GROUPS.length);
    for (const group of SKILL_TEMPLATE_GROUPS) {
      expect(group.templates.length).toBeGreaterThan(0);
      expect(group.label.trim().length).toBeGreaterThan(0);
      expect(group.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it("ships the GitHub delivery playbooks in the Playbooks folder", () => {
    const playbooks = SKILL_TEMPLATE_GROUPS.find((group) => group.id === "playbooks");
    expect(playbooks).toBeDefined();
    const names = (playbooks?.templates ?? []).map((template) => template.name);
    expect(names).toEqual(["Ship a PR", "Debug CI", "Babysit a PR", "Maintain the feature map"]);
    for (const template of playbooks?.templates ?? []) {
      expect(template.folder).toBe("Playbooks");
      expect(template.surfaces.chat).toBe(true);
    }
    // The no-merge rail must be stated in the playbooks that end at a PR.
    for (const name of ["Ship a PR", "Babysit a PR", "Maintain the feature map"]) {
      const template = playbooks?.templates.find((item) => item.name === name);
      expect(template?.content.toLowerCase()).toContain("never merge");
    }
  });

  it("fits the whole catalog into one run's skills budget without omissions", () => {
    const block = buildSkillsBlock(SKILL_TEMPLATES.map(skillFromTemplate));
    expect(block).not.toContain("omitted");
    for (const template of SKILL_TEMPLATES) {
      expect(block).toContain(`### Skill: ${template.name}`);
    }
  });

  it("instantiates with fresh identity and an independent surfaces object", () => {
    const template = SKILL_TEMPLATES[0];
    const a = skillFromTemplate(template);
    const b = skillFromTemplate(template);
    expect(a.id).not.toBe(b.id);
    a.surfaces.chat = false;
    expect(b.surfaces.chat).toBe(true);
    expect(template.surfaces.chat).toBe(true);
  });
});

describe("setSkillSurface", () => {
  it("turning a surface on re-enables a globally disabled skill", () => {
    const skills = [
      makeSkill({ id: "s1", enabled: false, surfaces: { chat: false, research: true, julius: true } }),
    ];
    const next = setSkillSurface(skills, "s1", "chat", true);
    expect(next[0].enabled).toBe(true);
    expect(next[0].surfaces.chat).toBe(true);
  });

  it("turning a surface off keeps the skill enabled for the other surfaces", () => {
    const skills = [makeSkill({ id: "s1" })];
    const next = setSkillSurface(skills, "s1", "julius", false);
    expect(next[0].enabled).toBe(true);
    expect(next[0].surfaces).toEqual({ chat: true, research: true, julius: false });
  });

  it("leaves other skills untouched and never mutates the input", () => {
    const skills = [makeSkill({ id: "s1" }), makeSkill({ id: "s2" })];
    const next = setSkillSurface(skills, "s1", "chat", false);
    expect(next[1]).toBe(skills[1]);
    expect(skills[0].surfaces.chat).toBe(true);
    expect(next[0].surfaces.chat).toBe(false);
  });
});

describe("skill folders", () => {
  it("normalizes folder: trims, caps, and keeps '' as explicitly ungrouped", () => {
    const [long] = normalizeSkills([
      { name: "A", content: "x", folder: `  ${"f".repeat(MAX_SKILL_FOLDER_CHARS + 10)}  ` },
    ]);
    expect(long.folder).toHaveLength(MAX_SKILL_FOLDER_CHARS);
    // Explicit "" (user cleared it) never re-adopts a catalog folder.
    const [cleared] = normalizeSkills([{ name: "Coding", content: "x", folder: "" }]);
    expect(cleared.folder).toBe("");
  });

  it("pre-folder blobs adopt the catalog folder by template name; custom names stay ungrouped", () => {
    const [coding] = normalizeSkills([{ name: "Coding", content: "x" }]);
    expect(coding.folder).toBe("Engineering");
    const [custom] = normalizeSkills([{ name: "My thing", content: "x" }]);
    expect(custom.folder).toBeUndefined();
  });

  it("groups in first-occurrence order; '' folders land under null", () => {
    const skills = [
      makeSkill({ id: "1", folder: "B" }),
      makeSkill({ id: "2", folder: "" }),
      makeSkill({ id: "3", folder: "A" }),
      makeSkill({ id: "4", folder: "B" }),
    ];
    const groups = groupSkillsByFolder(skills);
    expect(groups.map((group) => group.folder)).toEqual(["B", null, "A"]);
    expect(groups[0].skills.map((skill) => skill.id)).toEqual(["1", "4"]);
    expect(skillFolderNames(skills)).toEqual(["B", "A"]);
  });

  it("setFolderSurface bulk-flips one folder only and re-enables disabled members on ON", () => {
    const skills = [
      makeSkill({
        id: "1",
        folder: "F",
        enabled: false,
        surfaces: { chat: false, research: true, julius: true },
      }),
      makeSkill({ id: "2", folder: "F" }),
      makeSkill({ id: "3", folder: "G" }),
    ];
    const on = setFolderSurface(skills, "F", "chat", true);
    expect(on[0].enabled).toBe(true);
    expect(on[0].surfaces.chat).toBe(true);
    expect(on[2]).toBe(skills[2]);
    const off = setFolderSurface(skills, "F", "chat", false);
    // OFF touches only the surface — the master toggle stays as it was.
    expect(off[0].enabled).toBe(false);
    expect(off[1].enabled).toBe(true);
    expect(off[1].surfaces).toEqual({ chat: false, research: true, julius: true });
  });

  it("setFolderSurface with null targets only ungrouped skills", () => {
    const skills = [makeSkill({ id: "1", folder: "" }), makeSkill({ id: "2", folder: "F" })];
    const next = setFolderSurface(skills, null, "julius", false);
    expect(next[0].surfaces.julius).toBe(false);
    expect(next[1]).toBe(skills[1]);
  });

  it("renameSkillFolder renames members only; empty target ungroups them for good", () => {
    const skills = [makeSkill({ id: "1", folder: "Old" }), makeSkill({ id: "2", folder: "Keep" })];
    const renamed = renameSkillFolder(skills, "Old", "  New  ");
    expect(renamed[0].folder).toBe("New");
    expect(renamed[1]).toBe(skills[1]);
    expect(renameSkillFolder(skills, "Old", "")[0].folder).toBe("");
  });

  it("every catalog template ships with a folder within the cap", () => {
    for (const template of SKILL_TEMPLATES) {
      expect((template.folder ?? "").trim().length).toBeGreaterThan(0);
      expect((template.folder ?? "").length).toBeLessThanOrEqual(MAX_SKILL_FOLDER_CHARS);
    }
  });
});

describe("filterSkillsByIds", () => {
  const skills = [makeSkill({ id: "a" }), makeSkill({ id: "b" })];

  it("null keeps everything, an empty list removes everything", () => {
    expect(filterSkillsByIds(skills, null)).toHaveLength(2);
    expect(filterSkillsByIds(skills, [])).toHaveLength(0);
  });

  it("narrows to the listed ids", () => {
    expect(filterSkillsByIds(skills, ["b"]).map((skill) => skill.id)).toEqual(["b"]);
  });
});

describe("addAllTemplates", () => {
  it("adopts the full catalog into an empty workspace with fresh unique ids", () => {
    const { skills, added, skipped } = addAllTemplates([]);
    expect(added).toBe(SKILL_TEMPLATES.length);
    expect(skipped).toBe(0);
    expect(skills.map((skill) => skill.name)).toEqual(SKILL_TEMPLATES.map((t) => t.name));
    expect(new Set(skills.map((skill) => skill.id)).size).toBe(skills.length);
  });

  it("skips templates already adopted (matched by name) and keeps existing skills", () => {
    const first = skillFromTemplate(SKILL_TEMPLATES[0]);
    const custom = makeSkill({ id: "mine", name: "My own skill" });
    const { skills, added, skipped } = addAllTemplates([first, custom]);
    expect(added).toBe(SKILL_TEMPLATES.length - 1);
    expect(skipped).toBe(0);
    expect(skills.filter((skill) => skill.name === first.name)).toHaveLength(1);
    expect(skills.some((skill) => skill.id === "mine")).toBe(true);
  });

  it("is a no-op when the whole catalog is already adopted", () => {
    const once = addAllTemplates([]);
    const twice = addAllTemplates(once.skills);
    expect(twice.added).toBe(0);
    expect(twice.skipped).toBe(0);
    expect(twice.skills).toHaveLength(once.skills.length);
  });

  it("honors MAX_SKILLS and reports what did not fit instead of silently dropping", () => {
    const existing = Array.from({ length: MAX_SKILLS - 2 }, (_, index) =>
      makeSkill({ name: `Custom ${index}` }),
    );
    const { skills, added, skipped } = addAllTemplates(existing);
    expect(added).toBe(2);
    expect(skipped).toBe(SKILL_TEMPLATES.length - 2);
    expect(skills).toHaveLength(MAX_SKILLS);
    // The adopted pair is the catalog's first two entries, in order.
    expect(skills.slice(0, 2).map((skill) => skill.name)).toEqual(
      SKILL_TEMPLATES.slice(0, 2).map((template) => template.name),
    );
  });
});
