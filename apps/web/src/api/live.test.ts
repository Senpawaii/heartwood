import { describe, expect, it } from "vitest";
import { describeEvent, parseLiveEvent, queryKeysFor } from "./live";

const frame = (type: string, payload: object) =>
  JSON.stringify({
    seq: 1,
    id: "x",
    at: "2026-10-17T00:00:00.000Z",
    v: 1,
    type,
    actor: { kind: "daemon" },
    correlation: {},
    payload,
  });

describe("live events", () => {
  it("refreshes what an event can change, and nothing for unknown families", () => {
    expect(queryKeysFor("dispatch.settled")).toEqual(
      expect.arrayContaining(["warband", "soul", "skillUsage", "proficiency", "town"]),
    );
    expect(queryKeysFor("question.asked")).toEqual(expect.arrayContaining(["inbox", "town"]));
    expect(queryKeysFor("memory.pruned")).toEqual(expect.arrayContaining(["memory"]));
    expect(queryKeysFor("backend.incompatible")).toContain("health");
    expect(queryKeysFor("hologram.projected")).toEqual([]);
  });

  it("describes a skill evolution from proposal to verdict, with the evidence that decided it", () => {
    const pin = (d: string) => ({ name: "greeter", digest: d });
    const describe1 = (type: string, extra: object) => {
      const e = parseLiveEvent(
        frame(type, {
          name: "greeter",
          from: pin("sha256:aaaa111122223333"),
          to: pin("sha256:bbbb444455556666"),
          ...extra,
        }),
      );
      return e && describeEvent(e);
    };
    expect(describe1("skill.evolve_proposed", { changelog: "State the requirement." })).toBe(
      "greeter: new version sha256:bbbb4444 proposed: State the requirement.",
    );
    expect(describe1("skill.evolve_promoted", { comparisonRef: "grimoire:3" })).toBe(
      "greeter: sha256:bbbb4444 replaces sha256:aaaa1111",
    );
    expect(describe1("skill.evolve_rejected", { reason: "verdict same (delta 0.000)" })).toBe(
      "greeter: sha256:bbbb4444 not promoted: verdict same (delta 0.000)",
    );
  });

  it("parses known events and ignores unknown or malformed frames instead of crashing the stream", () => {
    const e = parseLiveEvent(frame("dispatch.settled", { dispatchId: "d1", outcome: "succeeded" }));
    expect(e?.type).toBe("dispatch.settled");
    expect(parseLiveEvent(frame("hologram.projected", {}))).toBeUndefined();
    expect(parseLiveEvent(frame("dispatch.settled", { dispatchId: 5 }))).toBeUndefined();
    expect(parseLiveEvent("not json")).toBeUndefined();
  });

  it("describes events in terms of names, not ids", () => {
    const names: Record<string, string> = { soul_1: "Oakhand" };
    const nameOf = (id: string) => names[id] ?? id;
    const named = parseLiveEvent(
      frame("soul.named", {
        soulId: "soul_1",
        name: "Oakhand",
        species: "dwarf",
        ministryId: "m",
        persona: "p",
        magiculesSpent: 1,
      }),
    );
    expect(named && describeEvent(named, nameOf)).toBe("Oakhand the dwarf was named");
    const xp = parseLiveEvent(
      frame("soul.xp_gained", { soulId: "soul_1", amount: 10, reason: "foreman_bonus" }),
    );
    expect(xp && describeEvent(xp, nameOf)).toBe("Oakhand +10 xp (foreman bonus)");
    const used = parseLiveEvent(
      frame("skill.used", {
        soulId: "soul_1",
        skill: { name: "tdd", digest: "d" },
        dispatchId: "x",
        outcome: "succeeded",
        evidence: "injected",
      }),
    );
    expect(used && describeEvent(used, nameOf)).toBe("Oakhand used tdd: succeeded (injected)");
    const q = parseLiveEvent(frame("question.asked", { questionId: "q", text: "which db?" }));
    expect(q && describeEvent(q, nameOf)).toBe("question: which db?");
    const spawned = parseLiveEvent(
      JSON.stringify({
        seq: 2,
        id: "y",
        at: "2026-10-17T00:00:00.000Z",
        v: 1,
        type: "body.spawned",
        actor: { kind: "daemon" },
        correlation: { soulId: "soul_1" },
        payload: {
          bodyId: "b",
          soulId: "soul_1",
          dispatchId: "d",
          workerRef: "w",
          agent: "claude",
          worktree: "new-child",
        },
      }),
    );
    expect(spawned && describeEvent(spawned, nameOf)).toBe("a body was spawned for Oakhand");
  });
});
