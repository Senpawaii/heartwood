import {
  type BenchOptions,
  type Comparison,
  digestOf,
  type Evidence,
  FakeLab,
  type PromotionGate,
  type ProposedVersion,
  type ProposeOptions,
} from "@heartwood/core";
import type { PinnedSkill } from "@heartwood/protocol";
import type { FastifyInstance } from "fastify";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A Lab for trying the UI without agents or models: results are scripted (`FakeLab`), and every
 * benchmark takes `delayMs`, so the busy states of Analyze and Evolve can be seen and clicked through.
 */
export class DemoLab extends FakeLab {
  delayMs = 0;

  override async analyze(ref: PinnedSkill, opts?: BenchOptions): Promise<Evidence> {
    await sleep(this.delayMs);
    return super.analyze(ref, opts);
  }
  override async proposeVersion(
    ref: PinnedSkill,
    basis: Evidence,
    opts?: ProposeOptions,
  ): Promise<ProposedVersion> {
    await sleep(this.delayMs);
    return super.proposeVersion(ref, basis, opts);
  }
  override async compare(
    candidate: PinnedSkill,
    baseline: PinnedSkill,
    gate: PromotionGate,
    opts?: BenchOptions,
  ): Promise<Comparison> {
    await sleep(this.delayMs);
    return super.compare(candidate, baseline, gate, opts);
  }
}

/** What a demo skill measures, and how its next version will measure (this decides Evolve's verdict). */
interface DemoSkill {
  name: string;
  description: string;
  body: string;
  /** Pass rate of this version over 10 trials. */
  passRate: number;
  /** Pass rate the rewriter's next version will have: better, the same, or worse. */
  nextPassRate: number;
  /** Benchmark it up front so it has a rank. */
  analyzed: boolean;
}

const SKILLS: DemoSkill[] = [
  {
    name: "tdd",
    description: "Use when implementing or fixing behaviour: write a failing test, then the code.",
    body: "Write the failing test first.",
    passRate: 0.9,
    nextPassRate: 0.9, // already good: a rewrite changes nothing measurable, so Evolve keeps the current version
    analyzed: true,
  },
  {
    name: "greeter",
    description: "Use when asked to write a greeting file.",
    body: "Greeting files should be warm.",
    passRate: 0,
    nextPassRate: 1, // clearly better: Evolve promotes it
    analyzed: true,
  },
  {
    name: "code-review",
    description: "Use when asked to review a change: check correctness, then risk, then style.",
    body: "Review the diff for correctness first.",
    passRate: 0.6,
    nextPassRate: 0, // a clearly worse rewrite: Evolve refuses it (a mild drop at 10 trials would only read "same")
    analyzed: true,
  },
  {
    name: "release-notes",
    description: "Use when asked to write release notes from a list of commits.",
    body: "Group commits by user-visible change.",
    passRate: 0.3,
    nextPassRate: 0.8, // not analyzed yet: press Analyze, then Evolve
    analyzed: false,
  },
];

/**
 * Fills a daemon that runs on fakes with a small town and a few skills whose benchmarks are scripted
 * to show every outcome of Analyze and Evolve: promoted, kept (no measurable change), and refused (worse).
 */
export async function seedDemo(app: FastifyInstance, lab: DemoLab): Promise<void> {
  lab.agent = { id: "omp", version: "demo", model: "demo-model" };

  const post = async (url: string, payload: object) => {
    const res = await app.inject({ method: "POST", url, payload });
    if (res.statusCode >= 300)
      throw new Error(`demo seed ${url} failed: ${res.statusCode} ${res.body}`);
    return res.json();
  };

  const next = new Map<string, DemoSkill>();
  for (const s of SKILLS) {
    const ref = lab.addSkill(s.name, s.body, s.description);
    lab.setScore(ref, s.passRate);
    next.set(s.name, s);
  }

  // The rewriter appends a line; the result of benchmarking that new version is scripted here, so
  // evolving the same skill again keeps working (a second rewrite of a promoted skill is scripted too).
  let revision = 0;
  lab.rewriter = (skill, _basis, opts) => {
    const spec = next.get(skill.ref.name);
    const body = `${skill.body}\nRevision ${++revision}${opts.rewriterModel ? ` (written by ${opts.rewriterModel})` : ""}.`;
    lab.setScore({ name: skill.ref.name, digest: digestOf(body) }, spec?.nextPassRate ?? 0);
    return {
      body,
      changelog: `Revision ${revision}: ${
        (spec?.nextPassRate ?? 0) > (spec?.passRate ?? 0)
          ? "state the requirement explicitly"
          : "reword for brevity"
      }.`,
    };
  };

  const ministry = await post("/ministries", { name: "Construction", kind: "construction" });
  const soul = async (name: string, persona: string) =>
    (
      await post("/souls", {
        name,
        species: "dwarf",
        ministryId: ministry.ministryId,
        persona,
      })
    ).soul.soulId as string;
  const foreman = await soul("Oakhand", "Oakhand is careful, and reviews everything twice.");
  const worker = await soul("Birchfist", "Birchfist is quick and writes tests first.");
  await post("/warbands", {
    objective: "ship the parser fix",
    foremanSoulId: foreman,
    memberSoulIds: [worker],
  });

  for (const s of SKILLS) {
    if (!s.analyzed) continue;
    const ref = await lab.resolve(s.name);
    await post("/skills/analyze", { name: s.name, digest: ref.digest });
  }
  await post(`/souls/${worker}/skills`, { name: "tdd" });
}
