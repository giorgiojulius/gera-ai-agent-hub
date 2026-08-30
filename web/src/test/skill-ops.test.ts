// Chat-driven skill editing: the model writes skill.create / skill.update ops
// into the same ```action fence the personal hub uses. These tests pin the
// parser's tolerance, the apply semantics (idempotent creates, honest
// rejections, no delete op), and the editor context block.
import { describe, expect, it } from "vitest";

import { extractActionOps } from "@/lib/life";
import { MAX_SKILLS, newSkill } from "@/lib/skills";
import {
  applySkillOps,
  buildSkillsEditorContext,
  describeSkillOp,
  extractSkillOps,
  parseSkillOps,
  type SkillOp,
} from "@/lib/skill-ops";
import type { Skill } from "@/lib/types";

function makeSkill(patch: Partial<Skill>): Skill {
  return { ...newSkill(), name: "Skill", content: "Do the thing.", ...patch };
}

const MIXED_REPLY = [
  "Saved.",
  "```action",
  JSON.stringify([
    { op: "memory.save", text: "Prefers concise answers", category: "prefs" },
    { op: "skill.create", name: "Release notes", description: "Writing release notes", content: "Lead with user impact." },
    { op: "skill.update", id: "abc", set: { enabled: false } },
  ]),
  "```",
  "Done.",
].join("\n");

describe("skill ops parsing", () => {
  it("picks skill ops out of a fence shared with hub ops — and vice versa", () => {
    const skillOps = extractSkillOps(MIXED_REPLY);
    expect(skillOps).toHaveLength(2);
    expect(skillOps[0].op).toBe("skill.create");
    expect(skillOps[1].op).toBe("skill.update");
    // The hub parser must keep ignoring skill ops.
    const lifeOps = extractActionOps(MIXED_REPLY);
    expect(lifeOps).toHaveLength(1);
    expect(lifeOps[0].op).toBe("memory.save");
  });

  it("accepts create aliases and defaults; drops creates without name or content", () => {
    const [op] = parseSkillOps(
      JSON.stringify([{ op: "skill.add", title: "Briefs", instructions: "TL;DR first." }]),
    );
    expect(op).toEqual({
      op: "skill.create",
      name: "Briefs",
      description: "",
      content: "TL;DR first.",
      folder: "",
      surfaces: null,
      enabled: true,
      connectors: null,
    });
    expect(parseSkillOps(JSON.stringify([{ op: "skill.create", name: "No content" }]))).toEqual([]);
    expect(parseSkillOps(JSON.stringify([{ op: "skill.create", content: "No name" }]))).toEqual([]);
  });

  it("clamps oversized fields at parse time", () => {
    const [op] = parseSkillOps(
      JSON.stringify([
        {
          op: "skill.create",
          name: "N".repeat(200),
          description: "D".repeat(500),
          content: "C".repeat(9000),
          folder: "F".repeat(100),
        },
      ]),
    );
    expect(op.op).toBe("skill.create");
    if (op.op === "skill.create") {
      expect(op.name).toHaveLength(80);
      expect(op.description).toHaveLength(240);
      expect(op.content).toHaveLength(6000);
      expect(op.folder).toHaveLength(40);
    }
  });

  it("parses updates in set form and in top-level-patch form", () => {
    const [bySet] = parseSkillOps(
      JSON.stringify([{ op: "skill.update", id: "s1", set: { content: "New text", surfaces: { chat: true } } }]),
    );
    expect(bySet).toEqual({
      op: "skill.update",
      target: "s1",
      set: { content: "New text", surfaces: ["chat"] },
    });
    // Top level with a name target: "name" served as the target, not a rename.
    const [byName] = parseSkillOps(
      JSON.stringify([{ op: "skill.update", name: "PR review", enabled: false }]),
    );
    expect(byName).toEqual({ op: "skill.update", target: "PR review", set: { enabled: false } });
    // Top level with an id target: "name" is a rename.
    const [rename] = parseSkillOps(
      JSON.stringify([{ op: "skill.update", id: "s1", name: "New name" }]),
    );
    expect(rename).toEqual({ op: "skill.update", target: "s1", set: { name: "New name" } });
    // Nothing to change → dropped.
    expect(parseSkillOps(JSON.stringify([{ op: "skill.update", id: "s1" }]))).toEqual([]);
  });

  it("parses connector bindings: names on create, [] as an explicit clear on update", () => {
    const [create] = parseSkillOps(
      JSON.stringify([
        { op: "skill.create", name: "Ship", content: "x", connectors: ["GitHub", "GitHub", " ", 7] },
      ]),
    );
    expect(create.op).toBe("skill.create");
    if (create.op === "skill.create") {
      expect(create.connectors).toEqual(["GitHub"]);
    }
    const [clear] = parseSkillOps(
      JSON.stringify([{ op: "skill.update", id: "s1", set: { connectors: [] } }]),
    );
    expect(clear).toEqual({ op: "skill.update", target: "s1", set: { connectors: [] } });
    // "mcp" alias works at the top level too.
    const [aliased] = parseSkillOps(
      JSON.stringify([{ op: "skill.update", id: "s1", mcp: ["Slack"] }]),
    );
    expect(aliased).toEqual({ op: "skill.update", target: "s1", set: { connectors: ["Slack"] } });
  });
});

