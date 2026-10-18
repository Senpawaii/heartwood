import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentAdapter,
  AmbiguousSkill,
  armRef,
  type BenchResult,
  benchProposal,
  benchSkill,
  DigestMismatch,
  evidenceFor,
  type LoadedSkill as GrimoireLoadedSkill,
  compare as grimoireCompare,
  proposeVersion as grimoireProposeVersion,
  loadSkillByDigest,
  loadSuite,
  NoChange,
  type ResultStore,
  RewriterNotAvailable,
  resolveSkill,
  type Skill,
  type SkillListing,
  SkillNotFound,
  type SkillRewriter,
  type SkillSource,
  splitFrontmatter,
} from "@grimoire/core";
import {
  type BenchOptions,
  type Comparison,
  DigestMismatchError,
  DomainError,
  type Evidence,
  type LabPort,
  LabUnavailableError,
  type LoadedSkill,
  NotFoundError,
  type PromotionGate,
  type ProposedVersion,
  type ProposeOptions,
  type SkillRef,
  type SourceProblem,
  SourceUnavailableError,
} from "@heartwood/core";
import type { PinnedSkill } from "@heartwood/protocol";
import type { SkillStore } from "./store.js";

const SUITE_FILE = "grimoire.bench.yaml";
const REF_PREFIX = "grimoire:";
/** Files that are not part of what a worker is given: benchmark inputs and the entry file itself. */
const NOT_BUNDLED = new Set(["SKILL.md", SUITE_FILE, "fixtures", ".git"]);

export interface GrimoireLabOptions {
  /** Catalogs to find skills in, e.g. `dirSource("grimoire/skills")`. Read-only. */
  sources: SkillSource[];
  /** Heartwood's own content-addressed store: pins and promoted versions live here. */
  store: SkillStore;
  /** Persists every benchmark result; `Evidence.resultRef` points into it. */
  results: ResultStore;
  /** Where benchmark transcripts are written. */
  outDir: string;
  /**
   * Runs the agent for benchmarks. grimoire-lab never imports an adapter; without one, `analyze`
   * and `compare` fail with LabUnavailableError instead of pretending.
   */
  agent?: AgentAdapter;
  /**
   * Makes the editor of a staged candidate (an LLM-driven agent, a human script) for one proposal, given the
   * model chosen for it. Without one, `proposeVersion` fails with LabUnavailableError.
   */
  rewriter?: (choice: { model?: string }) => SkillRewriter;
  repeat?: number;
  /** Model benchmarks run with unless the caller names one. */
  model?: string;
  /** Model the rewriter uses unless the caller names one. */
  rewriterModel?: string;
  /** Called whenever a catalog source fails, for logging. The failure is also kept in `sourceProblems()`. */
  onSourceProblem?: (problem: SourceProblem) => void;
}

/** Staged candidates that are not in any catalog yet: a `SkillSource` so they can be loaded by digest. */
class Staging implements SkillSource {
  readonly id = "heartwood-staging";
  readonly skills = new Map<string, Skill>();
  async list(): Promise<SkillListing[]> {
    return []; // candidates are not part of the catalog
  }
  async load(digest: string): Promise<GrimoireLoadedSkill | undefined> {
    const skill = this.skills.get(digest);
    return skill ? { skill, dispose: async () => {} } : undefined;
  }
}

/** `@grimoire/core` errors, as Heartwood's. */
function translate(err: unknown): never {
  if (err instanceof SkillNotFound) throw new NotFoundError(err.message);
  if (err instanceof DigestMismatch) throw new DigestMismatchError(err.message);
  if (err instanceof AmbiguousSkill) throw new DomainError(err.message);
  throw err;
}

/**
 * The Lab over grimoire-lab as a library. Measurements come from `@grimoire/core`; every decision
 * (what a rank is, whether a version is promoted) stays in Heartwood.
 */
/**
 * The version a rewritten skill gets: the patch number plus one (`1.0.9` becomes `1.0.10`). A version that is
 * absent or not plain `x.y.z` is left alone (undefined), because guessing a label for it would be wrong.
 */
