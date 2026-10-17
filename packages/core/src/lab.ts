import type { PinnedSkill } from "@heartwood/protocol";

/**
 * The only surface Heartwood uses to talk to grimoire-lab. The real adapter wraps
 * `@grimoire/core` as a library (one-way dependency); never CLI output.
 * Rank is NOT part of this boundary: the Lab returns facts, Heartwood decides (see rules.ts).
 */
export interface SkillSource {
  kind: "grimoire" | "path" | "git";
  location?: string;
}

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

export interface BenchTaskResult {
  id: string;
  passed: boolean;
  score: number;
  tokens?: number;
  durationMs: number;
}

export interface BenchResult {
  schemaVersion: 1;
  skill: PinnedSkill;
  suiteDigest: string;
  /** 0..1 */
  score: number;
  trials: number;
  agent: string;
  model?: string;
  ranAt: string;
  tasks: BenchTaskResult[];
}

export interface Comparison {
  candidate: BenchResult;
  baseline: BenchResult;
  delta: number;
  significant: boolean;
  verdict: "better" | "same" | "worse";
}

export interface ProposedVersion {
  skill: PinnedSkill;
  changelog: string;
}

export interface SuiteRef {
  name: string;
}

export interface LabPort {
  listSkills(source?: SkillSource): Promise<SkillRef[]>;
  resolve(name: string, source?: SkillSource): Promise<SkillRef>;
  /** Throws DigestMismatchError when the content under `ref.name` no longer matches `ref.digest`. */
  load(ref: PinnedSkill): Promise<LoadedSkill>;
  verifyPin(ref: PinnedSkill): Promise<boolean>;
  analyze(ref: PinnedSkill, suite?: SuiteRef): Promise<BenchResult>;
  /** Throws LabUnavailableError when the Lab has no rewriter configured. */
  proposeVersion(ref: PinnedSkill, basis: BenchResult): Promise<ProposedVersion>;
  compare(candidate: PinnedSkill, baseline: PinnedSkill, suite?: SuiteRef): Promise<Comparison>;
  /** Text block to embed in a task spec for the given skills. */
  renderForTask(skills: readonly PinnedSkill[]): Promise<string>;
}

export class DigestMismatchError extends Error {}
/** A Lab capability the underlying grimoire-lab does not provide yet. Never silently stubbed. */
export class LabUnavailableError extends Error {}

export function benchRef(r: BenchResult): string {
  return `${r.skill.name}@${r.skill.digest}#${r.suiteDigest}:${r.ranAt}`;
}
