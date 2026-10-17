import {
  createDispatch,
  DomainError,
  getQuestion,
  getSoul,
  getWarband,
  listOpenEscalations,
  listOpenQuestions,
  listWarbands,
  NotFoundError,
  type StartedWorker,
  settleDispatch,
  townBudget,
  townCounts,
  townName,
} from "@heartwood/core";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import { type DaemonContext, HttpError } from "../daemon.js";

const NewWarband = z.object({
  objective: z.string().min(1),
  foremanSoulId: z.string().min(1),
  memberSoulIds: z.array(z.string().min(1)).default([]),
});
const NewDispatch = z.object({
  soulId: z.string().min(1),
  brief: z.object({
    target: z.string().min(1),
    change: z.string().min(1),
    constraints: z.string().min(1),
    ownership: z.string().min(1),
    acceptance: z.string().min(1),
  }),
  agent: z.string().min(1).default("claude"),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  placement: z.string().min(1).default("new-child"),
  k: z.number().int().min(0).max(20).optional(),
});
const Disband = z.object({ reason: z.string().min(1).default("project complete") });
const Answer = z.object({ answer: z.string().min(1) });
const Resolution = z.object({ resolution: z.string().min(1) });

export function registerWarbandRoutes(app: FastifyInstance, d: DaemonContext): void {
  const { ctx, backend, coordinator } = d;

  const requireBackend = () => {
    const s = d.backendState();
    if (s.status !== "ready")
      throw new HttpError(
        503,
        "backend_unavailable",
        `backend is ${s.status}; POST /backend/connect to retry`,
      );
  };
  const warbandOr404 = (id: string) => {
    const w = getWarband(ctx.db, id);
    if (!w) throw new NotFoundError(`unknown warband: ${id}`);
    return w;
  };
  const activeSoul = (id: string) => {
    const s = getSoul(ctx.db, id, ctx.rules);
    if (!s) throw new NotFoundError(`unknown soul: ${id}`);
    if (s.status !== "active") throw new DomainError(`${s.name} is ${s.status}`);
    return s;
  };

  /** Everything waiting on the Sovereign: unanswered worker questions and unresolved escalations. */
  app.get("/inbox", async () => ({
    questions: listOpenQuestions(ctx.db),
    escalations: listOpenEscalations(ctx.db),
  }));

  app.get("/town", async () => {
    const c = townCounts(ctx.db);
    return {
      name: townName(ctx.db),
      budget: townBudget(ctx.db) ?? null,
      magiculesSpent: c.magiculesSpent,
      counts: {
        souls: c.souls,
        ministries: c.ministries,
        warbands: c.warbands,
        activeWarbands: c.activeWarbands,
        openQuestions: listOpenQuestions(ctx.db).length,
        openEscalations: listOpenEscalations(ctx.db).length,
      },
    };
  });

  app.get("/warbands", async () => ({ warbands: listWarbands(ctx.db) }));

  app.get<{ Params: { id: string } }>("/warbands/:id", async (req) => {
    const warband = warbandOr404(req.params.id);
    const dispatches = ctx.db
      .prepare(
        "SELECT dispatch_id AS dispatchId, soul_id AS soulId, state, outcome FROM dispatches WHERE warband_id = ? ORDER BY rowid",
      )
      .all(warband.warbandId);
    return { warband, dispatches };
  });

  /** Form a warband: one backend group (an Orca Run) per team, watched by the coordinator. */
  app.post("/warbands", async (req, reply) => {
    requireBackend();
    const b = NewWarband.parse(req.body);
    const memberIds = [...new Set(b.memberSoulIds.filter((m) => m !== b.foremanSoulId))];
    activeSoul(b.foremanSoulId);
    for (const m of memberIds) activeSoul(m);
    if (!coordinator.hasCapacity)
      throw new HttpError(429, "group_limit", "too many concurrent warbands");

    const warbandId = `wb_${ulid()}`;
    const { groupRef } = await backend.createGroup(b.objective);
    try {
      ctx.log.append([
        {
          type: "warband.formed",
          payload: {
            warbandId,
            objective: b.objective,
            foremanSoulId: b.foremanSoulId,
            members: [
              { soulId: b.foremanSoulId, role: "foreman" },
              ...memberIds.map((soulId) => ({ soulId, role: "member" as const })),
            ],
          },
          actor: { kind: "sovereign" },
          correlation: { warbandId },
        },
        {
          type: "backend.group_created",
          payload: { warbandId, backend: backend.name, groupRef, objective: b.objective },
          actor: { kind: "daemon" },
          correlation: { warbandId, groupRef },
        },
      ]);
      coordinator.start(groupRef);
    } catch (err) {
      await backend.closeGroup(groupRef).catch(() => undefined); // do not leak the group's resources
      throw err;
    }
    return reply.status(201).send({ warband: warbandOr404(warbandId) });
  });

  /**
   * Dispatch a task to one soul of the warband: compose its spec (persona, top-k memories, absorbed
   * skills), start a disposable body, and record it. A failed start settles the dispatch as abandoned
   * and is reported with the backend's receipt; it is never retried automatically.
   */
  app.post<{ Params: { id: string } }>("/warbands/:id/dispatches", async (req, reply) => {
    requireBackend();
    const b = NewDispatch.parse(req.body);
    const wb = warbandOr404(req.params.id);
    if (wb.status !== "active" || !wb.groupRef)
      throw new DomainError(`warband ${wb.warbandId} is ${wb.status}`);
    const soul = activeSoul(b.soulId);
    if (!wb.members.some((m) => m.soulId === soul.soulId))
      throw new DomainError(`${soul.name} is not a member of this warband`);

    const dispatch = await createDispatch(ctx, {
      warbandId: wb.warbandId,
      soulId: soul.soulId,
      brief: b.brief,
      k: b.k,
    });
    let worker: StartedWorker;
    try {
      worker = await backend.startWorker(wb.groupRef, {
        spec: dispatch.spec,
        agent: b.agent,
        model: b.model,
        effort: b.effort,
        placement: b.placement,
        name: soul.name,
      });
    } catch (err) {
      settleDispatch(ctx, {
        dispatchId: dispatch.dispatchId,
        outcome: "abandoned",
        summary: `worker failed to start: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
    const { bodyId } = await coordinator.registerWorker({
      groupRef: wb.groupRef,
      soulId: soul.soulId,
      dispatchId: dispatch.dispatchId,
      worker,
      agent: b.agent,
      model: b.model,
      placement: b.placement,
    });
    return reply.status(201).send({
      dispatchId: dispatch.dispatchId,
      bodyId,
      workerRef: worker.workerRef,
      startState: worker.state,
      injected: { memoryIds: dispatch.memoryIds, skills: dispatch.skills },
    });
  });

  app.post<{ Params: { id: string } }>("/warbands/:id/disband", async (req) => {
    const b = Disband.parse(req.body ?? {});
    const wb = warbandOr404(req.params.id);
    if (wb.status !== "active")
      throw new DomainError(`warband ${wb.warbandId} is already ${wb.status}`);
    const open = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM dispatches WHERE warband_id = ? AND state != 'settled'")
      .get(wb.warbandId) as { c: number };
    if (open.c > 0) throw new DomainError(`${open.c} dispatch(es) are still unsettled`);
    if (wb.groupRef) await coordinator.close(wb.groupRef);
    ctx.log.append([
      {
        type: "warband.disbanded",
        payload: { warbandId: wb.warbandId, reason: b.reason },
        actor: { kind: "sovereign" },
        correlation: { warbandId: wb.warbandId },
      },
    ]);
    return { warband: warbandOr404(wb.warbandId) };
  });

  /** Answer a worker's question on the group it came from. */
  app.post<{ Params: { id: string } }>("/questions/:id/answer", async (req) => {
    requireBackend();
    const b = Answer.parse(req.body);
    const q = getQuestion(ctx.db, req.params.id);
    if (!q) throw new NotFoundError(`unknown question: ${req.params.id}`);
    if (q.answered) throw new DomainError("question is already answered");
    await backend.reply(q.groupRef, q.messageId, b.answer);
    ctx.log.append([
      {
        type: "question.answered",
        payload: { questionId: q.questionId, answer: b.answer },
        actor: { kind: "sovereign" },
        correlation: { groupRef: q.groupRef },
      },
    ]);
    return { answered: q.questionId };
  });

  app.post<{ Params: { id: string } }>("/escalations/:id/resolve", async (req) => {
    const b = Resolution.parse(req.body);
    const raised = ctx.db
      .prepare(
        "SELECT 1 FROM events WHERE type = 'escalation.raised' AND json_extract(payload, '$.escalationId') = ?",
      )
      .get(req.params.id);
    if (!raised) throw new NotFoundError(`unknown escalation: ${req.params.id}`);
    const done = ctx.db
      .prepare(
        "SELECT 1 FROM events WHERE type = 'escalation.resolved' AND json_extract(payload, '$.escalationId') = ?",
      )
      .get(req.params.id);
    if (done) throw new DomainError("escalation is already resolved");
    ctx.log.append([
      {
        type: "escalation.resolved",
        payload: { escalationId: req.params.id, resolution: b.resolution },
        actor: { kind: "sovereign" },
      },
    ]);
    return { resolved: req.params.id };
  });
}
