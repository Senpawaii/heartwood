import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentAdapter,
  dirSource,
  ResultStore,
  type RunRequest,
  type RunResult,
  type Skill,
  type SkillRewriter,
  type Workspace,
} from "@grimoire/core";
import {
  absorbSkill,
  analyzeSkill,
  DigestMismatchError,
  DomainError,
  defaultRules,
  deriveSkillRank,
  evolveSkill,
  type LabCtx,
  LabUnavailableError,
  NotFoundError,
  openDb,
  type Rules,
  SqliteEventLog,
} from "@heartwood/core";
import { afterEach, describe, expect, it } from "vitest";
import { GrimoireLab } from "./lab.js";
import { SkillStore } from "./store.js";

const SUITE = `suite: tdd-basic
defaults: { repeat: 10, timeoutMs: 10000 }
tasks:
  - id: write-file
    prompt: "Create out.txt"
    assertions:
      - { type: file_exists, path: out.txt }
`;

const skillMd = (body: string, version = "1.0.0") =>
  `---\nname: tdd\ndescription: Write the test first.\nversion: ${version}\n---\n${body}\n`;

/**
 * A deterministic stand-in for an agent: it "creates out.txt" only if the skill it was given
 * contains the marker WRITE_OUT. So a skill with the marker beats no skill, and one without
 * does not. Everything else (workspaces, trials, assertions, scoring, comparison) is the real library.
 */
class MarkerAgent implements AgentAdapter {
  readonly id = "marker-agent";
  private ready = new Set<string>();
  trials = 0;
  async detect() {
    return { available: true, version: "1" };
  }
  async install(skill: Skill, ws: Workspace) {
    if ((await readFile(join(skill.dir, "SKILL.md"), "utf8")).includes("WRITE_OUT"))
      this.ready.add(ws.dir);
  }
  async run(_req: RunRequest, ws: Workspace): Promise<RunResult> {
    this.trials++;
    if (this.ready.has(ws.dir)) await writeFile(join(ws.dir, "out.txt"), "ok");
    return {
      status: "completed",
      transcript: [],
      finalMessage: "done",
      durationMs: 1,
      rawOutput: "",
    };
  }
}

function rankOf(ctx: LabCtx, digest: string): string | undefined {
  const row = ctx.db.prepare("SELECT rank FROM skill_ranks WHERE digest = ?").get(digest) as
    | { rank: string }
    | undefined;
  return row?.rank;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

/** Real trials create real workspaces, which is slow on CI disks: the evolve tests use a small sample and a gate sized to it. */
const SMALL: Rules = {
  ...defaultRules,
  skillRank: { ...defaultRules.skillRank, minTrials: 4 },
  promotion: { minTrials: 4, tolerance: 0.15 },
};

async function world(
  o: {
    agent?: AgentAdapter | null;
    rewriter?: SkillRewriter;
    body?: string;
    repeat?: number;
    rules?: Rules;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "heartwood-lab-"));
  const skills = join(root, "skills");
  const dir = join(skills, "tdd");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd(o.body ?? "Write the failing test first."));
  await writeFile(join(dir, "grimoire.bench.yaml"), SUITE);
  const store = new SkillStore(join(root, "store"));
  const results = new ResultStore(join(root, "results.db"));
  const agent = o.agent === null ? undefined : (o.agent ?? new MarkerAgent());
  const lab = new GrimoireLab({
    sources: [dirSource(skills)],
    store,
    results,
    outDir: join(root, "runs"),
    agent,
    rewriter: o.rewriter,
    repeat: o.repeat ?? 10,
  });
  const db = openDb();
  const ctx: LabCtx = { db, log: new SqliteEventLog(db), rules: o.rules ?? defaultRules, lab };
  cleanup.push(async () => {
    await lab.close();
    results.close();
    db.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, dir, lab, store, results, ctx, agent };
}

