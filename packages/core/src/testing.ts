import type { EventPayloads, EventType, Species } from "@heartwood/protocol";
import type { LabCtx } from "./context.js";
import { openDb } from "./db.js";
import { createDispatch, type TaskBrief } from "./dispatch.js";
import { type EventLog, SqliteEventLog } from "./eventLog.js";
import { FakeLab } from "./fakeLab.js";
import { nameSoul } from "./progression.js";
import { defaultRules, type Rules } from "./rules.js";

export const brief = (target = "the parser"): TaskBrief => ({
  target,
  change: "fix the bug",
  constraints: "no new deps",
  ownership: "src/parser only",
  acceptance: "tests pass",
});

/** Test helper: an in-memory town with a fake Lab. */
export function makeTown(rules: Rules = defaultRules) {
  const db = openDb();
  const log = new SqliteEventLog(db, { rules });
  const lab = new FakeLab();
  const ctx: LabCtx = { db, log, rules, lab };
  let n = 0;
  return {
    ...ctx,
    lab,
    ctx,
    addSoul(name: string, species: Species = "dwarf"): string {
      return nameSoul(ctx, {
        name,
        species,
        ministryId: "m1",
        persona: `${name} is careful.`,
        soulId: `soul_${name}`,
      });
    },
    formWarband(
      foreman: string,
      members: string[] = [],
      groupRef = `run_${++n}`,
    ): { warbandId: string; groupRef: string } {
      const warbandId = `wb_${++n}`;
      log.append([
        {
          type: "warband.formed",
          payload: {
            warbandId,
            objective: "ship it",
            foremanSoulId: foreman,
            members: [
              { soulId: foreman, role: "foreman" },
              ...members.map((m) => ({ soulId: m, role: "member" as const })),
            ],
          },
          actor: { kind: "daemon" },
          correlation: { warbandId },
        },
        {
          type: "backend.group_created",
          payload: { warbandId, backend: "fake", groupRef, objective: "ship it" },
          actor: { kind: "backend" },
          correlation: { warbandId, groupRef },
        },
      ]);
      return { warbandId, groupRef };
    },
    /** Create a dispatch and start a worker body for it. */
    async dispatch(warbandId: string, soulId: string, workerId: string, b = brief()) {
      const d = await createDispatch(ctx, { warbandId, soulId, brief: b });
      const bodyId = `body_${workerId}`;
      log.append([
        {
          type: "body.spawned",
          payload: {
            bodyId,
            soulId,
            dispatchId: d.dispatchId,
            workerRef: workerId,
            agent: "claude",
            worktree: "new-child",
          },
          actor: { kind: "daemon" },
          correlation: { soulId, dispatchId: d.dispatchId },
        },
        {
          type: "dispatch.started",
          payload: { dispatchId: d.dispatchId, bodyId },
          actor: { kind: "daemon" },
          correlation: { dispatchId: d.dispatchId },
        },
      ]);
      return { ...d, bodyId };
    },
  };
}

/** Resolves once `cond` holds, re-checking after every committed event (no polling, no timers). */
export function until(log: EventLog, cond: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (cond()) return resolve();
    const off = log.subscribe(() => {
      if (cond()) {
        off();
        resolve();
      }
    });
  });
}

/** Payloads of every event of one type, typed by that event type. */
export function payloads<T extends EventType>(log: EventLog, type: T): EventPayloads[T][] {
  // read({ types: [type] }) only returns events of that type, so each payload has that type's shape
  return log.read({ types: [type] }).map((e) => e.payload as EventPayloads[T]);
}
