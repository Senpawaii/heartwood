import type { PinnedSkill } from "@heartwood/protocol";

/**
 * The only surface Heartwood uses to talk to grimoire-lab. The real adapter wraps `@grimoire/core`
 * as a library (one-way dependency); never CLI output.
 *
 * The Lab reports *measurements*. Heartwood decides what they mean: ranks (`deriveSkillRank`) and
 * promotion (`evolveSkill`) are Heartwood policy, configured in `Rules`.
 */
export interface SkillRef extends PinnedSkill {
  description: string;
  version?: string;
  source: string;
}

export interface LoadedSkill {
  ref: SkillRef;
  /** SKILL.md body, ready to embed in a task spec. */
  body: string;
}

/** What one benchmark run measured about one skill. `passRate` counts errors and timeouts as failures. */
export interface Evidence {
  skill: PinnedSkill;
  suiteDigest: string;
  agent: { id: string; version?: string; model?: string };
  ranAt: string;
  /** Where the full result lives in the Lab (stable key for audit and for proposing a new version). */
  resultRef: string;
  trials: number;
  passes: number;
  /** Trials that could not measure the skill (adapter crash, rate limit, failed judge). Inconclusive, not low. */
  errors: number;
  passRate: number;
  /** Lift over the no-skill baseline, when the run had a baseline arm. */
  vsBaseline?: { delta: number; skillTrials: number; baselineTrials: number };
}

/** Candidate vs the version it would replace, on the same suite and agent. */
export interface Comparison {
  candidate: Evidence;
  baseline: Evidence;
  /** Pass-rate delta, candidate minus baseline. */
  delta: number;
  n: { candidate: number; baseline: number; candidateErrors: number; baselineErrors: number };
  /** Applied with the gate Heartwood passed in, not the Lab's defaults. */
  significant: boolean;
  /** 95% Newcombe-Wilson interval for `delta`, over countable trials. Absent when a side has none. */
  ci?: { lower: number; upper: number };
  verdict: "better" | "same" | "worse";
}

/**
 * Promotion needs real evidence: enough countable trials on each side, a real delta, and (by default) a
 * 95% interval for the delta that excludes zero. A pass-rate delta alone is noisy with LLM agents.
 */
export interface PromotionGate {
  minTrials: number;
  tolerance: number;
  /** Also require the 95% interval of the delta to exclude zero. A missing interval then counts as "no". */
  requireCiExcludesZero: boolean;
}

export interface ProposedVersion {
  skill: PinnedSkill;
  changelog: string;
}

export interface LabPort {
  listSkills(): Promise<SkillRef[]>;
  /** Sources that failed their last attempt. Listing and resolving degrade around them instead of failing. */
  sourceProblems(): SourceProblem[];
  /** The current content of a skill by name (or `name@version`). Throws if unknown or ambiguous. */
  resolve(name: string): Promise<SkillRef>;
  /** Make this exact content durable in Heartwood's own store, so a pin survives its source changing. */
  pin(ref: PinnedSkill): Promise<void>;
  /** Throws DigestMismatchError when the content no longer matches `ref.digest`. */
  load(ref: PinnedSkill): Promise<LoadedSkill>;
  verifyPin(ref: PinnedSkill): Promise<boolean>;
  /** Benchmark one skill (against no skill) on its own suite. Throws LabUnavailableError if the Lab cannot run benchmarks. */
  analyze(ref: PinnedSkill): Promise<Evidence>;
  /** Throws LabUnavailableError when the Lab has no rewriter configured. `basis` must come from `analyze`. */
  proposeVersion(ref: PinnedSkill, basis: Evidence): Promise<ProposedVersion>;
  /** Benchmark a candidate against the version it would replace, on the baseline's suite. */
  compare(candidate: PinnedSkill, baseline: PinnedSkill, gate: PromotionGate): Promise<Comparison>;
  /** Make a proposed candidate the current version of its skill. Heartwood calls this only after its own policy approved. */
  promote(candidate: PinnedSkill, replaces: PinnedSkill): Promise<SkillRef>;
  /** Text block to embed in a task spec for the given skills. */
  renderForTask(skills: readonly PinnedSkill[]): Promise<string>;
}

/**
 * One string naming the agent a measurement was made with: `id@version model`, where the model includes
 * its effort (`anthropic/claude-sonnet-5-5:high`). Part of a rank's key, so it must be built one way only.
 */
export function agentLabel(a: Evidence["agent"]): string {
  return `${a.id}${a.version ? `@${a.version}` : ""}${a.model ? ` ${a.model}` : ""}`;
}
export class DigestMismatchError extends Error {}
/** A Lab capability the underlying grimoire-lab or its configuration does not provide. Never silently stubbed. */
export class LabUnavailableError extends Error {}

/**
 * A skill source is down, so this answer cannot be trusted to be complete (for example a bare skill
 * name could be ambiguous with something the source holds). Transient, unlike LabUnavailableError.
 */
export class SourceUnavailableError extends Error {}

/** A skill source that failed, as the last attempt saw it. Cleared when it answers again. */
export interface SourceProblem {
  source: string;
  operation: "list" | "load";
  message: string;
}

/**
 * Placeholder when no Lab is configured. Every capability fails loudly with LabUnavailableError;
 * rendering zero skills is the one exception because there is nothing to render.
 */
export class UnavailableLab implements LabPort {
  constructor(private readonly reason = "no Lab adapter is configured") {}

  private unavailable(op: string): never {
    throw new LabUnavailableError(`${op}: ${this.reason}`);
  }

  async listSkills(): Promise<SkillRef[]> {
    return this.unavailable("listSkills");
  }
  async resolve(): Promise<SkillRef> {
    return this.unavailable("resolve");
  }
  async pin(): Promise<void> {
    return this.unavailable("pin");
  }
  async load(): Promise<LoadedSkill> {
    return this.unavailable("load");
  }
  async verifyPin(): Promise<boolean> {
    return this.unavailable("verifyPin");
  }
  async analyze(): Promise<Evidence> {
    return this.unavailable("analyze");
  }
  async proposeVersion(): Promise<ProposedVersion> {
    return this.unavailable("proposeVersion");
  }
  async compare(): Promise<Comparison> {
    return this.unavailable("compare");
  }
  async promote(): Promise<SkillRef> {
    return this.unavailable("promote");
  }
  async renderForTask(skills: readonly PinnedSkill[]): Promise<string> {
    return skills.length === 0 ? "" : this.unavailable("renderForTask");
  }
  sourceProblems(): SourceProblem[] {
    return [];
  }
}
