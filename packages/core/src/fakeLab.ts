import { createHash } from "node:crypto";
import type { PinnedSkill } from "@heartwood/protocol";
import {
  type BenchResult,
  type Comparison,
  DigestMismatchError,
  type LabPort,
  LabUnavailableError,
  type LoadedSkill,
  type ProposedVersion,
  type SkillRef,
  type SkillSource,
  type SuiteRef,
} from "./lab.js";

export const digestOf = (body: string): string =>
  `sha256:${createHash("sha256").update(body).digest("hex")}`;

export type Rewriter = (
  skill: LoadedSkill,
  basis: BenchResult,
) => { body: string; changelog: string };

/** In-memory Lab for tests and local development. Scores are scripted. */
export class FakeLab implements LabPort {
  /** name -> digest -> body */
  private versions = new Map<string, Map<string, string>>();
  private latest = new Map<string, string>();
  private scores = new Map<string, number>();
  private descriptions = new Map<string, string>();
  rewriter?: Rewriter;
  significanceDelta = 0.05;

  addSkill(name: string, body: string, description = name): SkillRef {
    const digest = digestOf(body);
    const v = this.versions.get(name) ?? new Map();
    v.set(digest, body);
    this.versions.set(name, v);
    this.latest.set(name, digest);
    this.descriptions.set(name, description);
    return this.ref(name, digest);
  }

  /** Script the benchmark score for a skill digest. Unscripted skills score 0. */
  setScore(skill: PinnedSkill, score: number): void {
    this.scores.set(skill.digest, score);
  }

  /** Overwrite the content of the current version without changing its digest (simulates tampering). */
  corrupt(skill: PinnedSkill, body: string): void {
    this.versions.get(skill.name)?.set(skill.digest, body);
  }

  private ref(name: string, digest: string): SkillRef {
    return { name, digest, description: this.descriptions.get(name) ?? name, source: "fake" };
  }

  async listSkills(_source?: SkillSource): Promise<SkillRef[]> {
    return [...this.latest].map(([n, d]) => this.ref(n, d));
  }

  async resolve(name: string): Promise<SkillRef> {
    const d = this.latest.get(name);
    if (!d) throw new Error(`skill not found: ${name}`);
    return this.ref(name, d);
  }

  async load(ref: PinnedSkill): Promise<LoadedSkill> {
    const body = this.versions.get(ref.name)?.get(ref.digest);
    if (body === undefined) throw new Error(`skill not found: ${ref.name}@${ref.digest}`);
    if (digestOf(body) !== ref.digest)
      throw new DigestMismatchError(`${ref.name}: content does not match ${ref.digest}`);
    return { ref: this.ref(ref.name, ref.digest), body };
  }

  async verifyPin(ref: PinnedSkill): Promise<boolean> {
    return this.versions.get(ref.name)?.has(ref.digest) ?? false;
  }

  async analyze(ref: PinnedSkill, suite: SuiteRef = { name: "default" }): Promise<BenchResult> {
    await this.load(ref);
    const score = this.scores.get(ref.digest) ?? 0;
    return {
      schemaVersion: 1,
      skill: { name: ref.name, digest: ref.digest },
      suiteDigest: `suite:${suite.name}`,
      score,
      trials: 1,
      agent: "fake",
      ranAt: new Date(0).toISOString(),
      tasks: [{ id: "t1", passed: score >= 0.5, score, durationMs: 1 }],
    };
  }

  async proposeVersion(ref: PinnedSkill, basis: BenchResult): Promise<ProposedVersion> {
    if (!this.rewriter)
      throw new LabUnavailableError("proposeVersion: no skill rewriter configured in the Lab");
    const { body, changelog } = this.rewriter(await this.load(ref), basis);
    const next = this.addSkill(ref.name, body, this.descriptions.get(ref.name));
    // proposing must not move the "latest" pointer onto an unpromoted version
    this.latest.set(ref.name, ref.digest);
    return { skill: { name: next.name, digest: next.digest }, changelog };
  }

  async compare(
    candidate: PinnedSkill,
    baseline: PinnedSkill,
    suite?: SuiteRef,
  ): Promise<Comparison> {
    const [c, b] = [await this.analyze(candidate, suite), await this.analyze(baseline, suite)];
    const delta = c.score - b.score;
    const significant = Math.abs(delta) >= this.significanceDelta;
    return {
      candidate: c,
      baseline: b,
      delta,
      significant,
      verdict: !significant ? "same" : delta > 0 ? "better" : "worse",
    };
  }

  async renderForTask(skills: readonly PinnedSkill[]): Promise<string> {
    if (skills.length === 0) return "";
    const loaded = await Promise.all(skills.map((s) => this.load(s)));
    return loaded.map((l) => `### Skill: ${l.ref.name} (${l.ref.digest})\n${l.body}`).join("\n\n");
  }
}
