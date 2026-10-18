import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { agentLabel } from "./lab.js";
import { absorbSkill, analyzeSkill } from "./labService.js";
import { listSoulSkills } from "./queries.js";
import { makeTown, type Town } from "./testing.js";

const ranks = (t: Town) =>
  t.db.prepare("SELECT agent, suite_digest AS suite, rank FROM skill_ranks ORDER BY seq").all() as {
    agent: string;
    suite: string;
    rank: string;
  }[];

async function setup() {
  const t = makeTown();
  const ref = t.lab.addSkill("tdd", "v1");
  t.lab.setScore(ref, 0.9); // ultimate on the fake's clean 10 trials
  return { t, ref };
}

describe("skill ranks are keyed by skill digest, suite and agent", () => {
  it("one skill ranked under two models keeps both ranks instead of overwriting", async () => {
    const { t, ref } = await setup();
    t.lab.agent = { id: "omp", version: "18.5.1", model: "anthropic/claude-sonnet-5-5:high" };
    await analyzeSkill(t, ref);
    t.lab.setScore(ref, 0.5);
    t.lab.agent = { id: "omp", version: "18.5.1", model: "anthropic/claude-haiku-4-5:low" };
    await analyzeSkill(t, ref);

    expect(ranks(t)).toEqual([
      {
        agent: "omp@18.5.1 anthropic/claude-sonnet-5-5:high",
        suite: "suite:tdd:default",
        rank: "ultimate",
      },
      {
        agent: "omp@18.5.1 anthropic/claude-haiku-4-5:low",
        suite: "suite:tdd:default",
        rank: "extra",
      },
    ]);
  });

  it("effort is part of the agent, so the same model at another effort is a separate rank", async () => {
    const { t, ref } = await setup();
    for (const effort of ["low", "high"]) {
      t.lab.agent = { id: "omp", model: `anthropic/claude-sonnet-5-5:${effort}` };
      await analyzeSkill(t, ref);
    }
    expect(ranks(t).map((r) => r.agent)).toEqual([
      "omp anthropic/claude-sonnet-5-5:low",
      "omp anthropic/claude-sonnet-5-5:high",
    ]);
  });

  it("a different suite is a separate rank", async () => {
    const { t, ref } = await setup();
    await analyzeSkill(t, ref);
    t.lab.suite = "harder";
    await analyzeSkill(t, ref);
    expect(ranks(t).map((r) => r.suite)).toEqual(["suite:tdd:default", "suite:tdd:harder"]);
  });

  it("re-benchmarking under the same suite and agent replaces that rank, not adds one", async () => {
    const { t, ref } = await setup();
    await analyzeSkill(t, ref);
    t.lab.setScore(ref, 0.5);
    await analyzeSkill(t, ref);
    expect(ranks(t)).toEqual([{ agent: "fake", suite: "suite:tdd:default", rank: "extra" }]);
  });

  it("a soul's skill shows the most recent rank of its pinned digest", async () => {
    const { t, ref } = await setup();
    const soul = t.addSoul("Oak");
    await absorbSkill(t, { soulId: soul, name: "tdd" });
    await analyzeSkill(t, ref); // ultimate
    t.lab.setScore(ref, 0.5);
    t.lab.agent = { id: "fake", model: "cheap" };
    await analyzeSkill(t, ref); // extra, later
    expect(listSoulSkills(t.db, soul)[0]?.rank).toBe("extra");
  });

  it("names the agent one way: id, version and model with its effort", () => {
    expect(agentLabel({ id: "omp" })).toBe("omp");
    expect(agentLabel({ id: "omp", model: "m:high" })).toBe("omp m:high");
    expect(agentLabel({ id: "omp", version: "18.5.1", model: "m:high" })).toBe("omp@18.5.1 m:high");
  });
});

describe("migration 2 (ranks keyed by suite and agent)", () => {
  it("keeps ranks recorded before the change, with unknown suite and agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-mig-"));
    const path = join(dir, "h.db");
    try {
      // a database as the previous release left it: old table shape, user_version 1
      const old = openDb(path);
      old.exec(`DROP TABLE skill_ranks;
        CREATE TABLE skill_ranks (name TEXT NOT NULL, digest TEXT NOT NULL, rank TEXT NOT NULL, score REAL NOT NULL,
          thresholds_version TEXT NOT NULL, PRIMARY KEY (name, digest));
        INSERT INTO skill_ranks VALUES ('tdd', 'sha256:aaa', 'unique', 0.8, 'default-1');`);
      old.pragma("user_version = 1");
      old.close();

      const migrated = openDb(path);
      expect(migrated.pragma("user_version", { simple: true })).toBe(2);
      expect(
        migrated
          .prepare("SELECT name, digest, suite_digest, agent, rank, score FROM skill_ranks")
          .all(),
      ).toEqual([
        {
          name: "tdd",
          digest: "sha256:aaa",
          suite_digest: "",
          agent: "",
          rank: "unique",
          score: 0.8,
        },
      ]);
      // and the new key is in force: a second rank for the same digest under another agent coexists
      migrated
        .prepare(
          "INSERT INTO skill_ranks VALUES (1, 'tdd', 'sha256:aaa', 's', 'omp', 'extra', 0.5, 'default-2')",
        )
        .run();
      expect(
        (migrated.prepare("SELECT COUNT(*) AS c FROM skill_ranks").get() as { c: number }).c,
      ).toBe(2);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
