// The cloud-automation scheduler ships to the ChatStore shard. Its core
// contract is the documented invariant `automationDue(auto, base, t) ⟺
// nextDueAt(auto, base) <= t` — the fire check and the alarm arming must
// agree, or automations either double-run or sleep forever. Pinned here
// across cadences, timezones, and clock edges, together with the
// profile-blob coercion and the webhook prompt context.
import { describe, expect, it } from "vitest";

import {
  automationDue,
  cloudSkillsBlock,
  nextDueAt,
  storedAutomation,
  withHookContext,
  type StoredAutomation,
} from "../../../functions/automation-schedule";

function auto(overrides: Partial<StoredAutomation>): StoredAutomation {
  return {
    id: "a1",
    name: "Automation",
    prompt: "do the thing",
    cadence: "daily",
    intervalMinutes: 60,
    time: "09:00",
    weekday: 1,
    agentId: null,
    mcpServerIds: null,
    skillIds: null,
    webhookToken: null,
    enabled: true,
    runOn: "server",
    tzOffsetMinutes: 0,
    conversationId: "c1",
    lastRunAt: 0,
    createdAt: 0,
    ...overrides,
  };
}

describe("automationDue ⟺ nextDueAt invariant (functions/automation-schedule)", () => {
  const bases = [
    Date.UTC(2026, 0, 15, 12, 34, 56),
    Date.UTC(2026, 7, 29, 0, 0, 1),
    Date.UTC(2025, 11, 31, 23, 59, 59),
  ];

  function checkInvariant(item: StoredAutomation, base: number): void {
    const due = nextDueAt(item, base);
    const label = `${item.cadence} ${item.time} tz=${item.tzOffsetMinutes} wd=${item.weekday} base=${base}`;
    expect(due, label).toBeGreaterThan(base);
    expect(automationDue(item, base, due), `${label} → due at nextDueAt`).toBe(true);
    expect(automationDue(item, base, due - 1), `${label} → not due 1ms earlier`).toBe(false);
  }

  it("holds for interval cadences", () => {
    for (const minutes of [5, 60, 1440]) {
      for (const base of bases) {
        checkInvariant(auto({ cadence: "interval", intervalMinutes: minutes }), base);
      }
    }
  });

  it("holds for daily cadences across timezones and times", () => {
    for (const tz of [-840, -300, 0, 180, 840]) {
      for (const time of ["00:00", "09:00", "23:30"]) {
        for (const base of bases) {
          checkInvariant(auto({ cadence: "daily", time, tzOffsetMinutes: tz }), base);
        }
      }
    }
  });

  it("holds for weekly cadences across all weekdays", () => {
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      for (const tz of [-300, 0, 180]) {
        for (const base of bases) {
          checkInvariant(auto({ cadence: "weekly", weekday, tzOffsetMinutes: tz }), base);
        }
      }
    }
  });

  it("weekly due dates land on the configured weekday in the user's wall clock", () => {
    const tz = -180; // UTC+3
    const base = Date.UTC(2026, 0, 15, 12, 0, 0);
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const due = nextDueAt(auto({ cadence: "weekly", weekday, tzOffsetMinutes: tz }), base);
      expect(new Date(due - tz * 60_000).getUTCDay()).toBe(weekday);
    }
  });
});

