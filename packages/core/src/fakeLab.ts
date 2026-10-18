import { createHash } from "node:crypto";
import type { PinnedSkill } from "@heartwood/protocol";
import { NotFoundError } from "./errors.js";
import {
  type Comparison,
  DigestMismatchError,
  type Evidence,
  type LabPort,
  LabUnavailableError,
  type LoadedSkill,
  type PromotionGate,
  type ProposedVersion,
  type SkillRef,
  type SourceProblem,
} from "./lab.js";

export const digestOf = (body: string): string =>
  `sha256:${createHash("sha256").update(body).digest("hex")}`;

export type Rewriter = (skill: LoadedSkill, basis: Evidence) => { body: string; changelog: string };

export interface ScriptedResult {
  trials: number;
  passes: number;
  /** Infra errors among the trials. */
  errors: number;
  /** Pass rate of the no-skill baseline arm; undefined = the run had no baseline arm. */
  baselineRate?: number;
}

/** In-memory Lab for tests and local development. Benchmark results are scripted, not measured. */
export class FakeLab implements LabPort {
  /** name -> digest -> body */
  private versions = new Map<string, Map<string, string>>();
  private latest = new Map<string, string>();
  private results = new Map<string, ScriptedResult>();
  private descriptions = new Map<string, string>();
  readonly pinned = new Set<string>();
  readonly promotions: { candidate: PinnedSkill; replaces: PinnedSkill }[] = [];
  rewriter?: Rewriter;
  /** The agent and suite the next benchmarks report, so tests can measure one skill under several. */
  agent: Evidence["agent"] = { id: "fake" };
  suite = "default";

  addSkill(name: string, body: string, description = name): SkillRef {
    const digest = digestOf(body);
    const v = this.versions.get(name) ?? new Map();
    v.set(digest, body);
    this.versions.set(name, v);
    this.latest.set(name, digest);
    this.descriptions.set(name, description);
    return this.ref(name, digest);
  }

  /** Script what benchmarking this exact content will report. */
  setResult(skill: PinnedSkill, r: ScriptedResult): void {
    this.results.set(skill.digest, r);
  }

  /** Convenience: 10 clean trials at `passRate`, against a no-skill baseline that always fails (so lift = passRate). */
  setScore(skill: PinnedSkill, passRate: number): void {
    this.setResult(skill, {
      trials: 10,
      passes: Math.round(passRate * 10),
      errors: 0,
      baselineRate: 0,
    });
  }

  /** Overwrite the content of a version without changing its digest (simulates tampering). */
  corrupt(skill: PinnedSkill, body: string): void {
    this.versions.get(skill.name)?.set(skill.digest, body);
  }

  private ref(name: string, digest: string): SkillRef {
    return { name, digest, description: this.descriptions.get(name) ?? name, source: "fake" };
  }

  async listSkills(): Promise<SkillRef[]> {
    return [...this.latest].map(([n, d]) => this.ref(n, d));
  }

  sourceProblems(): SourceProblem[] {
    return [];
  }

  async resolve(name: string): Promise<SkillRef> {
    const d = this.latest.get(name);
    if (!d) throw new NotFoundError(`skill not found: ${name}`);
    return this.ref(name, d);
  }

  async pin(ref: PinnedSkill): Promise<void> {
    await this.load(ref);
    this.pinned.add(ref.digest);
  }

  async load(ref: PinnedSkill): Promise<LoadedSkill> {
    const body = this.versions.get(ref.name)?.get(ref.digest);
    if (body === undefined) throw new NotFoundError(`skill not found: ${ref.name}@${ref.digest}`);
    if (digestOf(body) !== ref.digest)
      throw new DigestMismatchError(`${ref.name}: content does not match ${ref.digest}`);
    return { ref: this.ref(ref.name, ref.digest), body };
  }

  async verifyPin(ref: PinnedSkill): Promise<boolean> {
    return this.versions.get(ref.name)?.has(ref.digest) ?? false;
  }

