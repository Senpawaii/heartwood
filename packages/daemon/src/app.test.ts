import { type FakeBackend, UnavailableLab, WorkerStartError } from "@heartwood/core";
import { describe, expect, it } from "vitest";
import {
  type Booted,
  boot,
  brief,
  dispatchStates,
  doneMsg,
  formWarband,
  json,
  payloads,
  seedTown,
  until,
} from "./testing.js";

const dispatchBody = (soulId: string, extra: object = {}) => ({ soulId, brief, ...extra });

describe("health, auth and validation", () => {
  it("founds the town once and reports backend state", async () => {
    const b = await boot();
    const h = await json(b.app, "GET", "/health");
    expect(h.body).toMatchObject({
      ok: true,
      backend: { status: "ready", info: { name: "fake" } },
    });
    const again = await boot({ db: b.db });
    expect(b.daemon.ctx.log.read({ types: ["town.founded"] })).toHaveLength(1);
    await again.daemon.close();
  });

  it("requires the token everywhere except /health, via header or query", async () => {
    const b = await boot({ token: "s3cret-token-value-1234" });
    expect((await json(b.app, "GET", "/souls")).status).toBe(401);
    expect(
      (
        await json(b.app, "GET", "/souls", undefined, {
          authorization: "Bearer wrong-token-value-12345",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await json(b.app, "GET", "/souls", undefined, {
          authorization: "Bearer s3cret-token-value-1234",
        })
      ).status,
    ).toBe(200);
    expect((await json(b.app, "GET", "/souls?token=s3cret-token-value-1234")).status).toBe(200);
    expect((await json(b.app, "GET", "/health")).status).toBe(200);
  });

  it("rejects malformed bodies with 400 and unknown entities with 404", async () => {
    const b = await boot();
    const bad = await json(b.app, "POST", "/souls", { name: "", species: "goblin" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_request");
    expect(
      (
        await json(b.app, "POST", "/souls", {
          name: "X",
          species: "dwarf",
          ministryId: "nope",
          persona: "p",
        })
      ).status,
    ).toBe(404);
    expect((await json(b.app, "GET", "/souls/nope")).status).toBe(404);
    expect((await json(b.app, "GET", "/warbands/nope")).status).toBe(404);
  });
});

describe("souls", () => {
  it("naming creates a character with its persona as stable memory, and rank is derived", async () => {
    const b = await boot();
    const t = await seedTown(b);
    const r = await json(b.app, "GET", `/souls/${t.foreman}`);
    expect(r.body.soul).toMatchObject({
      name: "Oakhand",
      species: "dwarf",
      level: 1,
      rank: "apprentice",
      xp: 0,
    });
    const mem = await json(b.app, "GET", `/souls/${t.foreman}/memory`);
    expect(mem.body.persona).toContain("careful and precise");
    expect(mem.body.memories.map((m: { layer: string }) => m.layer)).toEqual(["persona"]);
  });

  it("evolution and awakening are gated with 409", async () => {
    const b = await boot();
    const t = await seedTown(b);
    const ev = await json(b.app, "POST", `/souls/${t.foreman}/evolve`);
    expect(ev.status).toBe(409);
    expect(ev.body.message).toMatch(/needs level/);
    const aw = await json(b.app, "POST", `/souls/${t.foreman}/awaken`, {
      title: "Guildmaster",
      proof: { kind: "project", ref: "missing" },
    });
    expect(aw.status).toBe(404);
  });

  it("serves an editable Markdown view; edits and removals become events", async () => {
    const b = await boot();
    const t = await seedTown(b);
    const md = (await json(b.app, "GET", `/souls/${t.foreman}/memory.md`)).body as string;
    expect(md).toContain("Oakhand — memory");
    expect(md).toContain("careful and precise");
    const edited = md.replace("careful and precise", "careful, precise and patient");
    const res = await b.app.inject({
      method: "PUT",
      url: `/souls/${t.foreman}/memory.md`,
      payload: edited,
      headers: { "content-type": "text/plain" },
    });
    expect(res.json()).toEqual({ edited: 1, pruned: 0 });
    const mem = await json(b.app, "GET", `/souls/${t.foreman}/memory`);
    expect(mem.body.persona).toContain("patient");
  });

  it("the Warden can prune and the Sovereign can promote memory to town knowledge", async () => {
    const b = await boot();
    const t = await seedTown(b);
    const id = (await json(b.app, "GET", `/souls/${t.foreman}/memory`)).body.memories[0].memoryId;
    const promoted = await json(b.app, "POST", `/memories/${id}/promote`);
    expect(promoted.status).toBe(201);
    expect((await json(b.app, "GET", "/town/memory")).body.memories).toHaveLength(1);
    expect((await json(b.app, "POST", `/memories/${id}/prune`, { reason: "stale" })).status).toBe(
      200,
    );
    expect((await json(b.app, "GET", `/souls/${t.foreman}/memory`)).body.memories).toEqual([]);
    expect(b.daemon.ctx.log.read({ types: ["memory.pruned"] })[0]?.actor.kind).toBe("warden");
    expect((await json(b.app, "POST", `/memories/${id}/promote`)).status).toBe(404);
  });
});

describe("warbands and dispatch", () => {
  async function started() {
    const b = await boot();
    const t = await seedTown(b);
    const wb = await formWarband(b, t.foreman, [t.worker]);
    return { b, t, wb };
  }

  it("forms a warband on one backend group and watches it", async () => {
    const { b, wb } = await started();
    expect(wb.groupRef).toMatch(/^group_/);
    expect(b.daemon.coordinator.watching).toEqual([wb.groupRef]);
    const events = b.daemon.ctx.log.read({ types: ["warband.formed", "backend.group_created"] });
    expect(events.map((e) => e.type)).toEqual(["warband.formed", "backend.group_created"]);
    expect(payloads(b.daemon.ctx.log, "backend.group_created")[0]?.backend).toBe("fake");
  });

  it("dispatches a soul with persona, memory and skills in the spec, then settles it when the worker reports done", async () => {
    const { b, t, wb } = await started();
    b.lab.addSkill("tdd", "Write the failing test first.");
    await json(b.app, "POST", `/souls/${t.worker}/skills`, { name: "tdd" });
    // an episodic memory relevant to the brief
    b.daemon.ctx.log.append([
      {
        type: "memory.episodic_written",
        payload: {
          memory: {
            memoryId: "m_old",
            layer: "episodic",
            ownerSoulId: t.worker,
            text: "parser breaks on unicode escapes",
            tags: [],
            provenance: { author: "daemon", source: "test" },
          },
        },
        actor: { kind: "daemon" },
      },
    ]);

    const r = await json(
      b.app,
      "POST",
      `/warbands/${wb.warbandId}/dispatches`,
      dispatchBody(t.worker, { model: "opus", effort: "high" }),
    );
    expect(r.status).toBe(201);
    expect(r.body.injected.memoryIds).toContain("m_old");
    expect(r.body.injected.skills).toHaveLength(1);

    const call = b.backend.calls.find((c) => c.method === "startWorker");
    const input = call?.args[1] as {
      spec: string;
      agent: string;
      model: string;
      effort: string;
      placement: string;
      name: string;
    };
    expect(input).toMatchObject({
      agent: "claude",
      model: "opus",
      effort: "high",
      placement: "new-child",
      name: "Birchfist",
    });
    for (const s of [
      "Birchfist is careful",
      "unicode escapes",
      "Write the failing test first.",
      "# Acceptance",
    ])
      expect(input.spec).toContain(s);

    b.backend.pushMessage(wb.groupRef, doneMsg("m1", r.body.workerRef));
    await until(b.daemon.ctx.log, () => dispatchStates(b.db).every((st) => st === "settled"));

    const soul = (await json(b.app, "GET", `/souls/${t.worker}`)).body;
    expect(soul.soul.xp).toBe(10);
    expect(soul.skillUsage).toEqual([
      {
        skill: "tdd",
        uses: 1,
        succeeded: 1,
        failed: 0,
        unknown: 0,
        successRate: 1,
        injectedOnly: 1,
      },
    ]);
    expect(soul.skills[0]).toMatchObject({ name: "tdd", proficiency: expect.any(Number) });
    const detail = (await json(b.app, "GET", `/warbands/${wb.warbandId}`)).body;
    expect(detail.dispatches).toEqual([
      { dispatchId: r.body.dispatchId, soulId: t.worker, state: "settled", outcome: "succeeded" },
    ]);
    expect((await json(b.app, "GET", "/skills/usage")).body.usage[0]).toMatchObject({
      skill: "tdd",
      uses: 1,
      injectedOnly: 1,
    });
    const series = (await json(b.app, "GET", `/souls/${t.worker}/skills/tdd/proficiency`)).body
      .series;
    expect(series).toHaveLength(1);
  });

  it("refuses dispatches for non-members, unknown souls and inactive warbands", async () => {
    const { b, t, wb } = await started();
    const outsider = (
      await json(b.app, "POST", "/souls", {
        name: "Elmwright",
        species: "elf",
        ministryId: t.ministryId,
        persona: "p",
      })
    ).body.soul.soulId;
    expect(
      (await json(b.app, "POST", `/warbands/${wb.warbandId}/dispatches`, dispatchBody(outsider)))
        .status,
    ).toBe(409);
    expect(
      (await json(b.app, "POST", `/warbands/${wb.warbandId}/dispatches`, dispatchBody("ghost")))
        .status,
    ).toBe(404);
    expect(
      (
        await json(b.app, "POST", `/warbands/${wb.warbandId}/dispatches`, {
          soulId: t.worker,
          brief: { target: "x" },
        })
      ).status,
    ).toBe(400);
  });

  it("a failed worker start settles the dispatch as abandoned and surfaces the receipt; nothing is retried", async () => {
    const { b, t, wb } = await started();
    b.backend.failNext(
      "startWorker",
      new WorkerStartError("terminal did not start", "worker_start_failed", 1, "terminal_create", [
        { kind: "worktree" },
      ]),
    );
    const r = await json(
      b.app,
      "POST",
      `/warbands/${wb.warbandId}/dispatches`,
      dispatchBody(t.worker),
    );
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({
      error: "worker_start_failed",
      failedStage: "terminal_create",
      residualResources: [{ kind: "worktree" }],
    });
    const detail = (await json(b.app, "GET", `/warbands/${wb.warbandId}`)).body;
    expect(detail.dispatches[0]).toMatchObject({ state: "settled", outcome: "abandoned" });
    expect(b.backend.calls.filter((c) => c.method === "startWorker")).toHaveLength(1);
    expect((await json(b.app, "GET", `/souls/${t.worker}`)).body.soul.xp).toBe(0);
  });

  it("adopts a completion that arrives before the dispatch route has recorded the body", async () => {
    const { b, t, wb } = await started();
    const be = b.backend as FakeBackend;
    const realStart = be.startWorker.bind(be);
    be.startWorker = async (g, w) => {
      const worker = await realStart(g, w);
      be.pushMessage(g, doneMsg("early", worker.workerRef)); // worker finished while "starting"
      await until(
        b.daemon.ctx.log,
        () => b.daemon.ctx.log.read({ types: ["backend.worker_done"] }).length === 1,
      );
      return worker;
    };
    const r = await json(
      b.app,
      "POST",
      `/warbands/${wb.warbandId}/dispatches`,
      dispatchBody(t.worker),
    );
    expect(r.status).toBe(201);
    const detail = (await json(b.app, "GET", `/warbands/${wb.warbandId}`)).body;
    expect(detail.dispatches[0]).toMatchObject({ state: "settled", outcome: "succeeded" });
  });

  it("disbands only when every dispatch has settled, closing the group", async () => {
    const { b, t, wb } = await started();
    const d = (
      await json(b.app, "POST", `/warbands/${wb.warbandId}/dispatches`, dispatchBody(t.worker))
    ).body;
    const blocked = await json(b.app, "POST", `/warbands/${wb.warbandId}/disband`, {});
    expect(blocked.status).toBe(409);
    b.backend.pushMessage(wb.groupRef, doneMsg("m1", d.workerRef));
    await until(b.daemon.ctx.log, () => dispatchStates(b.db).every((st) => st === "settled"));
    const ok = await json(b.app, "POST", `/warbands/${wb.warbandId}/disband`, { reason: "done" });
    expect(ok.body.warband.status).toBe("disbanded");
    expect(b.backend.closedGroups).toEqual([wb.groupRef]);
    expect(b.daemon.coordinator.watching).toEqual([]);
    expect((await json(b.app, "POST", `/warbands/${wb.warbandId}/disband`, {})).status).toBe(409);
  });

  it("caps concurrent warbands with 429 and does not leak a backend group", async () => {
    const b = await boot({ maxGroups: 1 });
    const t = await seedTown(b);
    await formWarband(b, t.foreman, []);
    const r = await json(b.app, "POST", "/warbands", {
      objective: "second",
      foremanSoulId: t.worker,
    });
    expect(r.status).toBe(429);
    expect(b.backend.calls.filter((c) => c.method === "createGroup")).toHaveLength(1);
  });

  it("answers a worker question on its own group, once", async () => {
    const { b, wb } = await started();
    b.backend.pushMessage(wb.groupRef, {
      id: "q1",
      kind: "question",
      rawType: "question",
      text: "which database?",
    });
    await until(
      b.daemon.ctx.log,
      () => b.daemon.ctx.log.read({ types: ["question.asked"] }).length === 1,
    );
    const qid = payloads(b.daemon.ctx.log, "question.asked")[0]?.questionId;
    const r = await json(b.app, "POST", `/questions/${qid}/answer`, { answer: "postgres" });
    expect(r.status).toBe(200);
    expect(b.backend.replies).toEqual([
      { groupRef: wb.groupRef, messageId: "q1", text: "postgres" },
    ]);
    expect(
      (await json(b.app, "POST", `/questions/${qid}/answer`, { answer: "again" })).status,
    ).toBe(409);
    expect((await json(b.app, "POST", "/questions/nope/answer", { answer: "x" })).status).toBe(404);
  });

  it("resolves escalations once", async () => {
    const { b, wb } = await started();
    b.backend.pushMessage(wb.groupRef, {
      id: "e1",
      kind: "escalation",
      rawType: "escalation",
      text: "blocked on credentials",
    });
    await until(
      b.daemon.ctx.log,
      () => b.daemon.ctx.log.read({ types: ["escalation.raised"] }).length === 1,
    );
    const id = payloads(b.daemon.ctx.log, "escalation.raised")[0]?.escalationId;
    expect(
      (await json(b.app, "POST", `/escalations/${id}/resolve`, { resolution: "gave credentials" }))
        .status,
    ).toBe(200);
    expect(
      (await json(b.app, "POST", `/escalations/${id}/resolve`, { resolution: "again" })).status,
    ).toBe(409);
  });
});

describe("backend lifecycle", () => {
  it("starts degraded when the backend cannot be opened, refuses backend work, and recovers on /backend/connect", async () => {
    const { FakeBackend } = await import("@heartwood/core");
    const be = new FakeBackend();
    be.failNext("open", new Error("orca is not running"));
    const b = await boot({ backend: be });
    expect((await json(b.app, "GET", "/health")).body.backend).toMatchObject({
      status: "degraded",
      problems: ["orca is not running"],
    });
    expect(b.daemon.ctx.log.read({ types: ["backend.incompatible"] })[0]?.payload).toMatchObject({
      backend: "fake",
      problems: [expect.stringContaining("orca is not running")],
    });
    const t = await seedTown(b);
    expect(
      (await json(b.app, "POST", "/warbands", { objective: "x", foremanSoulId: t.foreman })).status,
    ).toBe(503);
    expect((await json(b.app, "POST", "/backend/connect")).body.status).toBe("ready");
    expect(
      (await json(b.app, "POST", "/warbands", { objective: "x", foremanSoulId: t.foreman })).status,
    ).toBe(201);
  });

  it("treats an incompatible backend as degraded and records why", async () => {
    const { FakeBackend } = await import("@heartwood/core");
    const be = new FakeBackend();
    be.info = {
      name: "fake",
      version: "0",
      compatible: false,
      problems: ["missing orchestration contract"],
    };
    const b = await boot({ backend: be });
    expect((await json(b.app, "GET", "/health")).body.backend.status).toBe("degraded");
    expect(b.daemon.ctx.log.read({ types: ["backend.incompatible"] })[0]?.payload).toMatchObject({
      problems: ["missing orchestration contract"],
    });
  });

  it("after a restart, resumes watching active warbands and keeps settling", async () => {
    const first = await boot();
    const t = await seedTown(first);
    const wb = await formWarband(first, t.foreman, [t.worker]);
    const d = (
      await json(first.app, "POST", `/warbands/${wb.warbandId}/dispatches`, dispatchBody(t.worker))
    ).body;
    await first.daemon.close();

    const second = await boot({ db: first.db, backend: first.backend });
    expect(second.daemon.coordinator.watching).toEqual([wb.groupRef]);
    first.backend.pushMessage(wb.groupRef, doneMsg("m1", d.workerRef));
    await until(second.daemon.ctx.log, () =>
      dispatchStates(second.db).every((st) => st === "settled"),
    );
    await second.daemon.close();
  });
});

describe("skills and Lab", () => {
  it("absorbs, analyzes and ranks through the Lab; evolve reports an unavailable rewriter as 501", async () => {
    const b = await boot();
    const t = await seedTown(b);
    const ref = b.lab.addSkill("tdd", "v1");
    b.lab.setScore(ref, 0.8);
    const abs = await json(b.app, "POST", `/souls/${t.worker}/skills`, { name: "tdd" });
    expect(abs.status).toBe(201);
    expect(abs.body.skill).toEqual({ name: "tdd", digest: ref.digest });
    expect((await json(b.app, "GET", "/skills")).body.skills).toHaveLength(1);
    await json(b.app, "POST", "/skills/analyze", { name: "tdd", digest: ref.digest });
    expect((await json(b.app, "GET", "/skills/ranks")).body.ranks).toEqual([
      {
        name: "tdd",
        digest: ref.digest,
        rank: "unique",
        score: 0.8,
        thresholdsVersion: "default-1",
      },
    ]);
    expect((await json(b.app, "GET", `/souls/${t.worker}`)).body.skills[0]).toMatchObject({
      rank: "unique",
    });
    const ev = await json(b.app, "POST", "/skills/evolve", { name: "tdd", digest: ref.digest });
    expect(ev.status).toBe(501);
    expect(ev.body.error).toBe("lab_unavailable");
  });

  it("without a Lab adapter every Lab operation fails loudly, never silently", async () => {
    const b = await boot({ lab: new UnavailableLab("not configured") });
    const t = await seedTown(b);
    const r = await json(b.app, "POST", `/souls/${t.worker}/skills`, { name: "tdd" });
    expect(r.status).toBe(501);
    expect(r.body.message).toContain("not configured");
    // a soul with no skills can still be dispatched
    const wb = await formWarband(b, t.foreman, [t.worker]);
    expect(
      (await json(b.app, "POST", `/warbands/${wb.warbandId}/dispatches`, dispatchBody(t.worker)))
        .status,
    ).toBe(201);
  });
});

describe("events API", () => {
  it("lists events after a seq, filtered by type, and rejects unknown types", async () => {
    const b: Booted = await boot();
    await seedTown(b);
    const all = (await json(b.app, "GET", "/events")).body;
    expect(all.events[0].type).toBe("town.founded");
    const souls = (await json(b.app, "GET", "/events?types=soul.named")).body.events;
    expect(souls.map((e: { type: string }) => e.type)).toEqual(["soul.named", "soul.named"]);
    const after = (await json(b.app, "GET", `/events?afterSeq=${all.events[0].seq}&limit=1`)).body
      .events;
    expect(after).toHaveLength(1);
    expect(after[0].seq).toBeGreaterThan(all.events[0].seq);
    expect((await json(b.app, "GET", "/events?types=nope.nope")).status).toBe(400);
  });
});
