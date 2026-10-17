import { describe, expect, it } from "vitest";
import { settleDispatch } from "./dispatch.js";
import { absorbSkill } from "./labService.js";
import {
  getDispatch,
  getSoul,
  proficiencySeries,
  skillUsageForSoul,
  townSkillUsage,
} from "./queries.js";
import { brief, makeTown } from "./testing.js";

function remember(
  t: ReturnType<typeof makeTown>,
  soulId: string | null,
  text: string,
  layer: "episodic" | "town" = "episodic",
) {
  t.log.append([
    {
      type: layer === "town" ? "memory.shared_promoted" : "memory.episodic_written",
      payload: {
        ...(layer === "town" ? { fromMemoryId: "x" } : {}),
        memory: {
          memoryId: `m_${text.slice(0, 8)}_${Math.random()}`,
          layer,
          ownerSoulId: soulId,
          text,
          tags: [],
          provenance: { author: "daemon", source: "test" },
        },
      } as never,
      actor: { kind: "daemon" },
    },
  ]);
}

describe("createDispatch", () => {
  it("injects persona, top-k relevant memories (own + town only) and absorbed skills", async () => {
    const t = makeTown();
    const oak = t.addSoul("Oak");
    const elm = t.addSoul("Elm");
    remember(t, oak, "The parser chokes on unicode escapes");
    remember(t, oak, "Lunch was good today");
    remember(t, elm, "parser secret of another agent");
    remember(t, null, "parser style guide: prefer small functions", "town");
    t.lab.addSkill("tdd", "Write the test first.");
    await absorbSkill(t, { soulId: oak, name: "tdd" });
    const { warbandId } = t.formWarband(oak);

    const d = await t.dispatch(warbandId, oak, "w1");

    expect(d.spec).toContain("Oak is careful.");
    expect(d.spec).toContain("unicode escapes");
    expect(d.spec).toContain("small functions");
    expect(d.spec).not.toContain("Lunch");
    expect(d.spec).not.toContain("another agent");
    expect(d.spec).toContain("Write the test first.");
    for (const section of ["# Target", "# Change", "# Constraints", "# Ownership", "# Acceptance"])
      expect(d.spec).toContain(section);
    expect(t.log.read({ types: ["memory.injected"] })[0]?.payload).toMatchObject({
      dispatchId: d.dispatchId,
    });
    expect(getDispatch(t.db, d.dispatchId)?.skills).toEqual(d.skills);
  });

  it("respects k", async () => {
    const t = makeTown();
    const oak = t.addSoul("Oak");
    for (let i = 0; i < 4; i++) remember(t, oak, `parser lesson number ${i}`);
    const { warbandId } = t.formWarband(oak);
    const d = await t.dispatch(warbandId, oak, "w1", brief("parser"));
    expect(d.memoryIds.length).toBe(4);
    const { createDispatch } = await import("./dispatch.js");
    const small = await createDispatch(t, { warbandId, soulId: oak, brief: brief("parser"), k: 2 });
    expect(small.memoryIds).toHaveLength(2);
  });
});

