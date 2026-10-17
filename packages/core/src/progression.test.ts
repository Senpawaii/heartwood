import { describe, expect, it } from "vitest";
import { awakenSoul, evolveSoul, grantXp } from "./progression.js";
import { getSoul } from "./queries.js";
import { makeTown } from "./testing.js";
import { dispatchSettled } from "./testing-helpers.js";

describe("progression", () => {
  it("emits leveled and ranked only when thresholds are crossed; rank is derived", () => {
    const t = makeTown();
    const s = t.addSoul("Oak");
    expect(grantXp(t.ctx, { soulId: s, amount: 5, reason: "other" }).map((e) => e.type)).toEqual([
      "soul.xp_gained",
    ]);
    expect(grantXp(t.ctx, { soulId: s, amount: 15, reason: "other" }).map((e) => e.type)).toEqual([
      "soul.xp_gained",
      "soul.leveled",
    ]);
    // 20 -> 100 xp: level 3 -> journeyman crosses a rank threshold
    const crossed = grantXp(t.ctx, { soulId: s, amount: 80, reason: "other" });
    expect(crossed.map((e) => e.type)).toEqual(["soul.xp_gained", "soul.leveled", "soul.ranked"]);
    const soul = getSoul(t.db, s, t.rules);
    expect(soul).toMatchObject({ level: 4, rank: "journeyman", xp: 100 });
    expect(
      t.db
        .prepare("PRAGMA table_info(souls)")
        .all()
        .map((c) => (c as { name: string }).name),
    ).not.toContain("rank");
  });

  it("gates species evolution on level", () => {
    const t = makeTown();
    const s = t.addSoul("Oak");
    expect(() => evolveSoul(t.ctx, s)).toThrow(/needs level 5/);
    grantXp(t.ctx, { soulId: s, amount: 180, reason: "other" });
    evolveSoul(t.ctx, s);
    expect(getSoul(t.db, s, t.rules)?.form).toBe("deepsmith");
    expect(() => evolveSoul(t.ctx, s)).toThrow(/already evolved/);
  });

  it("awakening requires real proof of the right kind", async () => {
    const t = makeTown();
    const s = t.addSoul("Oak");
    expect(() =>
      awakenSoul(t.ctx, {
        soulId: s,
        title: "Guildmaster",
        proof: { kind: "benchmark", ref: "nope" },
      }),
    ).toThrow(/not found/);
    const named = t.log.read({ types: ["soul.named"] })[0];
    expect(() =>
      awakenSoul(t.ctx, {
        soulId: s,
        title: "Guildmaster",
        proof: { kind: "project", ref: named?.id ?? "" },
      }),
    ).toThrow(/not valid project proof/);
    const settled = await dispatchSettled(t, s, "succeeded");
    awakenSoul(t.ctx, {
      soulId: s,
      title: "Guildmaster",
      proof: { kind: "project", ref: settled },
    });
    expect(getSoul(t.db, s, t.rules)?.titles).toEqual(["Guildmaster"]);
  });
});