describe("applySkillOps", () => {
  const createOp: SkillOp = {
    op: "skill.create",
    name: "Briefs",
    description: "Short answers",
    content: "TL;DR first.",
    folder: "Writing",
    surfaces: ["chat", "julius"],
    enabled: true,
    connectors: null,
  };

  it("creates a skill with the requested surfaces, prepended", () => {
    const existing = makeSkill({ name: "Old" });
    const { skills, outcomes } = applySkillOps([existing], [createOp]);
    expect(outcomes).toEqual([{ kind: "created", name: "Briefs" }]);
    expect(skills).toHaveLength(2);
    expect(skills[0].name).toBe("Briefs");
    expect(skills[0].surfaces).toEqual({ chat: true, research: false, julius: true });
    expect(skills[0].id.length).toBeGreaterThan(0);
    expect(skills[1]).toBe(existing);
  });

  it("defaults surfaces to all-on when the op names none", () => {
    const { skills } = applySkillOps([], [{ ...createOp, surfaces: null }]);
    expect(skills[0].surfaces).toEqual({ chat: true, research: true, julius: true });
  });

  it("treats a create with an existing name as an update — settles never duplicate", () => {
    const existing = makeSkill({ name: "briefs", description: "Keep", folder: "Old" });
    const { skills, outcomes } = applySkillOps([existing], [createOp]);
    expect(outcomes).toEqual([{ kind: "updated", name: "Briefs" }]);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe(existing.id);
    expect(skills[0].content).toBe("TL;DR first.");
    expect(skills[0].folder).toBe("Writing");
  });

  it("rejects creates over the skills cap with an honest reason", () => {
    const full = Array.from({ length: MAX_SKILLS }, (_, index) => makeSkill({ name: `S${index}` }));
    const { skills, outcomes } = applySkillOps(full, [createOp]);
    expect(skills).toHaveLength(MAX_SKILLS);
    expect(outcomes[0].kind).toBe("rejected");
    if (outcomes[0].kind === "rejected") {
      expect(outcomes[0].reason).toContain(`${MAX_SKILLS}`);
    }
  });

  it("updates by id and by case-insensitive name; unknown targets are rejected", () => {
    const skill = makeSkill({ name: "PR review", content: "Old rules." });
    const byId = applySkillOps([skill], [{ op: "skill.update", target: skill.id, set: { content: "New rules." } }]);
    expect(byId.outcomes).toEqual([{ kind: "updated", name: "PR review" }]);
    expect(byId.skills[0].content).toBe("New rules.");

    const byName = applySkillOps([skill], [{ op: "skill.update", target: "pr REVIEW", set: { enabled: false } }]);
    expect(byName.skills[0].enabled).toBe(false);
    expect(byName.skills[0].content).toBe("Old rules.");

    const missing = applySkillOps([skill], [{ op: "skill.update", target: "nope", set: { enabled: false } }]);
    expect(missing.outcomes[0].kind).toBe("rejected");
    expect(missing.skills).toEqual([skill]);
  });

  it("applies surface changes as a full record", () => {
    const skill = makeSkill({ name: "Scoped" });
    const { skills } = applySkillOps(
      [skill],
      [{ op: "skill.update", target: skill.id, set: { surfaces: ["research"] } }],
    );
    expect(skills[0].surfaces).toEqual({ chat: false, research: true, julius: false });
  });

  it("resolves connectors by name or id against the pool — unknowns ride back as a note", () => {
    const pool = [
      { id: "srv-gh", name: "GitHub" },
      { id: "srv-slack", name: "Slack" },
    ];
    const { skills, outcomes } = applySkillOps(
      [],
      [{ ...createOp, connectors: ["github", "srv-slack", "Linear"] }],
      { connectors: pool },
    );
    expect(skills[0].mcpServerIds).toEqual(["srv-gh", "srv-slack"]);
    expect(outcomes[0].kind).toBe("created");
    if (outcomes[0].kind === "created") {
      expect(outcomes[0].note).toContain("Linear");
    }
  });

  it("updates bindings as a full replacement and [] clears them", () => {
    const pool = [{ id: "srv-gh", name: "GitHub" }];
    const skill = makeSkill({ name: "Ship", mcpServerIds: ["srv-old"] });
    const replaced = applySkillOps(
      [skill],
      [{ op: "skill.update", target: skill.id, set: { connectors: ["GitHub"] } }],
      { connectors: pool },
    );
    expect(replaced.skills[0].mcpServerIds).toEqual(["srv-gh"]);
    const cleared = applySkillOps(
      [skill],
      [{ op: "skill.update", target: skill.id, set: { connectors: [] } }],
      { connectors: pool },
    );
    expect(cleared.skills[0].mcpServerIds).toBeUndefined();
    // Ops without a connectors field leave the binding untouched.
    const untouched = applySkillOps(
      [skill],
      [{ op: "skill.update", target: skill.id, set: { enabled: false } }],
      { connectors: pool },
    );
    expect(untouched.skills[0].mcpServerIds).toEqual(["srv-old"]);
  });
});

