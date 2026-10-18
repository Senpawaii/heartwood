import { describe, expect, it } from "vitest";
import { boot, json } from "./testing.js";

async function bootWithSkill() {
  const b = await boot();
  b.lab.agent = { id: "omp", version: "1" };
  const ref = b.lab.addSkill("tdd", "Write the test first.");
  b.lab.setScore(ref, 0.4);
  b.lab.rewriter = (skill) => ({ body: `${skill.body} More.`, changelog: "More." });
  return { b, ref };
}

describe("choosing models per action", () => {
  it("analyze measures with the model named in the request, and the rank records it", async () => {
    const { b, ref } = await bootWithSkill();
    const r = await json(b.app, "POST", "/skills/analyze", {
      name: "tdd",
      digest: ref.digest,
      model: "anthropic/claude-sonnet-5-5:high",
    });
    expect(r.status).toBe(200);
    expect(r.body.evidence.agent.model).toBe("anthropic/claude-sonnet-5-5:high");
    expect(b.lab.calls).toEqual([{ op: "analyze", model: "anthropic/claude-sonnet-5-5:high" }]);
    const ranks = (await json(b.app, "GET", "/skills/ranks")).body.ranks;
    expect(ranks[0].agent).toBe("omp@1 anthropic/claude-sonnet-5-5:high");
  });

  it("the same skill measured with two models gives two rank rows, not one overwritten", async () => {
    const { b, ref } = await bootWithSkill();
    for (const model of ["a/one:low", "a/two:high"])
      await json(b.app, "POST", "/skills/analyze", { name: "tdd", digest: ref.digest, model });
    const agents = (await json(b.app, "GET", "/skills/ranks")).body.ranks.map(
      (r: { agent: string }) => r.agent,
    );
    expect(agents.sort()).toEqual(["omp@1 a/one:low", "omp@1 a/two:high"]);
  });

  it("evolve measures with `model` and writes with `rewriterModel`, independently", async () => {
    const { b, ref } = await bootWithSkill();
    const r = await json(b.app, "POST", "/skills/evolve", {
      name: "tdd",
      digest: ref.digest,
      model: "a/bench:low",
      rewriterModel: "b/writer:max",
    });
    expect(r.status).toBe(200);
    const proposals = b.lab.calls.filter((c) => c.op === "proposeVersion");
    expect(proposals).toEqual([{ op: "proposeVersion", rewriterModel: "b/writer:max" }]);
    const benches = b.lab.calls.filter((c) => c.op === "analyze");
    expect(benches.length).toBeGreaterThan(0);
    expect(new Set(benches.map((c) => c.model))).toEqual(new Set(["a/bench:low"]));
  });

  it("naming no model leaves the choice to the server's settings", async () => {
    const { b, ref } = await bootWithSkill();
    await json(b.app, "POST", "/skills/evolve", { name: "tdd", digest: ref.digest });
    expect(b.lab.calls.every((c) => c.model === undefined && c.rewriterModel === undefined)).toBe(
      true,
    );
  });

  it("refuses a model id that is not plain provider/model syntax, before anything runs", async () => {
    const { b, ref } = await bootWithSkill();
    for (const model of ["x; rm -rf /", "a b", "--thinking", "$(id)", "", "a".repeat(201)]) {
      const analyze = await json(b.app, "POST", "/skills/analyze", {
        name: "tdd",
        digest: ref.digest,
        model,
      });
      expect(analyze.status, `analyze ${model}`).toBe(400);
      const evolve = await json(b.app, "POST", "/skills/evolve", {
        name: "tdd",
        digest: ref.digest,
        rewriterModel: model,
      });
      expect(evolve.status, `evolve ${model}`).toBe(400);
    }
    expect(b.lab.calls).toEqual([]);
  });
});
