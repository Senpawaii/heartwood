import { describe, expect, it } from "vitest";
import {
  defaultRules,
  emptyProficiency,
  levelForXp,
  nextProficiency,
  rankForLevel,
  skillRankForScore,
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

  it("derives skill rank from score with configurable thresholds", () => {
    expect(skillRankForScore(0.2)).toBe("common");
    expect(skillRankForScore(0.5)).toBe("extra");
    expect(skillRankForScore(0.9)).toBe("ultimate");
    const strict = {
      ...defaultRules,
      skillRankMinScore: { extra: 0.6, unique: 0.8, ultimate: 0.99 },
    };
    expect(skillRankForScore(0.9, strict)).toBe("unique");
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