describe("settleDispatch", () => {
  it("records usage (injected evidence), episodic memory and XP exactly once", async () => {
    const t = makeTown();
    const oak = t.addSoul("Oak");
    t.lab.addSkill("tdd", "Write the test first.");
    await absorbSkill(t, { soulId: oak, name: "tdd" });
    const { warbandId } = t.formWarband(oak);
    const d = await t.dispatch(warbandId, oak, "w1");

    expect(
      settleDispatch(t.ctx, {
        dispatchId: d.dispatchId,
        outcome: "succeeded",
        summary: "fixed it",
      }),
    ).toBe(true);
    expect(settleDispatch(t.ctx, { dispatchId: d.dispatchId, outcome: "failed" })).toBe(false);

    expect(getSoul(t.db, oak, t.rules)?.xp).toBe(t.rules.xp.taskSuccess);
    expect(skillUsageForSoul(t.db, oak)).toEqual([
      {
        skill: "tdd",
        uses: 1,
        succeeded: 1,
        failed: 0,
        unknown: 0,
        successRate: 1,
        injectedOnly: 1,
      },
    ]);
    const episodic = t.db
      .prepare("SELECT text FROM memories WHERE layer = 'episodic' AND owner_soul_id = ?")
      .all(oak) as { text: string }[];
    expect(episodic).toHaveLength(1);
    expect(episodic[0]?.text).toContain("fixed it");
    expect(t.log.read({ types: ["dispatch.settled"] })).toHaveLength(1);
  });

  it("abandoned dispatches record unknown usage and grant no XP", async () => {
    const t = makeTown();
    const oak = t.addSoul("Oak");
    t.lab.addSkill("tdd", "x");
    await absorbSkill(t, { soulId: oak, name: "tdd" });
    const { warbandId } = t.formWarband(oak);
    const d = await t.dispatch(warbandId, oak, "w1");
    settleDispatch(t.ctx, { dispatchId: d.dispatchId, outcome: "abandoned" });
    expect(getSoul(t.db, oak, t.rules)?.xp).toBe(0);
    expect(skillUsageForSoul(t.db, oak)[0]).toMatchObject({ unknown: 1, successRate: null });
  });

  it("pays the foreman a separate capped bonus for member successes, never for its own work", async () => {
    const t = makeTown({
      ...(await import("./rules.js")).defaultRules,
      xp: { taskSuccess: 10, taskFailure: 2, foremanPerSuccess: 4, foremanCapPerWarband: 10 },
    });
    const boss = t.addSoul("Boss");
    const w = t.addSoul("Worker");
    const { warbandId } = t.formWarband(boss, [w]);

    const own = await t.dispatch(warbandId, boss, "w0");
    settleDispatch(t.ctx, { dispatchId: own.dispatchId, outcome: "succeeded" });
    expect(getSoul(t.db, boss, t.rules)?.xp).toBe(10); // task XP only, no bonus

    for (let i = 1; i <= 4; i++) {
      const d = await t.dispatch(warbandId, w, `w${i}`);
      settleDispatch(t.ctx, { dispatchId: d.dispatchId, outcome: "succeeded" });
    }
    // bonuses 4 + 4 + 2 (capped at 10) + 0
    expect(getSoul(t.db, boss, t.rules)?.xp).toBe(10 + 10);
    const bonus = t.db
      .prepare(
        "SELECT SUM(amount) AS s FROM xp_ledger WHERE soul_id = ? AND reason = 'foreman_bonus'",
      )
      .get(boss) as { s: number };
    expect(bonus.s).toBe(10);
    expect(getSoul(t.db, w, t.rules)?.xp).toBe(40);
  });

  it("tracks per-agent proficiency over time and town-wide usage with success rate", async () => {
    const t = makeTown();
    const oak = t.addSoul("Oak");
    const elm = t.addSoul("Elm");
    t.lab.addSkill("tdd", "x");
    await absorbSkill(t, { soulId: oak, name: "tdd" });
    await absorbSkill(t, { soulId: elm, name: "tdd" });
    const { warbandId } = t.formWarband(oak, [elm]);
    const outcomes: [string, "succeeded" | "failed"][] = [
      [oak, "succeeded"],
      [oak, "succeeded"],
      [oak, "failed"],
      [elm, "failed"],
    ];
    let i = 0;
    for (const [soul, outcome] of outcomes) {
      const d = await t.dispatch(warbandId, soul, `w${i++}`);
      settleDispatch(t.ctx, { dispatchId: d.dispatchId, outcome });
    }
    const series = proficiencySeries(t.db, oak, "tdd");
    expect(series.map((p) => p.uses)).toEqual([1, 2, 3]);
    expect(series[2]?.score).toBeLessThan(series[1]?.score ?? 0);
    expect(townSkillUsage(t.db)).toEqual([
      {
        skill: "tdd",
        uses: 4,
        succeeded: 2,
        failed: 2,
        unknown: 0,
        successRate: 0.5,
        injectedOnly: 4,
      },
    ]);
  });
});