  private evidence(ref: PinnedSkill): Evidence {
    const r = this.results.get(ref.digest) ?? { trials: 10, passes: 0, errors: 0, baselineRate: 0 };
    const countable = r.trials - r.errors;
    return {
      skill: { name: ref.name, digest: ref.digest },
      suiteDigest: `suite:${ref.name}:${this.suite}`,
      agent: this.agent,
      ranAt: new Date(0).toISOString(),
      resultRef: `fake:${ref.digest}`,
      trials: r.trials,
      passes: r.passes,
      errors: r.errors,
      passRate: r.trials === 0 ? 0 : r.passes / r.trials,
      vsBaseline:
        r.baselineRate === undefined || countable === 0
          ? undefined
          : {
              delta: r.passes / countable - r.baselineRate,
              skillTrials: r.trials,
              baselineTrials: r.trials,
            },
    };
  }

  async analyze(ref: PinnedSkill): Promise<Evidence> {
    await this.load(ref);
    return this.evidence(ref);
  }

  async proposeVersion(ref: PinnedSkill, basis: Evidence): Promise<ProposedVersion> {
    if (!this.rewriter)
      throw new LabUnavailableError("proposeVersion: no skill rewriter configured in the Lab");
    const { body, changelog } = this.rewriter(await this.load(ref), basis);
    const next = this.addSkill(ref.name, body, this.descriptions.get(ref.name));
    // proposing must not move the "current" pointer onto an unpromoted version
    this.latest.set(ref.name, ref.digest);
    return { skill: { name: next.name, digest: next.digest }, changelog };
  }

  async compare(
    candidate: PinnedSkill,
    baseline: PinnedSkill,
    gate: PromotionGate,
  ): Promise<Comparison> {
    const [c, b] = [await this.analyze(candidate), await this.analyze(baseline)];
    const cn = c.trials - c.errors;
    const bn = b.trials - b.errors;
    const delta = (cn === 0 ? 0 : c.passes / cn) - (bn === 0 ? 0 : b.passes / bn);
    const ci = cn > 0 && bn > 0 ? newcombe(c.passes, cn, b.passes, bn) : undefined;
    const ciOk =
      !gate.requireCiExcludesZero || (ci !== undefined && (ci.lower > 0 || ci.upper < 0));
    const significant =
      cn >= gate.minTrials &&
      bn >= gate.minTrials &&
      Math.abs(delta) >= gate.tolerance &&
      delta !== 0 &&
      ciOk;
    return {
      candidate: c,
      baseline: b,
      delta,
      n: {
        candidate: c.trials,
        baseline: b.trials,
        candidateErrors: c.errors,
        baselineErrors: b.errors,
      },
      significant,
      ci,
      verdict: !significant ? "same" : delta > 0 ? "better" : "worse",
    };
  }

  async promote(candidate: PinnedSkill, replaces: PinnedSkill): Promise<SkillRef> {
    await this.load(candidate);
    this.latest.set(candidate.name, candidate.digest);
    this.pinned.add(candidate.digest);
    this.promotions.push({ candidate, replaces });
    return this.ref(candidate.name, candidate.digest);
  }

  async renderForTask(skills: readonly PinnedSkill[]): Promise<string> {
    if (skills.length === 0) return "";
    const loaded = await Promise.all(skills.map((s) => this.load(s)));
    return loaded.map((l) => `### Skill: ${l.ref.name} (${l.ref.digest})\n${l.body}`).join("\n\n");
  }
}

const Z = 1.96;

/** Wilson score interval for `x` successes in `n` trials (95%). */
function wilson(x: number, n: number): { p: number; lower: number; upper: number } {
  const p = x / n;
  const denom = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denom;
  return { p, lower: centre - half, upper: centre + half };
}

/**
 * Newcombe hybrid-score 95% interval for the difference of two independent proportions, the same
 * method grimoire-lab uses, so the fake gates a comparison the way the real Lab does.
 */
function newcombe(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): { lower: number; upper: number } {
  const a = wilson(x1, n1);
  const b = wilson(x2, n2);
  const d = a.p - b.p;
  return {
    lower: d - Math.sqrt((a.p - a.lower) ** 2 + (b.upper - b.p) ** 2),
    upper: d + Math.sqrt((a.upper - a.p) ** 2 + (b.p - b.lower) ** 2),
  };
}
