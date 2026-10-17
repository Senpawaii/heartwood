import { describe, expect, it } from "vitest";
import type { Evidence } from "./lab.js";
import {
  defaultRules,
  deriveSkillRank,
  emptyProficiency,
  levelForXp,
  nextProficiency,
  type Rules,
  rankForLevel,
} from "./rules.js";

describe("rules", () => {
  it("maps XP to level at the threshold boundaries", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(19)).toBe(1);
    expect(levelForXp(20)).toBe(2);
    expect(levelForXp(1_000_000)).toBe(defaultRules.xpThresholds.length + 1);
  });

  it("derives rank from level", () => {
    expect(rankForLevel(1)).toBe("apprentice");
    expect(rankForLevel(3)).toBe("journeyman");
    expect(rankForLevel(7)).toBe("executive");
  });

  describe("deriveSkillRank", () => {
    const ev = (o: Partial<Evidence> & { passes: number; trials: number }): Evidence => ({
      skill: { name: "tdd", digest: "sha256:a" },
      suiteDigest: "s",
      agent: { id: "fake" },
      ranAt: "2026-10-17T00:00:00.000Z",
      resultRef: "r1",
      errors: 0,
      passRate: o.passes / o.trials,
      ...o,
    });
    const lift = (delta: number) => ({ delta, skillTrials: 10, baselineTrials: 10 });

    it("ranks by pass rate over countable trials and by lift over no skill", () => {
      expect(deriveSkillRank(ev({ passes: 2, trials: 10, vsBaseline: lift(0.1) }))).toBe("common");
      expect(deriveSkillRank(ev({ passes: 5, trials: 10 }))).toBe("extra");
      expect(deriveSkillRank(ev({ passes: 8, trials: 10, vsBaseline: lift(0.5) }))).toBe("unique");
      expect(deriveSkillRank(ev({ passes: 10, trials: 10, vsBaseline: lift(0.4) }))).toBe(
        "ultimate",
      );
    });

    it("a tier that needs lift cannot be reached without a baseline, or when the skill barely helps", () => {
      expect(deriveSkillRank(ev({ passes: 9, trials: 10 }))).toBe("extra"); // no baseline arm
      expect(deriveSkillRank(ev({ passes: 9, trials: 10, vsBaseline: lift(0.05) }))).toBe("extra"); // the agent passes anyway
      expect(deriveSkillRank(ev({ passes: 9, trials: 10, vsBaseline: lift(0.15) }))).toBe("unique");
    });

    it("infra errors are excluded from the denominator, not counted as failures", () => {
      // 7 of 8 countable passes = 0.875; counted against all 10 trials it would only be 0.7
      expect(deriveSkillRank(ev({ passes: 7, trials: 10, errors: 2, vsBaseline: lift(0.5) }))).toBe(
        "unique",
      );
    });

    it("is inconclusive, not low, when the sample is too small or too error-ridden", () => {
      expect(deriveSkillRank(ev({ passes: 0, trials: 3 }))).toBeUndefined();
      expect(deriveSkillRank(ev({ passes: 4, trials: 10, errors: 6 }))).toBeUndefined(); // 4 countable
      expect(deriveSkillRank(ev({ passes: 5, trials: 10, errors: 4 }))).toBeUndefined(); // 40% errors > 30%
      expect(deriveSkillRank(ev({ passes: 0, trials: 0 }))).toBeUndefined();
    });

    it("honours configured thresholds", () => {
      const strict: Rules = {
        ...defaultRules,
        skillRank: {
          ...defaultRules.skillRank,
          minTrials: 20,
          unique: { minPassRate: 0.95, minLift: 0 },
          ultimate: { minPassRate: 0.99, minLift: 0 },
        },
      };
      expect(
        deriveSkillRank(ev({ passes: 9, trials: 10, vsBaseline: lift(0.9) }), strict),
      ).toBeUndefined();
      expect(deriveSkillRank(ev({ passes: 19, trials: 20, vsBaseline: lift(0.9) }), strict)).toBe(
        "unique",
      );
    });
  });

  it("a single success is not mastery; unknown outcomes add uses but no evidence", () => {
    let p = nextProficiency(emptyProficiency, "succeeded");
    expect(p.score).toBeLessThan(0.3);
    for (let i = 0; i < 20; i++) p = nextProficiency(p, "succeeded");
    expect(p.score).toBeGreaterThan(0.85);
    const u = nextProficiency(p, "unknown");
    expect(u.uses).toBe(p.uses + 1);
    expect(u.score).toBe(p.score);
    expect(nextProficiency(p, "failed").score).toBeLessThan(p.score);
  });
});
