import {
  allowedLifeOps,
  applyLifeOps,
  buildPersonalContext,
  emptyLife,
  normalizeLife,
  type LifeOp,
} from "@/lib/life";

const memorySave: LifeOp = { op: "memory.save", text: "Loves tea", category: "prefs" };
const memoryDelete: LifeOp = { op: "memory.delete", match: "tea" };
const trackerLog: LifeOp = { op: "tracker.log", tracker: "Water", value: 2, unit: "glass", note: "", at: null };

describe("memory toggle", () => {
  it("defaults to enabled for new and legacy stored hubs", () => {
    expect(emptyLife().memoryEnabled).toBe(true);
    const legacy = normalizeLife({ memories: [], trackers: [], entries: [], tasks: [], shareWithAgent: true });
    expect(legacy.memoryEnabled).toBe(true);
  });

  it("keeps a stored off state across reloads", () => {
    expect(normalizeLife({ memoryEnabled: false }).memoryEnabled).toBe(false);
  });

  it("saves memories while on", () => {
    const next = applyLifeOps(emptyLife(), [memorySave]);
    expect(next.memories).toHaveLength(1);
    expect(next.memories[0].text).toBe("Loves tea");
  });

  it("drops memory writes while off but still applies tracker ops", () => {
    const life = { ...emptyLife(), memoryEnabled: false };
    const next = applyLifeOps(life, [memorySave, trackerLog]);
    expect(next.memories).toHaveLength(0);
    expect(next.entries).toHaveLength(1);
  });

  it("ignores memory.delete while off so saved facts survive", () => {
    const on = applyLifeOps(emptyLife(), [memorySave]);
    const off = { ...on, memoryEnabled: false };
    const next = applyLifeOps(off, [memoryDelete]);
    expect(next.memories).toHaveLength(1);
  });

  it("allowedLifeOps strips memory ops only while off", () => {
    expect(allowedLifeOps(emptyLife(), [memorySave, memoryDelete, trackerLog])).toHaveLength(3);
    const off = { ...emptyLife(), memoryEnabled: false };
    expect(allowedLifeOps(off, [memorySave, memoryDelete, trackerLog])).toEqual([trackerLog]);
  });

  it("hides saved facts and forbids memory ops in the agent context while off", () => {
    const on = applyLifeOps(emptyLife(), [memorySave]);
    const onContext = buildPersonalContext(on);
    expect(onContext).toContain("Loves tea");
    expect(onContext).toContain("AUTO-MEMORY");
    expect(onContext).toContain('{"op":"memory.save"');

    const offContext = buildPersonalContext({ ...on, memoryEnabled: false });
    expect(offContext).not.toContain("Loves tea");
    expect(offContext).not.toContain("AUTO-MEMORY");
    // The op example must no longer teach memory writes; the rule text still
    // names them to forbid them explicitly.
    expect(offContext).not.toContain('{"op":"memory.save"');
    expect(offContext).toContain("MEMORY IS OFF");
    expect(offContext).toContain("never emit memory.save");
  });

  it("keeps trackers and tasks in the context while memory is off", () => {
    const life = applyLifeOps({ ...emptyLife(), memoryEnabled: false }, [
      trackerLog,
      { op: "task.add", text: "Call the bank", due: null },
    ]);
    const context = buildPersonalContext(life);
    expect(context).toContain("Water");
    expect(context).toContain("Call the bank");
  });
});
