import type { HeartwoodEvent, PinnedSkill } from "@heartwood/protocol";
import type { LabCtx } from "./context.js";
import { type BenchResult, benchRef, type SkillSource, type SuiteRef } from "./lab.js";
import { skillRankForScore } from "./rules.js";

/** Absorb: the soul acquires a skill from the Lab, pinned by digest. */
export async function absorbSkill(
  ctx: LabCtx,
  o: { soulId: string; name: string; source?: SkillSource },
): Promise<PinnedSkill> {
  const ref = await ctx.lab.resolve(o.name, o.source);
  const pin = { name: ref.name, digest: ref.digest };
  if (!(await ctx.lab.verifyPin(pin)))
    throw new Error(`cannot verify pin ${pin.name}@${pin.digest}`);
  ctx.log.append([
    {
      type: "skill.absorbed",
      payload: { soulId: o.soulId, skill: pin, source: ref.source },
      actor: { kind: "soul", id: o.soulId },
      correlation: { soulId: o.soulId },
    },
  ]);
  return pin;
}

/** Analyze: benchmark a skill, record the result, and derive its rank from configurable thresholds. */
export async function analyzeSkill(
  ctx: LabCtx,
  skill: PinnedSkill,
  suite?: SuiteRef,
): Promise<BenchResult> {
  const result = await ctx.lab.analyze(skill, suite);
  ctx.log.append([
    {
      type: "skill.analyzed",
      payload: { skill, resultRef: benchRef(result), score: result.score },
      actor: { kind: "daemon" },
      correlation: {},
    },
    {
      type: "skill.ranked",
      payload: {
        skill,
        rank: skillRankForScore(result.score, ctx.rules),
        score: result.score,
        thresholdsVersion: ctx.rules.thresholdsVersion,
      },
      actor: { kind: "daemon" },
      correlation: {},
    },
  ]);
  return result;
}

export interface EvolveOutcome {
  promoted: boolean;
  candidate: PinnedSkill;
  events: HeartwoodEvent[];
}

/**
 * Evolve: analyze the current version, ask the Lab for a new one, and promote it only if a
 * benchmark comparison against the old version says "better". Propagates LabUnavailableError.
 */
export async function evolveSkill(
  ctx: LabCtx,
  current: PinnedSkill,
  suite?: SuiteRef,
): Promise<EvolveOutcome> {
  const basis = await analyzeSkill(ctx, current, suite);
  const proposal = await ctx.lab.proposeVersion(current, basis);
  const common = { name: current.name, from: current, to: proposal.skill };
  const proposed = ctx.log.append([
    {
      type: "skill.evolve_proposed",
      payload: { ...common, changelog: proposal.changelog },
      actor: { kind: "daemon" },
      correlation: {},
    },
  ]);
  const cmp = await ctx.lab.compare(proposal.skill, current, suite);
  if (cmp.verdict !== "better") {
    const rejected = ctx.log.append([
      {
        type: "skill.evolve_rejected",
        payload: {
          ...common,
          reason: `comparison verdict ${cmp.verdict} (delta ${cmp.delta.toFixed(3)})`,
        },
        actor: { kind: "daemon" },
        correlation: {},
      },
    ]);
    return { promoted: false, candidate: proposal.skill, events: [...proposed, ...rejected] };
  }
  const promoted = ctx.log.append([
    {
      type: "skill.evolve_promoted",
      payload: {
        ...common,
        comparisonRef: `${benchRef(cmp.candidate)} > ${benchRef(cmp.baseline)}`,
      },
      actor: { kind: "daemon" },
      correlation: {},
    },
  ]);
  await analyzeSkill(ctx, proposal.skill, suite);
  return { promoted: true, candidate: proposal.skill, events: [...proposed, ...promoted] };
}
