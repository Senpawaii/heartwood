import { FakeBackend, openDb } from "@heartwood/core";
import { describe, expect, it } from "vitest";
import { createDaemon } from "./daemon.js";
import { DemoLab, seedDemo } from "./demoData.js";
import { json } from "./testing.js";

async function demo() {
  const lab = new DemoLab(); // no delay: the tests must not wait on real timers
  const daemon = await createDaemon({
    db: openDb(),
    backend: new FakeBackend(),
    lab,
    demo: true,
  });
  await seedDemo(daemon.app, lab);
  const app = daemon.app;
  const digestOf = async (name: string) =>
    ((await json(app, "GET", "/skills")).body.skills as { name: string; digest: string }[]).find(
      (s) => s.name === name,
    )?.digest as string;
  const evolve = async (name: string, extra: object = {}) =>
    (await json(app, "POST", "/skills/evolve", { name, digest: await digestOf(name), ...extra }))
      .body;
  return { app, lab, digestOf, evolve };
}

describe("demo data", () => {
  it("announces itself, so the UI can say nothing is real", async () => {
    const { app } = await demo();
    expect((await json(app, "GET", "/health")).body.demo).toBe(true);
  });

  it("starts with a town, four skills, and ranks for three of them", async () => {
    const { app } = await demo();
    expect((await json(app, "GET", "/souls")).body.souls.length).toBeGreaterThanOrEqual(2);
    const names = (await json(app, "GET", "/skills")).body.skills.map(
      (s: { name: string }) => s.name,
    );
    expect(names.sort()).toEqual(["code-review", "greeter", "release-notes", "tdd"]);
    const ranked = (await json(app, "GET", "/skills/ranks")).body.ranks.map(
      (r: { name: string }) => r.name,
    );
    expect(ranked.sort()).toEqual(["code-review", "greeter", "tdd"]);
  });

  it("every Evolve outcome the UI can show actually happens", async () => {
    const { evolve } = await demo();
    expect(await evolve("greeter")).toMatchObject({
      promoted: true,
      comparison: { verdict: "better" },
    });
    expect(await evolve("tdd")).toMatchObject({ promoted: false, comparison: { verdict: "same" } });
    expect(await evolve("code-review")).toMatchObject({
      promoted: false,
      comparison: { verdict: "worse" },
    });
  });

  it("a promoted skill can be evolved again, and the catalog shows its new version", async () => {
    const { app, evolve, digestOf } = await demo();
    const before = await digestOf("greeter");
    await evolve("greeter");
    expect(await digestOf("greeter")).not.toBe(before);
    const again = await evolve("greeter");
    expect(again.promoted).toBe(false); // already at the scripted best
    expect((await json(app, "GET", "/skills")).body.skills).toHaveLength(4);
  });

  it("the skill nobody has benchmarked yet can be analyzed and then evolved", async () => {
    const { app, evolve, digestOf } = await demo();
    const analyzed = await json(app, "POST", "/skills/analyze", {
      name: "release-notes",
      digest: await digestOf("release-notes"),
    });
    expect(analyzed.status).toBe(200);
    expect((await evolve("release-notes")).promoted).toBe(true);
  });

  it("measures with the model the request names, and records it on the rank", async () => {
    const { app, digestOf } = await demo();
    await json(app, "POST", "/skills/analyze", {
      name: "tdd",
      digest: await digestOf("tdd"),
      model: "anthropic/claude-haiku-4-5:low",
    });
    const agents = (await json(app, "GET", "/skills/ranks")).body.ranks.map(
      (r: { agent: string }) => r.agent,
    );
    expect(agents).toContain("omp@demo anthropic/claude-haiku-4-5:low");
    expect(agents).toContain("omp@demo demo-model"); // the seeded measurement is a separate fact
  });
});
