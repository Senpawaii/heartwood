import type { Rank, SkillRank, Species } from "@heartwood/protocol";
import type { Evidence, PromotionGate } from "./lab.js";

export interface SkillRankTier {
  /** Pass rate over countable trials (infra errors excluded). */
  minPassRate: number;
  /** Pass-rate lift over no skill. 0 means no baseline is required. */
  minLift: number;
}

/** Cumulative XP needed to reach level n+1 is `xpThresholds[n-1]`; level 1 starts at 0 XP. */
export interface Rules {
  xpThresholds: number[];
  /** Minimum level for each rank. */
  rankMinLevel: { journeyman: number; executive: number };
  thresholdsVersion: string;
  xp: {
    taskSuccess: number;
    taskFailure: number;
    foremanPerSuccess: number;
    foremanCapPerWarband: number;
  };
  proficiency: { alpha: number; confidenceK: number };
  /** Skill rank thresholds (see `deriveSkillRank`); changing them bumps `thresholdsVersion`. */
  skillRank: {
    /** Fewer countable trials than this is inconclusive. */
    minTrials: number;
    /** More infra errors than this share of trials is inconclusive. */
    maxErrorRate: number;
    extra: SkillRankTier;
    unique: SkillRankTier;
    ultimate: SkillRankTier;
  };
  /** A new skill version is promoted only on a comparison that clears this gate and says "better". */
  promotion: PromotionGate;
  /** Species evolution: minimum level and the form each species evolves into. */
  evolution: { minLevel: number; forms: Record<Species, string> };
}

export const defaultRules: Rules = {
  xpThresholds: [20, 50, 100, 180, 300, 480, 720, 1050, 1500],
  rankMinLevel: { journeyman: 3, executive: 7 },
  skillRank: {
    minTrials: 5,
    maxErrorRate: 0.3,
    extra: { minPassRate: 0.5, minLift: 0 },
    unique: { minPassRate: 0.75, minLift: 0.1 },
    ultimate: { minPassRate: 0.9, minLift: 0.2 },
  },
  promotion: { minTrials: 10, tolerance: 0.15, requireCiExcludesZero: true },
  thresholdsVersion: "default-2",
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

/**
 * Skill rank from benchmark evidence. Heartwood owns thresholds; the Lab only returns facts.
 *
 * Returns `undefined` (inconclusive) when there are too few countable trials or too many infra
 * errors to say anything: that must not lower or raise a rank. Otherwise the best tier whose pass
 * rate (over countable trials) and lift over the no-skill baseline are both met; a tier that needs
 * lift cannot be reached without a baseline arm.
 */
export function deriveSkillRank(e: Evidence, rules: Rules = defaultRules): SkillRank | undefined {
  const r = rules.skillRank;
  const countable = e.trials - e.errors;
  if (e.trials <= 0 || countable < r.minTrials || e.errors / e.trials > r.maxErrorRate)
    return undefined;
  const rate = e.passes / countable;
  const lift = e.vsBaseline?.delta;
  const meets = (t: SkillRankTier) =>
    rate >= t.minPassRate && (t.minLift <= 0 || (lift !== undefined && lift >= t.minLift));
  if (meets(r.ultimate)) return "ultimate";
  if (meets(r.unique)) return "unique";
  if (meets(r.extra)) return "extra";
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
