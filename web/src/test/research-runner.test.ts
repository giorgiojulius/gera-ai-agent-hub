// Server-side deep research guards, driven from the web tests exactly like
// the other worker modules. Two honesty contracts pinned here:
// 1. An empty research question is refused BEFORE any network call — the old
//    behavior searched garbage and wrote a "report" about the skill packs,
//    the only content left in context ("research researches my skills").
// 2. Workspace context (profile + skills + knowledge) rides under a frame
//    that says it is guidance for HOW to work, never WHAT to research — the
//    old "User instructions (always follow these)" label caused the same
//    skills-as-subject failure on thin questions.
import { afterEach, describe, expect, it, vi } from "vitest";

import { runServerDeepResearch, synthesisSystem } from "../../../functions/research-runner";
import type { ResearchState } from "../../../functions/run-protocol";

describe("runServerDeepResearch empty-question guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a blank prompt honestly without a single network call", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not be touched");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const updates: ResearchState[] = [];
    await expect(
      runServerDeepResearch({
        authKey: "key",
        prompt: "   ",
        history: [],
        modelId: "test/model",
        onUpdate: (research) => updates.push(research),
        onText: () => {},
      }),
    ).rejects.toThrow(/needs a question/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The panel settles honestly: the final emitted state is an error, not a
    // forever-running spinner.
    expect(updates[updates.length - 1]?.status).toBe("error");
  });
});

describe("synthesisSystem", () => {
  it("returns the base prompt untouched when there is no workspace guidance", () => {
    expect(synthesisSystem("BASE")).toBe("BASE");
    expect(synthesisSystem("BASE", "   ")).toBe("BASE");
  });

  it("frames guidance as how-to-work context, never the research subject", () => {
    const system = synthesisSystem("BASE", "SKILLS — packs\nAlways answer in Russian.");
    expect(system).toContain("BASE");
    expect(system).toContain("Always answer in Russian.");
    expect(system).toContain("NOT the research subject");
    expect(system).toContain("the question wins");
    expect(system).not.toContain("User instructions (always follow these)");
  });
});
