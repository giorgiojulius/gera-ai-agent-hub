import { newId } from "@/lib/env";
import type { AgentProfile, McpServerConfig, Skill, SkillSurface } from "@/lib/types";

/** Skills ride inside the synced profile blob — caps keep it well under the sync limit. */
export const MAX_SKILLS = 24;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_DESCRIPTION_CHARS = 240;
export const MAX_SKILL_CONTENT_CHARS = 6_000;
export const MAX_SKILL_FOLDER_CHARS = 40;
/** Max MCP connectors one skill can pin. */
export const MAX_SKILL_CONNECTORS = 8;

/** The slice of a connector config that skill bindings need for honest disclosure. */
export type SkillConnectorRef = Pick<McpServerConfig, "id" | "name" | "enabled" | "status">;
/** Prompt budget for one run — skills past it are omitted with an honest note. */
export const MAX_SKILLS_BLOCK_CHARS = 20_000;

export const SKILL_SURFACES: SkillSurface[] = ["chat", "research", "julius"];

export const SKILL_SURFACE_LABEL: Record<SkillSurface, string> = {
  chat: "Chat",
  research: "Deep Research",
  julius: "Julius",
};

export function newSkill(): Skill {
  return {
    id: newId(),
    name: "",
    description: "",
    content: "",
    // "" = explicitly ungrouped; only legacy pre-folder blobs (no folder key
    // at all) may adopt a catalog folder by template name in normalizeSkill.
    folder: "",
    enabled: true,
    surfaces: { chat: true, research: true, julius: true },
    createdAt: Date.now(),
  };
}

/** Validates one stored skill; entries with neither a name nor instructions die. */
export function normalizeSkill(value: unknown): Skill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<Skill> & { surfaces?: Partial<Record<SkillSurface, boolean>> };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const content = typeof raw.content === "string" ? raw.content : "";
  if (!name && content.trim().length === 0) {
    return null;
  }
  const pins = normalizeSkillPins(raw.mcpServerIds);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
    name: (name || "Skill").slice(0, MAX_SKILL_NAME_CHARS),
    description:
      typeof raw.description === "string"
        ? raw.description.slice(0, MAX_SKILL_DESCRIPTION_CHARS)
        : "",
    content: content.slice(0, MAX_SKILL_CONTENT_CHARS),
    // Folder is pure organization metadata. Strings are kept verbatim (trimmed;
    // "" = explicitly ungrouped). Pre-folder blobs have no folder key at all —
    // catalog skills recognized by name adopt their catalog folder once.
    folder:
      typeof raw.folder === "string"
        ? raw.folder.trim().slice(0, MAX_SKILL_FOLDER_CHARS)
        : TEMPLATE_FOLDER_BY_NAME.get(name),
    enabled: raw.enabled !== false,
    // Legacy/partial blobs default every surface to on — a skill someone
    // wrote before per-surface toggles keeps working everywhere.
    surfaces: {
      chat: raw.surfaces?.chat !== false,
      research: raw.surfaces?.research !== false,
      julius: raw.surfaces?.julius !== false,
    },
    ...(pins.length > 0 ? { mcpServerIds: pins } : {}),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
  };
}

/** Deduped, capped connector pins from a stored blob; [] when absent or junk. */
function normalizeSkillPins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const pins: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const id = item.trim();
    if (id.length > 0 && !pins.includes(id)) {
      pins.push(id);
    }
  }
  return pins.slice(0, MAX_SKILL_CONNECTORS);
}

export function normalizeSkills(value: unknown): Skill[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeSkill)
    .filter((skill): skill is Skill => skill !== null)
    .slice(0, MAX_SKILLS);
}

/**
 * Skills that ride into one run: enabled, targeting this surface, and — when
 * the thread runs under a profile — allowed by the profile's skill scoping
 * (null = all, like the builtins/MCP pools).
 */
