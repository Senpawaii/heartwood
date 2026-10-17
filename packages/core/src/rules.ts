import type { Rank, SkillRank, Species } from "@heartwood/protocol";

/** Cumulative XP needed to reach level n+1 is `xpThresholds[n-1]`; level 1 starts at 0 XP. */
export interface Rules {
  xpThresholds: number[];
  /** Minimum level for each rank. */
  rankMinLevel: { journeyman: number; executive: number };
  /** Score (0..1) minimum for each skill rank. */
  skillRankMinScore: { extra: number; unique: number; ultimate: number };
  thresholdsVersion: string;
  xp: {
    taskSuccess: number;
    taskFailure: number;
    foremanPerSuccess: number;
    foremanCapPerWarband: number;
  };
  proficiency: { alpha: number; confidenceK: number };
  /** Species evolution: minimum level and the form each species evolves into. */
  evolution: { minLevel: number; forms: Record<Species, string> };
}

export const defaultRules: Rules = {
  xpThresholds: [20, 50, 100, 180, 300, 480, 720, 1050, 1500],
  rankMinLevel: { journeyman: 3, executive: 7 },
  skillRankMinScore: { extra: 0.5, unique: 0.75, ultimate: 0.9 },
  thresholdsVersion: "default-1",
  xp: { taskSuccess: 10, taskFailure: 2, foremanPerSuccess: 1, foremanCapPerWarband: 10 },
  proficiency: { alpha: 0.3, confidenceK: 3 },
  evolution: { minLevel: 5, forms: { dwarf: "deepsmith", elf: "lorewright", dryad: "greenseer" } },
};

export function levelForXp(xp: number, rules: Rules = defaultRules): number {
  let level = 1;
  for (const t of rules.xpThresholds) {
    if (xp >= t) level++;
    else break;
  }
  return level;
}

/** Rank is derived from level; it is never stored. */
export function rankForLevel(level: number, rules: Rules = defaultRules): Rank {
  if (level >= rules.rankMinLevel.executive) return "executive";
  if (level >= rules.rankMinLevel.journeyman) return "journeyman";
  return "apprentice";
}

/** Skill rank from a benchmark score. Heartwood owns thresholds; the Lab only returns facts. */
export function skillRankForScore(score: number, rules: Rules = defaultRules): SkillRank {
  const t = rules.skillRankMinScore;
  if (score >= t.ultimate) return "ultimate";
  if (score >= t.unique) return "unique";
  if (score >= t.extra) return "extra";
  return "common";
}

export interface ProficiencyState {
  ewma: number;
  /** uses with a known outcome */
  known: number;
  uses: number;
  successes: number;
  score: number;
}

export const emptyProficiency: ProficiencyState = {
  ewma: 0,
  known: 0,
  uses: 0,
  successes: 0,
  score: 0,
};

/**
 * Exponentially weighted success rate, shrunk toward 0 by a confidence term n/(n+k) so that a
 * single success does not read as mastery. `unknown` outcomes count as a use but not as evidence.
 */
export function nextProficiency(
  prev: ProficiencyState,
  outcome: "succeeded" | "failed" | "unknown",
  rules: Rules = defaultRules,
): ProficiencyState {
  const uses = prev.uses + 1;
  if (outcome === "unknown") return { ...prev, uses };
  const x = outcome === "succeeded" ? 1 : 0;
  const ewma = prev.known === 0 ? x : prev.ewma + rules.proficiency.alpha * (x - prev.ewma);
  const known = prev.known + 1;
  const score = ewma * (known / (known + rules.proficiency.confidenceK));
  return { ewma, known, uses, successes: prev.successes + x, score };
}
