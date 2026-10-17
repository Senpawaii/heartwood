import type { Species } from "@heartwood/protocol";
import type { LabCtx } from "./context.js";
import { openDb } from "./db.js";
import { createDispatch, type TaskBrief } from "./dispatch.js";
import { SqliteEventLog } from "./eventLog.js";
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
      runId = `run_${++n}`,
    ): { warbandId: string; runId: string } {
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
          type: "orca.run_created",
          payload: { warbandId, runId, objective: "ship it" },
          actor: { kind: "orca" },
          correlation: { warbandId, runId },
        },
      ]);
      return { warbandId, runId };
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
            orcaWorkerId: workerId,
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
