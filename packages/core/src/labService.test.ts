import { describe, expect, it } from "vitest";
import { DigestMismatchError, LabUnavailableError } from "./lab.js";
import { absorbSkill, analyzeSkill, evolveSkill } from "./labService.js";
import { makeTown } from "./testing.js";

const rankOf = (t: ReturnType<typeof makeTown>, name: string, digest: string) =>
  (
    t.db.prepare("SELECT rank FROM skill_ranks WHERE name = ? AND digest = ?").get(name, digest) as
      | { rank: string }
      | undefined
  )?.rank;

describe("Lab service", () => {
  it("absorb pins the soul to the resolved digest", async () => {
    const t = makeTown();
    const s = t.addSoul("Oak");
    const ref = t.lab.addSkill("tdd", "v1");
    const pin = await absorbSkill(t, { soulId: s, name: "tdd" });
    expect(pin).toEqual({ name: "tdd", digest: ref.digest });
    t.lab.addSkill("tdd", "v2"); // catalog moves on; the soul stays pinned
    const row = t.db.prepare("SELECT digest FROM soul_skills WHERE soul_id = ?").get(s) as {
      digest: string;
    };
    expect(row.digest).toBe(ref.digest);
    await expect(absorbSkill(t, { soulId: s, name: "missing" })).rejects.toThrow(/not found/);
  });

  it("refuses to load content that no longer matches its digest", async () => {
    const t = makeTown();
    const ref = t.lab.addSkill("tdd", "v1");
    t.lab.corrupt(ref, "tampered");
    await expect(t.lab.load(ref)).rejects.toBeInstanceOf(DigestMismatchError);
  });

  it("analyze derives rank from Heartwood-owned thresholds", async () => {
    const t = makeTown();
    const ref = t.lab.addSkill("tdd", "v1");
    t.lab.setScore(ref, 0.8);
    await analyzeSkill(t, ref);
    expect(rankOf(t, "tdd", ref.digest)).toBe("unique");
  });

  it("promotes an evolved version only when the comparison says better", async () => {
    const t = makeTown();
    const v1 = t.lab.addSkill("tdd", "v1");
    t.lab.setScore(v1, 0.4);
    let n = 0;
    t.lab.rewriter = () => ({ body: `v${++n + 1}`, changelog: "tweak" });
    // candidate digest is unknown until proposed: pre-compute v2 digest
    const { digestOf } = await import("./fakeLab.js");
    t.lab.setScore({ name: "tdd", digest: digestOf("v2") }, 0.9);
    const win = await evolveSkill(t, v1);
    expect(win.promoted).toBe(true);
    expect(t.log.read({ types: ["skill.evolve_promoted"] })).toHaveLength(1);
    expect(rankOf(t, "tdd", win.candidate.digest)).toBe("ultimate");

    // a worse v3 is rejected
    t.lab.setScore({ name: "tdd", digest: digestOf("v3") }, 0.1);
    const lose = await evolveSkill(t, win.candidate);
    expect(lose.promoted).toBe(false);
    expect(t.log.read({ types: ["skill.evolve_rejected"] })).toHaveLength(1);
    expect(t.log.read({ types: ["skill.evolve_promoted"] })).toHaveLength(1);
  });

  it("surfaces an explicit error when the Lab cannot propose versions", async () => {
    const t = makeTown();
    const v1 = t.lab.addSkill("tdd", "v1");
    await expect(evolveSkill(t, v1)).rejects.toBeInstanceOf(LabUnavailableError);
    expect(t.log.read({ types: ["skill.evolve_proposed"] })).toEqual([]);
  });
});