describe("GrimoireLab: catalog, pinning, rendering (no agent needed)", () => {
  it("lists and resolves skills from the catalog with their digest identity", async () => {
    const w = await world({ agent: null });
    const [tdd] = await w.lab.listSkills();
    expect(tdd).toMatchObject({
      name: "tdd",
      description: "Write the test first.",
      version: "1.0.0",
    });
    expect(tdd?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await w.lab.resolve("tdd")).toMatchObject({ digest: tdd?.digest });
    expect(await w.lab.resolve("tdd@1.0.0")).toMatchObject({ digest: tdd?.digest });
    await expect(w.lab.resolve("nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a pin stays loadable from Heartwood's own store after the catalog moves on", async () => {
    const w = await world({ agent: null });
    const old = await w.lab.resolve("tdd");
    await absorbSkill(w.ctx, { soulId: "s1", name: "tdd" });
    // the catalog edits the skill in place: new digest, and the old content is gone from the directory
    await writeFile(join(w.dir, "SKILL.md"), skillMd("Rewritten instructions.", "1.1.0"));
    const fresh = await w.lab.resolve("tdd");
    expect(fresh.digest).not.toBe(old.digest);
    expect((await w.lab.load({ name: "tdd", digest: old.digest })).body).toBe(
      "Write the failing test first.",
    );
    expect(await w.lab.verifyPin({ name: "tdd", digest: old.digest })).toBe(true);
    expect((await w.lab.load(fresh)).body).toBe("Rewritten instructions.");
  });

  it("refuses content whose digest no longer matches, and reports unknown pins", async () => {
    const w = await world({ agent: null });
    const ref = await w.lab.resolve("tdd");
    await w.lab.pin(ref);
    await writeFile(join(w.dir, "SKILL.md"), skillMd("changed")); // drop the catalog copy of that digest
    const hex = ref.digest.replace("sha256:", "");
    await writeFile(join(w.store.root, "tdd", hex, "SKILL.md"), skillMd("tampered in the store"));
    await expect(w.lab.load(ref)).rejects.toBeInstanceOf(DigestMismatchError);
    expect(await w.lab.verifyPin({ name: "tdd", digest: "sha256:" + "0".repeat(64) })).toBe(false);
    await expect(
      w.lab.load({ name: "tdd", digest: "sha256:" + "0".repeat(64) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("renders the skill for a task spec, and says when bundled files are not available", async () => {
    const w = await world({ agent: null });
    const ref = await w.lab.resolve("tdd");
    expect(await w.lab.renderForTask([])).toBe("");
    const plain = await w.lab.renderForTask([ref]);
    expect(plain).toContain(`### Skill: tdd v1.0.0 (${ref.digest})`);
    expect(plain).toContain("Write the failing test first.");
    expect(plain).not.toContain("bundles");
    await mkdir(join(w.dir, "scripts"));
    await writeFile(join(w.dir, "scripts", "run.sh"), "echo hi");
    const withScripts = await w.lab.renderForTask([await w.lab.resolve("tdd")]);
    expect(withScripts).toContain("also bundles scripts");
  });

  it("benchmark operations fail loudly without an agent, never with fake numbers", async () => {
    const w = await world({ agent: null });
    const ref = await w.lab.resolve("tdd");
    await expect(w.lab.analyze(ref)).rejects.toBeInstanceOf(LabUnavailableError);
    await expect(w.lab.analyze(ref)).rejects.toThrow(/AgentAdapter/);
    await expect(analyzeSkill(w.ctx, ref)).rejects.toBeInstanceOf(LabUnavailableError);
    expect(w.ctx.log.read({ types: ["skill.analyzed"] })).toEqual([]);
  });
});

describe("GrimoireLab: benchmarks with the real library", () => {
  it("analyze measures a skill against no skill and Heartwood derives its rank from the evidence", async () => {
    const w = await world({ body: "WRITE_OUT then done." });
    const ref = await w.lab.resolve("tdd");
    const a = await analyzeSkill(w.ctx, ref);
    expect(a.evidence).toMatchObject({ trials: 10, passes: 10, errors: 0, passRate: 1 });
    expect(a.evidence.vsBaseline?.delta).toBe(1); // the no-skill arm never passes
    expect(a.evidence.resultRef).toMatch(/^grimoire:\d+$/);
    expect(a.rank).toBe("ultimate");
    expect(deriveSkillRank(a.evidence)).toBe("ultimate");
    // the full result is persisted and addressable
    expect(w.results.getResult(a.evidence.resultRef.replace("grimoire:", ""))?.suite.name).toBe(
      "tdd-basic",
    );
    expect(w.ctx.log.read({ types: ["skill.ranked"] })).toHaveLength(1);
  });

  it("a skill that does not help ranks low, because lift over no skill is what counts", async () => {
    const w = await world({ body: "Do nothing useful." });
    const a = await analyzeSkill(w.ctx, await w.lab.resolve("tdd"));
    expect(a.evidence).toMatchObject({ passes: 0, passRate: 0 });
    expect(a.rank).toBe("common");
  });

  it("a skill with no benchmark suite is a clear error", async () => {
    const w = await world();
    await rm(join(w.dir, "grimoire.bench.yaml"));
    await expect(w.lab.analyze(await w.lab.resolve("tdd"))).rejects.toBeInstanceOf(DomainError);
  });
});

describe("GrimoireLab: evolving a skill end to end", { timeout: 60_000 }, () => {
  const improve: SkillRewriter = async (_skill, _basis, outDir) => {
    await writeFile(join(outDir, "SKILL.md"), skillMd("WRITE_OUT then done.", "1.1.0"));
    return { changelog: "Teach the agent to write the file." };
  };
  const cosmetic: SkillRewriter = async (_skill, _basis, outDir) => {
    await writeFile(
      join(outDir, "SKILL.md"),
      skillMd("Write the failing test first, thoughtfully.", "1.0.1"),
    );
    return { changelog: "Reworded." };
  };

  it("promotes a candidate that measurably beats the current version, and keeps the old pin loadable", async () => {
    const w = await world({ rewriter: improve, repeat: 4, rules: SMALL });
    const v1 = await w.lab.resolve("tdd");
    const out = await evolveSkill(w.ctx, v1);

    expect(out.promoted).toBe(true);
    expect(out.comparison).toMatchObject({ significant: true, verdict: "better", delta: 1 });
    expect(out.comparison.n).toMatchObject({ candidate: 4, baseline: 4 });
    expect(out.candidate.digest).not.toBe(v1.digest);

    // the new version is now what the Lab resolves, and it carried the suite along
    const current = await w.lab.resolve("tdd");
    expect(current.digest).toBe(out.candidate.digest);
    expect(current.version).toBe("1.1.0");
    expect(
      await readFile(
        join(w.store.root, "tdd", current.digest.replace("sha256:", ""), "grimoire.bench.yaml"),
        "utf8",
      ),
    ).toBe(SUITE);
    // a soul pinned to v1 is unaffected
    expect((await w.lab.load({ name: "tdd", digest: v1.digest })).body).toBe(
      "Write the failing test first.",
    );
    // and the candidate was ranked from the same run (it beat no-skill too)
    expect(w.ctx.log.read({ types: ["skill.evolve_promoted"] })).toHaveLength(1);
    expect(rankOf(w.ctx, out.candidate.digest)).toBe("ultimate");
    // the promoted skill is benchmarkable on its own afterwards
    expect((await analyzeSkill(w.ctx, current)).evidence.passRate).toBe(1);
  });

  it("rejects a candidate that changes nothing measurable, and leaves the current version alone", async () => {
    const w = await world({ rewriter: cosmetic, repeat: 4, rules: SMALL });
    const v1 = await w.lab.resolve("tdd");
    const out = await evolveSkill(w.ctx, v1);
    expect(out.promoted).toBe(false);
    expect(out.comparison).toMatchObject({ delta: 0, verdict: "same" });
    expect((await w.lab.resolve("tdd")).digest).toBe(v1.digest);
    expect(w.ctx.log.read({ types: ["skill.evolve_rejected"] })).toHaveLength(1);
    expect(w.ctx.log.read({ types: ["skill.evolve_promoted"] })).toEqual([]);
  });

  it("without a rewriter there is no proposal at all", async () => {
    const w = await world();
    await expect(evolveSkill(w.ctx, await w.lab.resolve("tdd"))).rejects.toBeInstanceOf(
      LabUnavailableError,
    );
    expect(w.ctx.log.read({ types: ["skill.evolve_proposed"] })).toEqual([]);
  });

  it("a rewriter that changes nothing yields no proposal", async () => {
    const w = await world({ rewriter: async () => ({ changelog: "meh" }) });
    await expect(evolveSkill(w.ctx, await w.lab.resolve("tdd"))).rejects.toBeInstanceOf(
      DomainError,
    );
    expect(w.ctx.log.read({ types: ["skill.evolve_proposed"] })).toEqual([]);
  });
});
