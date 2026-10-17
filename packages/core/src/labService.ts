import type { HeartwoodEvent, PinnedSkill, SkillRank } from "@heartwood/protocol";
import type { LabCtx } from "./context.js";
import { DomainError } from "./errors.js";
import type { Comparison, Evidence } from "./lab.js";
import { deriveSkillRank } from "./rules.js";

/** Absorb: the soul acquires a skill from the Lab, pinned by digest and kept in Heartwood's own store. */
export async function absorbSkill(
  ctx: LabCtx,
  o: { soulId: string; name: string },
): Promise<PinnedSkill> {
  const ref = await ctx.lab.resolve(o.name);
  const pin = { name: ref.name, digest: ref.digest };
  if (!(await ctx.lab.verifyPin(pin)))
    throw new DomainError(`cannot verify pin ${pin.name}@${pin.digest}`);
  await ctx.lab.pin(pin);
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

/** Record one measurement. The rank is derived from it, and only when the measurement is conclusive. */
function recordEvidence(
  ctx: LabCtx,
  e: Evidence,
): { rank: SkillRank | undefined; events: HeartwoodEvent[] } {
  const rank = deriveSkillRank(e, ctx.rules);
  const events = ctx.log.append([
    {
      type: "skill.analyzed",
      payload: {
        skill: e.skill,
        resultRef: e.resultRef,
        score: e.passRate,
        trials: e.trials,
        errors: e.errors,
        conclusive: rank !== undefined,
      },
      actor: { kind: "daemon" },
      correlation: {},
    },
    ...(rank
      ? [
          {
            type: "skill.ranked" as const,
            payload: {
              skill: e.skill,
              rank,
              score: e.passRate,
              thresholdsVersion: ctx.rules.thresholdsVersion,
            },
            actor: { kind: "daemon" as const },
            correlation: {},
          },
        ]
      : []),
  ]);
  return { rank, events };
}

export interface Analysis {
  evidence: Evidence;
  /** Undefined when the benchmark was inconclusive (too few trials, too many infra errors). */
  rank: SkillRank | undefined;
}

/** Analyze: benchmark a skill, record the evidence, and derive its rank from configurable thresholds. */
export async function analyzeSkill(ctx: LabCtx, skill: PinnedSkill): Promise<Analysis> {
  const evidence = await ctx.lab.analyze(skill);
  return { evidence, rank: recordEvidence(ctx, evidence).rank };
}

export interface EvolveOutcome {
  promoted: boolean;
  candidate: PinnedSkill;
  comparison: Comparison;
  events: HeartwoodEvent[];
}

/**
 * Evolve: analyze the current version, ask the Lab for a new one, and promote it only when a
 * benchmark comparison against the old version clears Heartwood's promotion gate and says "better".
 * Propagates LabUnavailableError when the Lab cannot benchmark or has no rewriter.
 */
export async function evolveSkill(ctx: LabCtx, current: PinnedSkill): Promise<EvolveOutcome> {
  const basis = await analyzeSkill(ctx, current);
  const proposal = await ctx.lab.proposeVersion(current, basis.evidence);
  const common = { name: current.name, from: current, to: proposal.skill };
  const events = ctx.log.append([
    {
      type: "skill.evolve_proposed",
      payload: { ...common, changelog: proposal.changelog },
      actor: { kind: "daemon" },
      correlation: {},
    },
  ]);

  const gate = ctx.rules.promotion;
  const cmp = await ctx.lab.compare(proposal.skill, current, gate);
  events.push(...recordEvidence(ctx, cmp.candidate).events);

  if (!(cmp.significant && cmp.verdict === "better")) {
    const why = cmp.significant
      ? `verdict ${cmp.verdict} (delta ${cmp.delta.toFixed(3)})`
      : `not significant: delta ${cmp.delta.toFixed(3)} on ${cmp.n.candidate}/${cmp.n.baseline} trials (needs at least ${gate.minTrials} countable trials per side and |delta| >= ${gate.tolerance})`;
    events.push(
      ...ctx.log.append([
        {
          type: "skill.evolve_rejected",
          payload: { ...common, reason: why },
          actor: { kind: "daemon" },
          correlation: {},
        },
      ]),
    );
    return { promoted: false, candidate: proposal.skill, comparison: cmp, events };
  }

  await ctx.lab.promote(proposal.skill, current);
  events.push(
    ...ctx.log.append([
      {
        type: "skill.evolve_promoted",
        payload: {
          ...common,
          comparisonRef: `${cmp.candidate.resultRef} > ${cmp.baseline.resultRef}`,
        },
        actor: { kind: "daemon" },
        correlation: {},
      },
    ]),
  );
  return { promoted: true, candidate: proposal.skill, comparison: cmp, events };
}
