import { describe, expect, it } from "vitest";
import { rebuildProjections } from "./projections.js";
import { listSouls } from "./queries.js";
import { makeTown } from "./testing.js";

const named = (id: string) => ({
  type: "soul.named" as const,
  payload: {
    soulId: id,
    name: id,
    species: "elf" as const,
    ministryId: "m",
    persona: "p",
    magiculesSpent: 0,
  },
  actor: { kind: "sovereign" as const },
});

describe("event log", () => {
  it("rolls back the whole batch when one event is invalid", () => {
    const t = makeTown();
    expect(() =>
      t.log.append([
        named("a"),
        { type: "soul.leveled", payload: { soulId: "a" } as never, actor: { kind: "daemon" } },
      ]),
    ).toThrow();
    expect(t.log.lastSeq()).toBe(0);
    expect(listSouls(t.db)).toEqual([]);
  });

  it("skips events whose (type, orcaMessageId) was already appended", () => {
    const t = makeTown();
    const q = {
      type: "question.asked" as const,
      payload: { questionId: "q", text: "?", orcaMessageId: "m1" },
      actor: { kind: "orca" as const },
    };
    expect(t.log.append([q])).toHaveLength(1);
    expect(t.log.append([q])).toHaveLength(0);
    expect(t.log.read({ types: ["question.asked"] })).toHaveLength(1);
  });

  it("notifies subscribers only after commit, and not for rolled-back events", () => {
    const t = makeTown();
    const seen: string[] = [];
    t.log.subscribe((e) => seen.push(e.type));
    expect(() =>
      t.log.transaction(() => {
        t.log.append([named("a")]);
        expect(seen).toEqual([]);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(seen).toEqual([]);
    t.log.transaction(() => t.log.append([named("b")]));
    expect(seen).toEqual(["soul.named"]);
  });

  it("reads after a seq and filters by type", () => {
    const t = makeTown();
    t.log.append([named("a"), named("b")]);
    const [first] = t.log.read();
    expect(t.log.read({ afterSeq: first?.seq }).map((e) => e.seq)).toEqual([2]);
    expect(t.log.read({ types: ["town.founded"] })).toEqual([]);
  });

  it("rebuilding projections from the log reproduces the read models", async () => {
    const t = makeTown();
    const a = t.addSoul("Oak");
    const b = t.addSoul("Elm");
    const { warbandId } = t.formWarband(a, [b]);
    const d = await t.dispatch(warbandId, b, "w1");
    const { settleDispatch } = await import("./dispatch.js");
    settleDispatch(t.ctx, { dispatchId: d.dispatchId, outcome: "succeeded", summary: "done" });
    const before = JSON.stringify([
      listSouls(t.db),
      t.db.prepare("SELECT * FROM memories").all(),
      t.db.prepare("SELECT * FROM xp_ledger").all(),
    ]);
    rebuildProjections(t.db, t.log.read(), t.rules);
    const after = JSON.stringify([
      listSouls(t.db),
      t.db.prepare("SELECT * FROM memories").all(),
      t.db.prepare("SELECT * FROM xp_ledger").all(),
    ]);
    expect(after).toBe(before);
  });
});