export function skillsForSurface(
  skills: Skill[],
  surface: SkillSurface,
  agent?: Pick<AgentProfile, "skillIds"> | null,
): Skill[] {
  const allow = agent?.skillIds ?? null;
  return skills.filter(
    (skill) =>
      skill.enabled &&
      skill.surfaces[surface] &&
      skill.content.trim().length > 0 &&
      (allow === null || allow.includes(skill.id)),
  );
}

/**
 * Applies a per-run allow-list on top of surface filtering — used by
 * per-automation scoping (null = all, mirroring the MCP pools).
 */
export function filterSkillsByIds(skills: Skill[], ids: string[] | null): Skill[] {
  if (ids === null) {
    return skills;
  }
  return skills.filter((skill) => ids.includes(skill.id));
}

/**
 * Union of MCP connector ids pinned by these skills — the servers a run must
 * arm because an active skill depends on them. Pins override only the
 * auto-router's heuristic; explicit profile/automation narrowing happens
 * upstream, so a pinned server outside the scoped pool never resurrects.
 */
export function skillPinnedServerIds(skills: Skill[]): string[] {
  const ids: string[] = [];
  for (const skill of skills) {
    for (const id of skill.mcpServerIds ?? []) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Flips whether one skill rides a surface (used by the composer's per-surface
 * toggles). Turning ON also re-enables a globally disabled skill — that is
 * what the click means in a surface menu; turning OFF touches only that
 * surface, so the skill keeps riding the others.
 */
export function setSkillSurface(
  skills: Skill[],
  id: string,
  surface: SkillSurface,
  on: boolean,
): Skill[] {
  return skills.map((skill) =>
    skill.id === id
      ? {
          ...skill,
          enabled: on ? true : skill.enabled,
          surfaces: { ...skill.surfaces, [surface]: on },
        }
      : skill,
  );
}

/** Folder key for grouping: a non-empty trimmed name, or null for ungrouped. */
export function skillFolderOf(skill: Skill): string | null {
  const folder = skill.folder?.trim() ?? "";
  return folder.length > 0 ? folder : null;
}

export type SkillFolderGroup = { folder: string | null; skills: Skill[] };

/**
 * Groups skills by folder in first-occurrence order — no alphabetical
 * reshuffling, the order users curated stays intact. Ungrouped skills ride
 * under folder: null.
 */
export function groupSkillsByFolder(skills: Skill[]): SkillFolderGroup[] {
  const groups: SkillFolderGroup[] = [];
  const at = new Map<string | null, number>();
  for (const skill of skills) {
    const key = skillFolderOf(skill);
    const index = at.get(key);
    if (index === undefined) {
      at.set(key, groups.length);
      groups.push({ folder: key, skills: [skill] });
    } else {
      groups[index].skills.push(skill);
    }
  }
  return groups;
}

/** Existing folder names in first-occurrence order — feeds editor suggestions. */
export function skillFolderNames(skills: Skill[]): string[] {
  const names: string[] = [];
  for (const skill of skills) {
    const key = skillFolderOf(skill);
    if (key !== null && !names.includes(key)) {
      names.push(key);
    }
  }
  return names;
}

/**
 * setSkillSurface for a whole folder (null = ungrouped skills): ON re-enables
 * globally disabled members, OFF touches only that surface — one click
 * assigns or pulls an entire folder for a tool.
 */
export function setFolderSurface(
  skills: Skill[],
  folder: string | null,
  surface: SkillSurface,
  on: boolean,
): Skill[] {
  return skills.map((skill) =>
    skillFolderOf(skill) === folder
      ? {
          ...skill,
          enabled: on ? true : skill.enabled,
          surfaces: { ...skill.surfaces, [surface]: on },
        }
      : skill,
  );
}

/**
 * Renames a folder across all member skills; an empty target moves them out
 * of folders (stored as explicit "" so they never re-adopt a catalog folder).
 */
export function renameSkillFolder(skills: Skill[], from: string, to: string): Skill[] {
  const target = to.trim().slice(0, MAX_SKILL_FOLDER_CHARS);
  return skills.map((skill) =>
    skillFolderOf(skill) === from ? { ...skill, folder: target } : skill,
  );
}

const SKILLS_HEADER =
  'SKILLS — reusable instruction packs the user enabled for this run. Apply each skill whose "When to apply" matches the task at hand; skip the ones that clearly do not. Skills shape HOW you work — a direct user request always wins over a skill. Skills are never the task itself: do not research, summarize, or answer about a skill unless the user explicitly asks about their skills.';

/**
 * One honest line about a skill's bound connectors, for runs that take MCP
 * tools (a pool is passed only then). Armed names are promised; bound-but-
 * unavailable ones are disclosed so the model never pretends to have them.
 */
function skillConnectorLine(skill: Skill, connectors?: SkillConnectorRef[]): string {
  const pins = skill.mcpServerIds ?? [];
  if (pins.length === 0 || !connectors) {
    return "";
  }
  const armed: string[] = [];
  const down: string[] = [];
  let missing = 0;
  for (const id of pins) {
    const server = connectors.find((item) => item.id === id);
    if (!server) {
      missing += 1;
    } else if (server.enabled && server.status === "connected") {
      armed.push(server.name);
    } else {
      down.push(server.name);
    }
  }
  const parts: string[] = [];
  if (armed.length > 0) {
    parts.push(`Connectors armed with this skill: ${armed.join(", ")} — their tools are available this turn.`);
  }
  if (down.length > 0) {
    parts.push(`Bound but not connected right now: ${down.join(", ")} — say so if the task needs them (fixable on the Connections page).`);
  }
  if (missing > 0) {
    parts.push(`${missing} bound connector${missing === 1 ? " is" : "s are"} not in this run's tool pool (removed or excluded by profile scoping).`);
  }
  return parts.join(" ");
}

/**
 * Formats skills into the system-prompt block shared by chat, Deep Research,
 * and Julius runs. Overflow past the budget is disclosed, never silent.
 * Pass the run's connector pool ONLY for runs that take MCP tools (chat) —
 * research/Julius omit it so the block never promises tools they don't have.
 */
export function buildSkillsBlock(skills: Skill[], connectors?: SkillConnectorRef[]): string {
  if (skills.length === 0) {
    return "";
  }
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const skill of skills) {
    const description = skill.description.trim();
    const entry = [
      `### Skill: ${skill.name}`,
      description ? `When to apply: ${description}` : "",
      skillConnectorLine(skill, connectors),
      skill.content.trim(),
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    if (used + entry.length > MAX_SKILLS_BLOCK_CHARS) {
      omitted += 1;
      continue;
    }
    parts.push(entry);
    used += entry.length;
  }
  if (parts.length === 0) {
    return "";
  }
  const tail =
    omitted > 0
      ? `\n\n[${omitted} enabled skill${omitted === 1 ? "" : "s"} omitted — this run's skills budget is full.]`
      : "";
  return `${SKILLS_HEADER}\n\n${parts.join("\n\n")}${tail}`;
}

export type SkillTemplate = Omit<Skill, "id" | "createdAt">;

export type SkillTemplateGroup = {
  id: "essentials" | "workflows" | "playbooks";
  label: string;
  hint: string;
  templates: SkillTemplate[];
};

/**
 * Everyday-craft templates. Instructions are English on purpose — models
 * follow them more precisely; the answer language still follows the user.
 */
const ESSENTIAL_TEMPLATES: SkillTemplate[] = [
  {
    name: "Coding",
    folder: "Engineering",
    description: "Writing or changing code — features, functions, refactors, scripts.",
    content:
      "Deliver complete, runnable code — no placeholders, no TODOs, no 'rest stays the same' ellipses. Match the language's idioms and the project's existing conventions when code is shown. Handle errors and edge cases explicitly (empty input, nulls, failure paths), not just the happy path. State assumptions about environment, versions, or inputs before the code. Never invent APIs, flags, or library functions — if unsure something exists, say so instead of guessing. After the code, explain the two or three decisions that matter (trade-offs, gotchas) in a few lines; skip line-by-line narration.",
    enabled: true,
    surfaces: { chat: true, research: false, julius: true },
  },
  {
    name: "Debugging",
    folder: "Engineering",
    description: "Something is broken: errors, crashes, wrong output, 'it doesn't work'.",
    content:
      "Work from evidence, not vibes. First restate the symptom vs. expected behavior; if the exact error text, logs, or reproduction steps are missing, ask for them before theorizing. Offer 2-4 ranked hypotheses, each with the evidence for it and the quickest check that would confirm or kill it. Fix the root cause, not the symptom — a patch that silences the error without explaining the mechanism is not a fix; say WHY it broke. Propose the minimal change, then state exactly how to verify it worked: a command to run, an input to retry, a log line to watch. If several causes stay plausible, name the next check to run instead of faking certainty.",
    enabled: true,
    surfaces: { chat: true, research: false, julius: true },
  },
  {
    name: "Research rigor",
    folder: "Research",
    description: "Fact-finding: claims, numbers, events, real-world comparisons.",
    content:
      "Cross-check every load-bearing claim against at least two independent sources — independent means different origins, not two articles quoting the same press release. Date-stamp volatile facts (prices, versions, leadership, market data) with when they were true. Keep what sources say separate from your interpretation, and label inference as inference. Attach a confidence level (high / medium / low) to each key conclusion and note what would change it. Prefer primary sources: papers, filings, official docs, direct announcements. When sources conflict, show the conflict and argue for the more credible side — never average disagreement into false consensus. Anything unverifiable is marked 'unverified', not dropped and not asserted.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: true },
  },
  {
    name: "Numbers & estimates",
    folder: "Research",
    description: "Calculations, sizing, forecasts, budgets, back-of-envelope estimates.",
    content:
      "Show the formula and every assumption before the result — a number without its assumptions is noise. Sanity-check the order of magnitude against a known reference and say what you compared it to. Use a compact table when there is more than one scenario or line item. Give ranges instead of false precision ('$40-60K' beats '$52,340' on rough inputs) and name the input the result is most sensitive to. Carry units through the math and double-check conversions — most estimate bugs are unit bugs. When an input is unknown, pick an explicit default, flag it, and show how the result moves if it is off by 2x.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: true },
  },
  {
    name: "Clear writing",
    folder: "Writing",
    description: "Drafting or editing prose: emails, posts, docs, announcements, copy.",
    content:
      "Lead with the main point — the reader must get the message from the first two sentences. Match register to the audience and say which audience you assumed. Cut filler: no throat-clearing openings, no buzzwords, no restating the request. Short sentences, concrete verbs, one idea per paragraph. For the highest-stakes line (subject, headline, call to action) offer one alternative phrasing and note the difference in tone. When editing someone's text, keep their voice — improve clarity without overwriting personality. End with what the reader should do or remember.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: false },
  },
  {
    name: "Decision support",
    folder: "Decisions",
    description: "Choosing between options, planning a move, weighing a trade-off.",
    content:
      "Frame two or three genuinely distinct options — not one real option padded with strawmen. For each: what it costs, what it wins, what must be true for it to work, and its main risk. Then commit to a recommendation for this user's specific context and defend it in one paragraph. Refusing to pick is acceptable only when a named missing fact genuinely flips the answer — then name that fact. List the top risks of the recommended path, each with a mitigation. Prefer reversible moves under high uncertainty, and say when a choice is one-way. Close with the first concrete step, small enough to do today.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: false },
  },
  {
    name: "Explain simply",
    folder: "Writing",
    description: "Explaining a concept or system: 'explain', 'what is', 'how does X work'.",
    content:
      "Start in plain language with one concrete everyday analogy — no jargon in the first paragraph. Then give the precise definition with correct terminology, and honestly note where the analogy breaks down. Follow with one worked example the user could realistically hit. List the two or three mistakes or misconceptions beginners run into first. Scale depth to the question: a curious 'what is X' gets the short version, a practitioner gets the mechanics. End by naming the next concept worth learning and why.",
    enabled: true,
    surfaces: { chat: true, research: false, julius: false },
  },
  {
    name: "Brainstorm",
    folder: "Decisions",
    description: "Generating ideas: names, features, angles, campaigns, approaches.",
    content:
      "Diverge before judging: produce at least 10 ideas spanning genuinely different angles — vary the mechanism, the audience, or the constraint being broken; cosmetic rewordings do not count. No feasibility filtering during generation. Then converge: name the top 3 with one line each on why they win. Include exactly one wildcard — probably wrong, huge if right — and label it as such. Number every idea for easy reference. If the user picks a direction, generate a second wave inside it instead of defending the first batch.",
    enabled: true,
    surfaces: { chat: true, research: false, julius: false },
  },
  {
    name: "Executive brief",
    folder: "Writing",
    description: "Long or strategic questions that deserve a decision-ready answer.",
    content:
      "Structure the answer as an executive brief: start with a 2-3 sentence TL;DR that states the conclusion, then key points as tight bullets (numbers first), then risks or open questions, then a clear recommendation. No filler, no restating the question. If the evidence is thin, say so in the TL;DR instead of hedging everywhere.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: true },
  },
  {
    name: "Cited claims",
    folder: "Research",
    description: "Any answer that states facts, numbers, dates, or news.",
    content:
      "Every factual claim carries its source: link the origin next to the claim, prefer primary sources over aggregators, and date-stamp volatile data (prices, versions, headcounts). Keep facts visually separate from your own interpretation. When no reliable source exists, say \"no reliable source found\" for that claim instead of guessing.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: true },
  },
  {
    name: "Comparison tables",
    folder: "Writing",
    description: "Comparing options, tools, vendors, plans, or approaches.",
    content:
      "Present comparisons as a markdown table: options as columns, criteria as rows, with a final row naming the winner per criterion. After the table, give a one-paragraph pick for the user's specific context and name the single most important trade-off. Never bury a comparison in prose.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: true },
  },
  {
    name: "Action plan",
    folder: "Writing",
    description: "Requests that end in something the user must go do.",
    content:
      "End the answer with a numbered \"Next steps\" list: each step starts with a verb, carries a rough effort estimate (minutes/hours/days), and names what unblocks it if it's blocked. Three to seven steps — fewer, bigger steps beat a long checklist. Flag the one step that should happen today.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: true },
  },
  {
    name: "Russian output",
    folder: "Writing",
    description: "The user prefers answers in Russian.",
    content:
      "Always answer in Russian regardless of the source language. Keep code, commands, API names, and proper nouns in their original form. When quoting a source in another language, translate the quote and keep the original in parentheses only when the nuance matters.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: true },
  },
];

/**
 * High-stakes working protocols, built from the review-contract pattern:
 * severity rubric with a hard floor, nits out of scope, and explicit
 * permission to report nothing when nothing is wrong.
 */
const WORKFLOW_TEMPLATES: SkillTemplate[] = [
  {
    name: "PR review",
    folder: "Engineering",
    description: "Reviewing a pull request, branch, or pasted diff.",
    content:
      "Review only real code. Get the actual diff first — from the connected GitHub integration or pasted into the chat. No diff means no review: ask for it; never review from memory or from the PR title alone. Read the PR's intent (title, description, linked issue) before judging — review what the change is trying to do, not what you would have built instead.\n\nEvery finding must carry an exact location (file and line), a severity, a confidence level, and a concrete fix or question. Severity rubric with a hard floor — Blocker: data loss, security hole, money handled wrong, or a crash on a realistic input, and you must name the input that triggers it. Major: incorrect behavior a user or caller will actually hit. Minor: correctness-adjacent maintainability issue, like a misleading name that will cause a bug or a dead error path.\n\nOut of scope: style, formatting, naming taste, import order — the linter owns those; do not pad the review with them. Do not invent findings: a good PR gets an empty review, and saying 'no issues found' is a valid, complete outcome. Never claim you ran code or tests you did not run.\n\nEnd with a verdict derived only from the findings above — approve / approve with nits / request changes — plus one line on what the change does well. The review is advisory: the human merges.",
    enabled: true,
    surfaces: { chat: true, research: false, julius: true },
  },
  {
    name: "Security review",
    folder: "Engineering",
    description: "Changes touching auth, payments, migrations, public APIs, or user input.",
    content:
      "Open with the blast radius in one sentence: what data and which users this change can reach, and the worst realistic outcome if it is wrong.\n\nCheck the classics against the actual code, not in the abstract: injection (SQL, command, template) wherever input meets an interpreter; authorization on every endpoint and object access — not just authentication, verify the caller owns the resource (IDOR); secrets in code, logs, or client bundles; XSS and CSRF on anything rendering user input or mutating state; unsafe deserialization; risky new dependencies.\n\nEvery finding needs a concrete exploitation scenario with an example input or request — who sends what and what they gain. 'This might be unsafe' without a scenario is not a finding. Rate each one: Critical (exploitable now, real damage), High (exploitable under conditions), Hardening (defense in depth). Name the specific fix next to each.\n\nIf the code is sound, say so and list what you checked — a clean bill with a checklist beats vague reassurance. You advise; humans decide what ships.",
    enabled: true,
    surfaces: { chat: true, research: true, julius: true },
  },
  {
    name: "Test author",
    folder: "Engineering",
    description: "Writing or improving automated tests.",
    content:
      "Test behavior through public interfaces, not implementation details — a clean refactor must not break the suite. Start where the risk lives: edge cases and error paths first (empty, null, boundaries, invalid input, failing dependencies), happy path after. One behavior per test, named so a failure reads as a diagnosis: 'rejects expired token' beats 'test auth 2'. Structure arrange-act-assert with a visible seam between the three. Mock only at system boundaries — network, clock, filesystem, randomness; mocking your own internals welds tests to the implementation. Assert outcomes, not 'method X was called', unless the call itself is the contract. Keep fixtures minimal and local so every test reads standalone. Finish by naming what is still NOT covered — an honest gap list beats an inflated test count.",
    enabled: true,
    surfaces: { chat: true, research: false, julius: true },
  },
  {
    name: "Agent design",
    folder: "Engineering",
    description: "Writing or improving agent profiles, system prompts, or skills.",
    content:
      "Structure every prompt as Goal (one sentence, the outcome), Context (who it serves, what inputs it gets), Output format (the exact structure expected), and Quality bar (what must appear, what is forbidden). Use hard directives — 'must', 'never', 'always'; soft phrasing like 'try to' or 'ideally' reads as optional and gets skipped under pressure. Write short, checkable rules: 'cite a source next to every number' is verifiable, 'be accurate' is not. Give every conditional rule an explicit trigger ('when the user asks for a comparison, use a table') so the agent knows when it applies. Never instruct an agent to do what it has no tool for — that is a capability gap, not a prompt gap: add the tool or cut the rule. Add one input-output example for any non-obvious format. Put the most important rules first and keep the total short — every extra rule dilutes the rest. Before shipping, adversarially reread the prompt: find the two rules most likely to be ignored or misread, and tighten them.",
    enabled: true,
    surfaces: { chat: true, research: false, julius: true },
  },
];

/**
 * GitHub delivery playbooks — pstack-style pipeline discipline: every step
 * ends with evidence, changes ship only as branch → PR (the default branch is
 * write-protected in the GitHub tools), and merging always stays with the
 * human — there is deliberately no merge tool.
 */
const PLAYBOOK_TEMPLATES: SkillTemplate[] = [
  {
    name: "Ship a PR",
    folder: "Playbooks",
    description: "Implementing a fix or feature in a connected GitHub repo, delivered as a pull request.",
    content:
      "Applies when a GitHub connection with write access is live and the task is to change code. Work as a pipeline — every step ends with evidence, and the next step does not start without it.\n1. Understand: read the real code first (get_file_tree, get_contents, search_code). Never patch a file you have not read. Name the root cause or the exact insertion point before writing anything.\n2. Branch: create_branch off the default branch, named fix/<slug> or feat/<slug>. The default branch is write-protected by design — never try to commit to it.\n3. Commit: put_file per file with the COMPLETE new content and a clear message. Keep the diff minimal — no drive-by refactors, no unrelated formatting. Several small PRs beat one big one.\n4. Open the PR: create_pull with an honest description — what changed and why, the root cause, how it was verified, what was NOT verified, known risks. Never inflate confidence.\n5. Verify: watch CI on the branch (list_workflow_runs → list_run_jobs → get_job_logs on failures). Fix and push again until green, or explain exactly why it stays red.\n6. Report: the PR URL plus per-check status. Green CI is evidence, not proof of correctness — merging stays with the human; never merge and never claim merged.\nIf GitHub is not connected or the token lacks write access, say so plainly and deliver the change as a patch in chat instead.",
    enabled: true,
    surfaces: { chat: true, research: false, julius: true },
  },
  {
    name: "Debug CI",
    folder: "Playbooks",
    description: "A GitHub Actions workflow or check is red — find the root cause from real logs.",
    content:
      "Work the evidence chain, never memory: list_workflow_runs (status: failure) → list_run_jobs on the failing run → get_job_logs on the failing job. Quote the exact failing lines — the log is the ground truth, and failures live at the tail.\nClassify before fixing: code bug, broken or flaky test, config or dependency drift, or infra/runner issue. Rank 2-3 hypotheses with the log evidence for each, then kill them against the log — not against intuition.\nUse history: find the last green run and the first red one, then compare_commits between their SHAs — the breaking change usually sits in that window.\nFix the root cause, not the symptom: deleting a failing test, retrying until green, or blindly bumping a timeout is not a fix. Say WHY it broke in one sentence. Ship the fix via the Ship a PR playbook (branch → put_file → create_pull).\nDeclare victory only when a NEW run on the fix branch completes green — name its run_id. If the cause is outside the repo (expired secrets, quota, runner outage), report honestly what code cannot fix and what the human must change.",
    enabled: true,
    surfaces: { chat: true, research: false, julius: true },
  },
  {
    name: "Babysit a PR",
    folder: "Playbooks",
    description: "Checking on a pull request: status, review threads, CI, getting it mergeable.",
    content:
      'Applies to "check on PR X", "is it green", "get it mergeable". Announce the check plan first — mergeability, review threads, CI — then do exactly that.\nState: get_pull for state/draft/branches, get_pull_files for the current diff. CI: list_workflow_runs on the head branch; on failures list_run_jobs → get_job_logs and quote the failing lines.\nReview comments: triage every thread into fix / dismiss / ask — silence is not triage. Fix means a commit on the PR branch (put_file). Dismiss requires a concrete reason posted back with add_issue_comment. Ask when the comment is genuinely ambiguous.\nPush fixes only to the PR\'s head branch. If the scope drifted from the original description, update_pull so the text stays honest.\nReport per item: each CI check ✓/✗/pending with run ids, each review thread resolved or open, mergeable yes/no. Never claim green without a completed run\'s conclusion. Never merge — say plainly that the PR is ready and the merge belongs to the human.',
    enabled: true,
    surfaces: { chat: true, research: false, julius: true },
  },
  {
    name: "Maintain the feature map",
    folder: "Playbooks",
    description:
      "A repo's feature map (user-POV inventory of features, routes, coverage) needs a drift check — compare it against the real code and ship corrections as a PR.",
    content:
      'Applies to "drift-check the feature map", "sync the verification map", or a scheduled map audit. A feature map is a user-POV inventory of an app\'s features stored in its repo (default path: .agents/skills/verification/references/feature-map.md); its header names its ground-truth source files and the commit stamp of the last sync.\n1. Fetch the map with get_contents and read its "Last synced" stamp. No map at the expected path — say so and stop; never audit from memory.\n2. Scope the window: compare_commits from the stamped commit to the default-branch head. No commits touching mapped surfaces and no discrepancies → report "no drift", name the head SHA, and stop. Never open a PR only to move the stamp.\n3. Verify claims against real files: get_contents every ground-truth source the map\'s header names (routes, navigation tabs, test-id registry, e2e scenario catalog, backend route dispatch) and compare. Drift comes in two kinds — claims the code no longer backs, and shipped features the map omits. Hunt both. A scenario listed in the coverage table must still exist in the catalog file.\n4. Drift found → ship the correction via the Ship a PR discipline: branch chore/feature-map-sync, put_file the COMPLETE updated map (corrected facts, "Last synced" stamp set to the audited head commit), create_pull. The PR description lists each drifted item as map-said vs code-says with the file that proves it. Touch only the map — code bugs found on the way are reported, not fixed here. Never merge.\n5. Report: the drift list with evidence, the PR URL — or the honest "no drift (checked <head SHA>)". Coverage gaps stay listed as gaps; closing one requires a real scenario in code, not an edit to the table.',
    enabled: true,
    surfaces: { chat: true, research: false, julius: true },
  },
];

/** Catalog groups for the Skills page: everyday craft vs. strict protocols vs. delivery playbooks. */
export const SKILL_TEMPLATE_GROUPS: SkillTemplateGroup[] = [
  {
    id: "essentials",
    label: "Essentials",
    hint: "Everyday craft — how the agent codes, debugs, researches, estimates, writes, decides, and formats answers.",
    templates: ESSENTIAL_TEMPLATES,
  },
  {
    id: "workflows",
    label: "Workflows",
    hint: "Strict protocols for high-stakes jobs: PR review, security review, test writing, and agent design.",
    templates: WORKFLOW_TEMPLATES,
  },
  {
    id: "playbooks",
    label: "Playbooks",
    hint: "GitHub delivery pipelines: ship changes as PRs, debug CI from real logs, babysit a PR to green, keep the feature map honest — merging stays with the human.",
    templates: PLAYBOOK_TEMPLATES,
  },
];

/** Ready-made skills for the Skills page — one click to adopt, then editable. */
export const SKILL_TEMPLATES: SkillTemplate[] = SKILL_TEMPLATE_GROUPS.flatMap(
  (group) => group.templates,
);

/**
 * Catalog folder per template name — lets pre-folder blobs adopt folders for
 * already-added catalog skills exactly once (only while no folder key exists).
 */
const TEMPLATE_FOLDER_BY_NAME = new Map<string, string>(
  SKILL_TEMPLATES.flatMap((template) =>
    template.folder ? [[template.name, template.folder] as [string, string]] : [],
  ),
);

export function skillFromTemplate(template: SkillTemplate): Skill {
  return {
    ...template,
    surfaces: { ...template.surfaces },
    id: newId(),
    createdAt: Date.now(),
  };
}

/**
 * One-click "Add all": adopts every catalog template not already present (by
 * name), honoring MAX_SKILLS. `skipped` counts templates that did not fit —
 * callers must disclose it, never swallow it.
 */
export function addAllTemplates(
  existing: Skill[],
  templates: SkillTemplate[] = SKILL_TEMPLATES,
): { skills: Skill[]; added: number; skipped: number } {
  const have = new Set(existing.map((skill) => skill.name));
  const missing = templates.filter((template) => !have.has(template.name));
  const room = Math.max(0, MAX_SKILLS - existing.length);
  const adopted = missing.slice(0, room).map(skillFromTemplate);
  return {
    skills: [...adopted, ...existing],
    added: adopted.length,
    skipped: missing.length - adopted.length,
  };
}
