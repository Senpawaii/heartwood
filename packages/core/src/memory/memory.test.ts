import { describe, expect, it } from "vitest";
import { makeTown } from "../testing.js";
import { markdownEdits, renderSoulMarkdown } from "./markdown.js";
import { runReflection } from "./reflection.js";
import { getMemory, listMemories, retrieveMemories, toFtsQuery } from "./store.js";

function write(
  t: ReturnType<typeof makeTown>,
  id: string,
  soul: string,
  text: string,
  layer: "episodic" | "persona" = "episodic",
) {
  t.log.append([
    {
      type: layer === "persona" ? "memory.persona_set" : "memory.episodic_written",
      payload: {
        memory: {
          memoryId: id,
          layer,
          ownerSoulId: soul,
          text,
          tags: [],
          provenance: { author: "human", source: "test" },
        },
      },
      actor: { kind: "daemon" },
    },
  ]);
}

describe("memory retrieval", () => {
  it("ranks by relevance, excludes pruned, persona and other souls' private memories", () => {
    const t = makeTown();
    const a = t.addSoul("Oak");
    const b = t.addSoul("Elm");
    write(t, "m1", a, "deploy pipeline fails when the cache is cold");
    write(t, "m2", a, "cache cold start deploy deploy deploy");
    write(t, "m3", b, "deploy secrets of elm");
    write(t, "m4", a, "deploy persona text", "persona");
    write(t, "m5", a, "deploy lesson to be pruned");
    t.log.append([
      {
        type: "memory.pruned",
        payload: { memoryId: "m5", reason: "wrong" },
        actor: { kind: "warden" },
      },
    ]);
    const ids = retrieveMemories(t.db, { soulId: a, query: "deploy cache", k: 10 }).map(
      (r) => r.memory.memoryId,
    );
    expect(ids).toContain("m1");
    expect(ids).toContain("m2");
    expect(ids).not.toContain("m3");
    expect(ids).not.toContain("m4");
    expect(ids).not.toContain("m5");
    expect(getMemory(t.db, "m5")?.prunedAt).not.toBeNull();
  });

  it("is safe against FTS syntax in the query", () => {
    const t = makeTown();
    const a = t.addSoul("Oak");
    write(t, "m1", a, "weird input handled");
    expect(() =>
      retrieveMemories(t.db, { soulId: a, query: 'AND OR "unterminated (*) NEAR', k: 3 }),
    ).not.toThrow();
    expect(toFtsQuery("!!!")).toBeUndefined();
    expect(retrieveMemories(t.db, { soulId: a, query: "!!!", k: 3 })).toEqual([]);
  });

  it("finds an edited memory by its new text only", () => {
    const t = makeTown();
    const a = t.addSoul("Oak");
    write(t, "m1", a, "alpha content");
    t.log.append([
      {
        type: "memory.edited",
        payload: { memoryId: "m1", text: "bravo content" },
        actor: { kind: "sovereign" },
      },
    ]);
    expect(retrieveMemories(t.db, { soulId: a, query: "alpha", k: 3 })).toEqual([]);
    expect(retrieveMemories(t.db, { soulId: a, query: "bravo", k: 3 })).toHaveLength(1);
  });
});

describe("markdown view", () => {
  it("renders memories and turns edits and deletions into events", () => {
    const t = makeTown();
    const a = t.addSoul("Oak");
    write(t, "m1", a, "first lesson");
    write(t, "m2", a, "second lesson\nwith two lines");
    write(t, "m3", a, "third lesson");
    const md = renderSoulMarkdown(t.db, a, "Oak");
    expect(md).toContain("<!-- memory:m1 -->");
    expect(markdownEdits(t.db, a, md)).toEqual([]);

    const edited = md
      .replace("first lesson", "first lesson, corrected")
      .replace(/<!-- memory:m3 -->\nthird lesson\n?/, "");
    const events = markdownEdits(t.db, a, edited);
    expect(
      events.map((e) =>
        e.type === "memory.edited" || e.type === "memory.pruned"
          ? [e.type, e.payload.memoryId]
          : [e.type],
      ),
    ).toEqual([
      ["memory.edited", "m1"],
      ["memory.pruned", "m3"],
    ]);
    t.log.append(events);
    expect(listMemories(t.db, { soulId: a, layers: ["episodic"] }).map((m) => m.text)).toEqual([
      "first lesson, corrected",
      "second lesson\nwith two lines",
    ]);
  });
});

describe("reflection", () => {
  it("distils undistilled episodes into semantic memories once", async () => {
    const t = makeTown();
    const a = t.addSoul("Oak");
    write(t, "e1", a, "tests flaked on windows paths");
    write(t, "e2", a, "unrelated one-off");
    let calls = 0;
    const reflect = async (_s: string, eps: { memoryId: string }[]) => {
      calls++;
      return [
        {
          text: "Normalize path separators in tests",
          tags: ["windows"],
          sourceMemoryIds: [eps[0]?.memoryId ?? "", "not-an-episode"],
        },
      ];
    };
    const out = await runReflection(t.log, t.db, a, reflect);
    expect(out).toHaveLength(1);
    const semantic = listMemories(t.db, { soulId: a, layers: ["semantic"] });
    expect(semantic[0]?.provenance.author).toBe("reflection");
    expect(getMemory(t.db, "e1")?.distilledAt).not.toBeNull();
    expect(getMemory(t.db, "e2")?.distilledAt).toBeNull();
    const distilled = out[0];
    expect(
      distilled?.type === "memory.semantic_distilled"
        ? distilled.payload.sourceMemoryIds
        : undefined,
    ).toEqual(["e1"]);
    // second pass only offers the remaining episode
    await runReflection(t.log, t.db, a, async (_s, eps) => {
      expect(eps.map((e) => e.memoryId)).toEqual(["e2"]);
      return [];
    });
    expect(calls).toBe(1);
  });

  it("does nothing when there are too few episodes", async () => {
    const t = makeTown();
    const a = t.addSoul("Oak");
    expect(
      await runReflection(t.log, t.db, a, async () => [{ text: "x", sourceMemoryIds: [] }], {
        minEpisodes: 1,
      }),
    ).toEqual([]);
  });
});