describe("buildSkillsEditorContext", () => {
  it("carries the protocol, the no-delete rail, and an empty-state note", () => {
    const block = buildSkillsEditorContext([]);
    expect(block).toContain("skill.create");
    expect(block).toContain("skill.update");
    expect(block).toContain("no delete op");
    expect(block).toContain("none yet");
  });

  it("lists each skill with id, state, and a content preview", () => {
    const skill = makeSkill({
      name: "PR review",
      description: "Reviewing diffs",
      folder: "Engineering",
      enabled: false,
      content: "Review only real code.",
    });
    const block = buildSkillsEditorContext([skill]);
    expect(block).toContain(`id: ${skill.id}`);
    expect(block).toContain("PR review");
    expect(block).toContain("DISABLED");
    expect(block).toContain("folder: Engineering");
    expect(block).toContain("when: Reviewing diffs");
    expect(block).toContain("Review only real code.");
  });

  it("lists the bindable connector pool honestly and labels bound skills", () => {
    const pool = [
      { id: "srv-gh", name: "GitHub", enabled: true, status: "connected" as const },
      { id: "srv-slack", name: "Slack", enabled: false, status: "idle" as const },
    ];
    const skill = makeSkill({ name: "Ship", mcpServerIds: ["srv-gh", "ghost"] });
    const block = buildSkillsEditorContext([skill], pool);
    expect(block).toContain('MCP CONNECTORS (bindable via "connectors"):');
    expect(block).toContain("id: srv-gh | GitHub | connected");
    expect(block).toContain("id: srv-slack | Slack | NOT CONNECTED");
    expect(block).toContain("connectors: GitHub, 1 removed");
    // No pool configured — the model is told not to invent names.
    const empty = buildSkillsEditorContext([skill]);
    expect(empty).toContain("none configured");
    expect(empty).toContain("Do not invent connector names");
  });

  it("stays inside the registry budget and discloses omissions", () => {
    // Worst-case entries: max-length names, folders, and descriptions push the
    // per-skill line to ~700 chars — 24 of them overflow the 12k budget.
    const many = Array.from({ length: MAX_SKILLS }, (_, index) =>
      makeSkill({
        name: `Skill ${index} ${"n".repeat(60)}`.slice(0, 80),
        folder: "f".repeat(40),
        description: "d".repeat(240),
        content: "x".repeat(6000),
      }),
    );
    const block = buildSkillsEditorContext(many);
    expect(block.length).toBeLessThan(16_000);
    expect(block).toMatch(/more skills? not listed/);
  });
});

describe("describeSkillOp", () => {
  it("labels creates and updates, hiding raw ids", () => {
    expect(describeSkillOp({ op: "skill.create", name: "Briefs", description: "", content: "x", folder: "", surfaces: null, enabled: true, connectors: null })).toEqual({ kind: "create", label: "Skill: Briefs" });
    expect(describeSkillOp({ op: "skill.update", target: "PR review", set: { enabled: false } })).toEqual({ kind: "done", label: "Skill updated: PR review" });
    expect(describeSkillOp({ op: "skill.update", target: "1c9f9c7e-2b6a-4b8e-9f1d-0a2b3c4d5e6f", set: { enabled: false } }).label).toBe("Skill updated");
    expect(describeSkillOp({ op: "skill.update", target: "abc", set: { name: "Renamed" } }).label).toBe("Skill updated: Renamed");
  });
});