export function bumpPatch(version: string | undefined): string | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : undefined;
}

export class GrimoireLab implements LabPort {
  private readonly staging = new Staging();
  private readonly stagedDirs: string[] = [];

  /** The catalogs, each wrapped so one that throws is reported and skipped rather than breaking the others. */
  private readonly sources: SkillSource[];
  private readonly problems = new Map<string, SourceProblem>();

  constructor(private readonly o: GrimoireLabOptions) {
    this.sources = o.sources.map((s) => this.guard(s));
  }

  private guard(src: SkillSource): SkillSource {
    const fail = (operation: SourceProblem["operation"], err: unknown): void => {
      const p = {
        source: src.id,
        operation,
        message: err instanceof Error ? err.message : String(err),
      };
      this.problems.set(src.id, p);
      this.o.onSourceProblem?.(p);
    };
    return {
      id: src.id,
      list: async () => {
        try {
          const listings = await src.list();
          this.problems.delete(src.id); // it answered: whatever was wrong is over
          return listings;
        } catch (err) {
          fail("list", err);
          return [];
        }
      },
      load: async (digest) => {
        try {
          return await src.load(digest);
        } catch (err) {
          fail("load", err);
          return undefined;
        }
      },
    };
  }

  /** Everything a pinned digest can be loaded from. */
  private get all(): SkillSource[] {
    return [this.o.store, ...this.sources, this.staging];
  }

  private requireAgent(op: string): AgentAdapter {
    if (!this.o.agent)
      throw new LabUnavailableError(
        `${op}: no AgentAdapter is configured, so benchmarks cannot run`,
      );
    return this.o.agent;
  }

  private toRef(l: SkillListing): SkillRef {
    return {
      name: l.name,
      digest: l.digest,
      description: l.description,
      version: l.version,
      source: l.source ?? "unknown",
    };
  }