describe("storedAutomation coercion", () => {
  it("rejects entries without a usable id", () => {
    expect(storedAutomation(null)).toBeNull();
    expect(storedAutomation("x")).toBeNull();
    expect(storedAutomation({ id: "" })).toBeNull();
    expect(storedAutomation({ id: 7 })).toBeNull();
  });

  it("clamps and defaults every scheduler field", () => {
    const parsed = storedAutomation({
      id: "a1",
      cadence: "hourly",
      intervalMinutes: 1,
      time: "9am",
      weekday: 12,
      tzOffsetMinutes: -100_000,
      webhookToken: "not-a-token",
      enabled: undefined,
    });
    expect(parsed).toMatchObject({
      id: "a1",
      name: "Automation",
      cadence: "daily",
      intervalMinutes: 5,
      time: "09:00",
      weekday: 6,
      tzOffsetMinutes: -840,
      webhookToken: null,
      enabled: true,
    });
  });

  it("keeps format-valid times as-is — out-of-range digits clamp later, at parse time", () => {
    expect(storedAutomation({ id: "a1", time: "25:99" })?.time).toBe("25:99");
    const due = nextDueAt(auto({ cadence: "daily", time: "25:99", tzOffsetMinutes: 0 }), Date.UTC(2026, 0, 15));
    const wall = new Date(due);
    expect(wall.getUTCHours()).toBe(23);
    expect(wall.getUTCMinutes()).toBe(59);
  });

  it("keeps a valid webhook token and explicit disable", () => {
    const token = `wh_${"a".repeat(24)}`;
    const parsed = storedAutomation({ id: "a1", webhookToken: token, enabled: false });
    expect(parsed?.webhookToken).toBe(token);
    expect(parsed?.enabled).toBe(false);
  });
});

describe("withHookContext", () => {
  it("fences each delivery and reports the burst size", () => {
    const prompt = "watch the repo";
    const out = withHookContext(prompt, {
      entries: [
        { at: 0, payload: '{"a":1}', contentType: "application/json", event: "push", delivery: "d-1" },
        { at: 1, payload: "   ", contentType: "", event: "", delivery: "" },
      ],
      dropped: 0,
    });
    expect(out.startsWith(`${prompt}\n\n---`)).toBe(true);
    expect(out).toContain("fired by 2 incoming webhook deliveries");
    expect(out).toContain('````\n{"a":1}\n````');
    expect(out).toContain("(empty body)");
    expect(out).toContain("event: push");
    expect(out).not.toContain("older deliveries in this burst were dropped");
  });

  it("mentions dropped deliveries when the burst overflowed", () => {
    const out = withHookContext("p", {
      entries: [{ at: 0, payload: "x", contentType: "", event: "", delivery: "" }],
      dropped: 3,
    });
    expect(out).toContain("(3 older deliveries in this burst were dropped");
  });
});

describe("cloudSkillsBlock", () => {
  const skill = (id: string, extra?: Record<string, unknown>) => ({
    id,
    name: `Skill ${id}`,
    description: "",
    content: `content of ${id}`,
    enabled: true,
    ...extra,
  });

  it("keeps enabled chat-surface skills and skips the rest", () => {
    const block = cloudSkillsBlock(
      [
        skill("keep"),
        skill("disabled", { enabled: false }),
        skill("nochat", { surfaces: { chat: false } }),
        skill("empty", { content: "  " }),
        "junk",
      ],
      undefined,
      null,
    );
    expect(block).toContain("### Skill: Skill keep");
    expect(block).not.toContain("disabled");
    expect(block).not.toContain("nochat");
    expect(block).toContain("SKILLS — reusable instruction packs");
    // Mirrors the browser header: skills shape HOW the run works and are
    // never the task itself.
    expect(block).toContain("never the task itself");
  });

  it("applies both the agent's and the automation's allow-lists", () => {
    const skills = [skill("a"), skill("b"), skill("c")];
    const agent = { skillIds: ["a", "b"] };
    expect(cloudSkillsBlock(skills, agent, null)).toContain("Skill a");
    expect(cloudSkillsBlock(skills, agent, null)).not.toContain("Skill c");
    const both = cloudSkillsBlock(skills, agent, ["b"]);
    expect(both).toContain("Skill b");
    expect(both).not.toContain("Skill a");
    // Empty automation allow-list means "no skills", not "all skills".
    expect(cloudSkillsBlock(skills, agent, [])).toBe("");
  });

  it("returns an empty string when nothing qualifies", () => {
    expect(cloudSkillsBlock(undefined, undefined, null)).toBe("");
    expect(cloudSkillsBlock([], undefined, null)).toBe("");
  });
});
