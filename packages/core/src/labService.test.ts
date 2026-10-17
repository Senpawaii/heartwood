import { describe, expect, it } from "vitest";
import { digestOf } from "./fakeLab.js";
import { DigestMismatchError, LabUnavailableError } from "./lab.js";
import { absorbSkill, analyzeSkill, evolveSkill } from "./labService.js";
import { makeTown, payloads, type Town } from "./testing.js";

const rankOf = (t: Town, name: string, digest: string) => {
  const row = t.db
    .prepare("SELECT rank FROM skill_ranks WHERE name = ? AND digest = ?")
    .get(name, digest) as { rank: string } | undefined;
  return row?.rank;
};

describe("Lab service", () => {
  it("absorb pins the soul to the resolved digest and makes that content durable", async () => {
    const t = makeTown();
    const s = t.addSoul("Oak");
    const ref = t.lab.addSkill("tdd", "v1");
    const pin = await absorbSkill(t, { soulId: s, name: "tdd" });
    expect(pin).toEqual({ name: "tdd", digest: ref.digest });
    expect(t.lab.pinned.has(ref.digest)).toBe(true);
    t.lab.addSkill("tdd", "v2"); // the catalog moves on; the soul stays pinned
    const row = t.db.prepare("SELECT digest FROM soul_skills WHERE soul_id = ?").get(s) as {
      digest: string;
    };
    expect(row.digest).toBe(ref.digest);
    await expect(absorbSkill(t, { soulId: s, name: "missing" })).rejects.toThrow(/not found/);
  });

  it("refuses to load content that no longer matches its digest", async () => {
    const t = makeTown();
    const ref = t.lab.addSkill("tdd", "v1");
    t.lab.corrupt(ref, "tampered");
    await expect(t.lab.load(ref)).rejects.toBeInstanceOf(DigestMismatchError);
  });

  describe("analyze", () => {
    it("records the measurement and derives the rank from Heartwood-owned thresholds", async () => {
      const t = makeTown();
      const ref = t.lab.addSkill("tdd", "v1");
      t.lab.setScore(ref, 0.8);
      const a = await analyzeSkill(t, ref);
      expect(a.rank).toBe("unique");
      expect(rankOf(t, "tdd", ref.digest)).toBe("unique");
      expect(payloads(t.log, "skill.analyzed")[0]).toMatchObject({
        score: 0.8,
        trials: 10,
        errors: 0,
        conclusive: true,
      });
      expect(payloads(t.log, "skill.ranked")[0]).toMatchObject({
        rank: "unique",
        thresholdsVersion: t.rules.thresholdsVersion,
      });
    });

    it("an inconclusive benchmark is recorded but never changes the rank", async () => {
      const t = makeTown();
      const ref = t.lab.addSkill("tdd", "v1");
      t.lab.setScore(ref, 0.9);
      await analyzeSkill(t, ref);
      expect(rankOf(t, "tdd", ref.digest)).toBe("ultimate");

      t.lab.setResult(ref, { trials: 10, passes: 0, errors: 8, baselineRate: 0 }); // 2 countable trials, mostly infra errors
      const again = await analyzeSkill(t, ref);
      expect(again.rank).toBeUndefined();
      expect(payloads(t.log, "skill.analyzed").at(-1)).toMatchObject({
        conclusive: false,
        errors: 8,
      });
      expect(payloads(t.log, "skill.ranked")).toHaveLength(1);
      expect(rankOf(t, "tdd", ref.digest)).toBe("ultimate"); // not demoted by a run that measured nothing
    });
  });

  describe("evolve", () => {
    const setup = () => {
      const t = makeTown();
      const v1 = t.lab.addSkill("tdd", "v1");
      t.lab.setScore(v1, 0.4);
      let n = 0;
      t.lab.rewriter = () => ({ body: `v${++n + 1}`, changelog: "tweak" });
      // the candidate's digest is unknown until proposed, so script it from the content the rewriter will produce
      return {
        t,
        v1,
        candidate: (version: number) => ({ name: "tdd", digest: digestOf(`v${version}`) }),
      };
    };

    it("promotes a version that clears the gate and beats the old one, then ranks it from the same run", async () => {
      const { t, v1, candidate } = setup();
      t.lab.setScore(candidate(2), 0.9);
      const win = await evolveSkill(t, v1);
      expect(win.promoted).toBe(true);
      expect(t.lab.promotions).toEqual([{ candidate: win.candidate, replaces: v1 }]);
      expect(payloads(t.log, "skill.evolve_promoted")).toHaveLength(1);
      expect(rankOf(t, "tdd", win.candidate.digest)).toBe("ultimate");
    });

    it("rejects a worse version and does not promote it", async () => {
      const { t, v1, candidate } = setup();
      t.lab.setScore(candidate(2), 0.1);
      const lose = await evolveSkill(t, v1);
      expect(lose.promoted).toBe(false);
      expect(t.lab.promotions).toEqual([]);
      expect(payloads(t.log, "skill.evolve_rejected")[0]?.reason).toMatch(/verdict worse/);
    });

    it("an apparent win on too little evidence is rejected, with the reason", async () => {
      const { t, v1, candidate } = setup();
      t.lab.setResult(candidate(2), { trials: 6, passes: 6, errors: 0, baselineRate: 0 }); // 100% vs 40%, but only 6 trials
      const out = await evolveSkill(t, v1);
      expect(out.promoted).toBe(false);
      expect(t.lab.promotions).toEqual([]);
      expect(payloads(t.log, "skill.evolve_rejected")[0]?.reason).toMatch(
        /not significant.*at least 10 countable trials/,
      );
    });

    it("a win that is real but smaller than the tolerance is not promoted", async () => {
      const { t, v1, candidate } = setup();
      t.lab.setScore(candidate(2), 0.5); // +0.1 over 0.4, tolerance is 0.15
      expect((await evolveSkill(t, v1)).promoted).toBe(false);
    });

    it("surfaces an explicit error when the Lab cannot propose versions, and proposes nothing", async () => {
      const t = makeTown();
      const v1 = t.lab.addSkill("tdd", "v1");
      await expect(evolveSkill(t, v1)).rejects.toBeInstanceOf(LabUnavailableError);
      expect(t.log.read({ types: ["skill.evolve_proposed"] })).toEqual([]);
    });
  });
});