  async listSkills(): Promise<SkillRef[]> {
    const byName = new Map<string, SkillRef>();
    // a source that is down contributes nothing (and is reported by sourceProblems) instead of failing the catalog
    for (const src of this.sources)
      for (const l of await src.list()) if (l.current !== false) byName.set(l.name, this.toRef(l));
    // a version promoted into Heartwood's store supersedes what the catalog still holds
    for (const l of await this.o.store.list()) if (l.current) byName.set(l.name, this.toRef(l));
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  sourceProblems(): SourceProblem[] {
    return [...this.problems.values()];
  }

  async resolve(name: string): Promise<SkillRef> {
    // `name@1.2.0` and `sha256:…` (or `name@sha256:…`) name exactly one thing; a bare `name` means "the current one"
    const isBareName = !name.includes("@") && !name.startsWith("sha256:");
    if (isBareName) {
      const bare = name;
      const promoted = await this.o.store.currentDigest(bare);
      if (promoted) {
        const hit = (await this.o.store.list()).find((l) => l.digest === promoted);
        if (hit) return this.toRef(hit);
      }
    }
    // Heartwood's store holds promoted versions, which a catalog may not (yet) list. A bare name already
    // consulted it above; an exact name@version or digest must look there too, or a promoted version cannot be pinned.
    const searched = isBareName ? this.sources : [this.o.store, ...this.sources];
    const listings = (await Promise.all(searched.map((s) => s.list()))).flat();
    const down = [...this.problems.values()].filter((p) => p.operation === "list");
    // A bare name is only unambiguous if every source was heard from; a digest or name@version is exact.
    if (isBareName && down.length > 0)
      throw new SourceUnavailableError(
        `cannot resolve "${name}" while ${down.map((p) => `${p.source} is unavailable (${p.message})`).join("; ")}: it might be ambiguous. Use name@version or a digest, or retry`,
      );
    try {
      const ref = await resolveSkill(name, searched);
      const listing = listings.find((l) => l.digest === ref.digest && l.name === ref.name);
      return {
        name: ref.name,
        digest: ref.digest,
        version: ref.version,
        description: listing?.description ?? "",
        source: ref.source ?? "unknown",
      };
    } catch (err) {
      return translate(err);
    }
  }

  async pin(ref: PinnedSkill): Promise<void> {
    const loaded = await this.open(ref);
    try {
      await this.o.store.add(loaded.skill, { current: false });
    } finally {
      await loaded.dispose();
    }
  }

  private async open(ref: PinnedSkill) {
    try {
      return await loadSkillByDigest(ref.digest, this.all);
    } catch (err) {
      return translate(err);
    }
  }

  async verifyPin(ref: PinnedSkill): Promise<boolean> {
    try {
      await (await loadSkillByDigest(ref.digest, this.all)).dispose();
      return true;
    } catch (err) {
      if (err instanceof SkillNotFound || err instanceof DigestMismatch) return false;
      throw err;
    }
  }

  async load(ref: PinnedSkill): Promise<LoadedSkill> {
    const loaded = await this.open(ref);
    try {
      const source = await readFile(join(loaded.skill.dir, "SKILL.md"), "utf8");
      const s = loaded.skill;
      return {
        ref: {
          name: s.name,
          digest: s.digest,
          version: s.version,
          description: s.description,
          source: "grimoire",
        },
        body: splitFrontmatter(source).body.trim(),
      };
    } finally {
      await loaded.dispose();
    }
  }

  async renderForTask(skills: readonly PinnedSkill[]): Promise<string> {
    const blocks: string[] = [];
    for (const pin of skills) {
      const loaded = await this.open(pin);
      try {
        const { ref, body } = await this.load(pin);
        const extra = (await readdir(loaded.skill.dir)).filter((f) => !NOT_BUNDLED.has(f));
        const note = extra.length
          ? `\n\n(This skill also bundles ${extra.join(", ")}, which are not available in this task. Only the instructions above are.)`
          : "";
        blocks.push(
          `### Skill: ${ref.name}${ref.version ? ` v${ref.version}` : ""} (${ref.digest})\n${body}${note}`,
        );
      } finally {
        await loaded.dispose();
      }
    }
    return blocks.join("\n\n");
  }

  async analyze(ref: PinnedSkill, opts: BenchOptions = {}): Promise<Evidence> {
    const adapter = this.requireAgent("analyze");
    const loaded = await this.open(ref);
    try {
      const suite = await this.suiteOf(loaded.skill);
      const result = await benchSkill({
        skill: loaded.skill,
        suite,
        adapter,
        outDir: this.o.outDir,
        store: this.o.results,
        repeat: this.o.repeat,
        model: opts.model ?? this.o.model,
      });
      return toEvidence(result, loaded.skill);
    } finally {
      await loaded.dispose();
    }
  }

  private async suiteOf(skill: Skill) {
    try {
      return await loadSuite(join(skill.dir, SUITE_FILE));
    } catch (err) {
      throw new DomainError(
        `${skill.name} has no benchmark suite (${SUITE_FILE}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async proposeVersion(
    ref: PinnedSkill,
    basis: Evidence,
    opts: ProposeOptions = {},
  ): Promise<ProposedVersion> {
    if (!this.o.rewriter)
      throw new LabUnavailableError("proposeVersion: no skill rewriter is configured");
    if (!basis.resultRef.startsWith(REF_PREFIX))
      throw new DomainError(`not a grimoire result: ${basis.resultRef}`);
    const stored = this.o.results.getResult(basis.resultRef.slice(REF_PREFIX.length));
    if (!stored) throw new NotFoundError(`unknown benchmark result: ${basis.resultRef}`);
    const loaded = await this.open(ref);
    try {
      const root = await mkdtemp(join(tmpdir(), "heartwood-candidate-"));
      this.stagedDirs.push(root);
      const outDir = join(root, loaded.skill.name);
      await mkdir(root, { recursive: true });
      const proposal = await grimoireProposeVersion(loaded.skill, stored, {
        rewriter: this.o.rewriter({ model: opts.rewriterModel ?? this.o.rewriterModel }),
        outDir,
        // a new content needs a new label, or name@version would name two different things
        version: bumpPatch(loaded.skill.version),
      });
      this.staging.skills.set(proposal.digest, proposal.skill);
      return {
        skill: { name: proposal.skill.name, digest: proposal.digest },
        changelog: proposal.changelog,
      };
    } catch (err) {
      if (err instanceof RewriterNotAvailable) throw new LabUnavailableError(err.message);
      if (err instanceof NoChange) throw new DomainError(err.message);
      throw err;
    } finally {
      await loaded.dispose();
    }
  }

  async compare(
    candidate: PinnedSkill,
    baseline: PinnedSkill,
    gate: PromotionGate,
    opts: BenchOptions = {},
  ): Promise<Comparison> {
    const adapter = this.requireAgent("compare");
    const cand = await this.open(candidate);
    const base = await this.open(baseline);
    try {
      // both versions face the suite of the version being replaced; a staged candidate carries none
      const suite = await this.suiteOf(base.skill);
      const { result } = await benchProposal({
        current: base.skill,
        candidate: cand.skill,
        suite,
        adapter,
        outDir: this.o.outDir,
        store: this.o.results,
        repeat: this.o.repeat,
        model: opts.model ?? this.o.model,
        baseline: true, // also measure no-skill, so the candidate can be ranked from the same run
      });
      // Heartwood's gate, not grimoire's defaults
      const c = grimoireCompare(armRef(result, cand.skill), armRef(result, base.skill), {
        minTrials: gate.minTrials,
        tolerance: gate.tolerance,
        requireCiExcludesZero: gate.requireCiExcludesZero,
      });
      return {
        candidate: toEvidence(result, cand.skill),
        baseline: toEvidence(result, base.skill),
        delta: c.gate.delta ?? c.deltas.passRate,
        n: {
          candidate: c.n.subject,
          baseline: c.n.reference,
          candidateErrors: c.n.subjectErrors,
          baselineErrors: c.n.referenceErrors,
        },
        significant: c.significant,
        ci: c.ci ? { lower: c.ci.lower, upper: c.ci.upper } : undefined,
        verdict: c.verdict,
      };
    } finally {
      await cand.dispose();
      await base.dispose();
    }
  }

  async promote(candidate: PinnedSkill, replaces: PinnedSkill): Promise<SkillRef> {
    const cand = await this.open(candidate);
    const old = await this.open(replaces);
    try {
      await this.o.store.add(old.skill, { current: false }); // souls pinned to the old version can still load it
      await this.o.store.add(cand.skill, { current: true, suiteFrom: old.skill.dir });
      this.staging.skills.delete(cand.skill.digest);
      const s = cand.skill;
      return {
        name: s.name,
        digest: s.digest,
        version: s.version,
        description: s.description,
        source: this.o.store.id,
      };
    } finally {
      await cand.dispose();
      await old.dispose();
    }
  }

  /** Remove staged candidates (temp directories). Call on shutdown. */
  async close(): Promise<void> {
    await Promise.all(
      this.stagedDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
    this.staging.skills.clear();
  }
}

/** One skill's measurements, as Heartwood's `Evidence`. The lift uses the gate's own delta (infra errors excluded). */
function toEvidence(result: BenchResult, skill: { name: string; digest: string }): Evidence {
  const e = evidenceFor(result, { digest: skill.digest });
  const vs = e.vsBaseline;
  return {
    skill: { name: skill.name, digest: skill.digest },
    suiteDigest: result.suite.digest,
    agent: e.agent,
    ranAt: result.startedAt,
    resultRef: `${REF_PREFIX}${result.id}`,
    trials: e.score.trials,
    passes: e.score.passes,
    errors: e.score.errors,
    passRate: e.score.passRate,
    vsBaseline: vs
      ? {
          delta: vs.gate.delta ?? vs.deltas.passRate,
          skillTrials: vs.n.subject,
          baselineTrials: vs.n.reference,
        }
      : undefined,
  };
}
