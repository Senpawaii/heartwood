import {
  Health,
  Inbox,
  MinistriesResponse,
  ProficiencyResponse,
  SkillRanksResponse,
  SkillUsageResponse,
  SoulDetail,
  SoulMemoryResponse,
  SoulsResponse,
  TownSummary,
  WarbandDetail,
  WarbandsResponse,
} from "@heartwood/protocol";
import { describe, expect, it } from "vitest";
import { boot, brief, doneMsg, formWarband, json, seedTown, until } from "./testing.js";

/**
 * The web UI validates responses against these schemas; this keeps the daemon honest about them.
 * It drives a town into every state the UI renders, then parses each response.
 */
describe("API contract (shared response schemas)", () => {
  it("every response the UI reads conforms to @heartwood/protocol", async () => {
    const b = await boot();
    const t = await seedTown(b);
    const ref = b.lab.addSkill("tdd", "Write the test first.");
    b.lab.setScore(ref, 0.8);
    await json(b.app, "POST", `/souls/${t.worker}/skills`, { name: "tdd" });
    await json(b.app, "POST", "/skills/analyze", { name: "tdd", digest: ref.digest });
    const wb = await formWarband(b, t.foreman, [t.worker]);
    const d = await json(b.app, "POST", `/warbands/${wb.warbandId}/dispatches`, {
      soulId: t.worker,
      brief,
    });
    b.backend.pushMessage(wb.groupRef, {
      id: "q1",
      kind: "question",
      rawType: "question",
      text: "which db?",
      workerRef: d.body.workerRef,
    });
    b.backend.pushMessage(wb.groupRef, {
      id: "e1",
      kind: "escalation",
      rawType: "escalation",
      text: "blocked",
      workerRef: d.body.workerRef,
    });
    b.backend.pushMessage(wb.groupRef, doneMsg("m1", d.body.workerRef));
    await until(
      b.daemon.ctx.log,
      () => b.daemon.ctx.log.read({ types: ["dispatch.settled"] }).length === 1,
    );

    const get = async (url: string) => (await json(b.app, "GET", url)).body;
    expect(Health.parse(await get("/health")).backend.status).toBe("ready");
    expect(MinistriesResponse.parse(await get("/ministries")).ministries).toHaveLength(1);
    expect(SoulsResponse.parse(await get("/souls")).souls).toHaveLength(2);
    const detail = SoulDetail.parse(await get(`/souls/${t.worker}`));
    expect(detail.skills[0]).toMatchObject({ name: "tdd", rank: "unique" });
    expect(
      SoulMemoryResponse.parse(await get(`/souls/${t.worker}/memory`)).memories.length,
    ).toBeGreaterThan(1);
    expect(
      ProficiencyResponse.parse(await get(`/souls/${t.worker}/skills/tdd/proficiency`)).series,
    ).toHaveLength(1);
    expect(SkillUsageResponse.parse(await get("/skills/usage")).usage[0]).toMatchObject({
      skill: "tdd",
      injectedOnly: 1,
    });
    expect(SkillRanksResponse.parse(await get("/skills/ranks")).ranks).toHaveLength(1);
    expect(WarbandsResponse.parse(await get("/warbands")).warbands).toHaveLength(1);
    expect(WarbandDetail.parse(await get(`/warbands/${wb.warbandId}`)).dispatches[0]).toMatchObject(
      { state: "settled" },
    );
  });

  it("/inbox lists only unanswered questions and unresolved escalations; /town summarises", async () => {
    const b = await boot();
    const t = await seedTown(b);
    const wb = await formWarband(b, t.foreman, [t.worker]);
    b.backend.pushMessage(wb.groupRef, {
      id: "q1",
      kind: "question",
      rawType: "question",
      text: "which db?",
    });
    b.backend.pushMessage(wb.groupRef, {
      id: "q2",
      kind: "question",
      rawType: "question",
      text: "which cache?",
    });
    b.backend.pushMessage(wb.groupRef, {
      id: "e1",
      kind: "escalation",
      rawType: "escalation",
      text: "blocked on creds",
    });
    await until(
      b.daemon.ctx.log,
      () => b.daemon.ctx.log.read({ types: ["escalation.raised"] }).length === 1,
    );

    let inbox = Inbox.parse((await json(b.app, "GET", "/inbox")).body);
    expect(inbox.questions.map((q) => q.text)).toEqual(["which db?", "which cache?"]);
    expect(inbox.escalations[0]).toMatchObject({ reason: "blocked on creds", level: "foreman" });

    await json(b.app, "POST", `/questions/${inbox.questions[0]?.questionId}/answer`, {
      answer: "postgres",
    });
    await json(b.app, "POST", `/escalations/${inbox.escalations[0]?.escalationId}/resolve`, {
      resolution: "ok",
    });
    inbox = Inbox.parse((await json(b.app, "GET", "/inbox")).body);
    expect(inbox.questions.map((q) => q.text)).toEqual(["which cache?"]);
    expect(inbox.escalations).toEqual([]);

    const town = TownSummary.parse((await json(b.app, "GET", "/town")).body);
    expect(town).toMatchObject({
      name: "Heartwood",
      budget: null,
      counts: {
        souls: 2,
        ministries: 1,
        warbands: 1,
        activeWarbands: 1,
        openQuestions: 1,
        openEscalations: 0,
      },
    });
  });
});
