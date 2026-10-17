import { createHash } from "node:crypto";
import type { NewEvent, PinnedSkill } from "@heartwood/protocol";
import { ulid } from "ulid";
import type { Ctx, LabCtx } from "./context.js";
import { episodicEvent, personaFor, retrieveMemories, type ScoredMemory } from "./memory/store.js";
import { grantXp } from "./progression.js";
import { getDispatch } from "./queries.js";

/** Orca task specs must be self-contained: these are the five required sections. */
export interface TaskBrief {
  target: string;
  change: string;
  constraints: string;
  ownership: string;
  acceptance: string;
}

export function composeSpec(o: {
  brief: TaskBrief;
  persona?: string;
  memories: readonly ScoredMemory[];
  skillBlock: string;
}): string {
  const parts: string[] = [];
  if (o.persona) parts.push(`# Who you are\n${o.persona.trim()}`);
  parts.push(
    `# Target\n${o.brief.target}`,
    `# Change\n${o.brief.change}`,
    `# Constraints\n${o.brief.constraints}`,
    `# Ownership\n${o.brief.ownership}`,
    `# Acceptance\n${o.brief.acceptance}`,
  );
  if (o.memories.length)
    parts.push(
      `# What you remember (most relevant first)\n${o.memories.map((m) => `- [${m.memory.layer}] ${m.memory.text.trim()}`).join("\n")}`,
    );
  if (o.skillBlock) parts.push(`# Skills you have absorbed\n${o.skillBlock}`);
  return parts.join("\n\n");
}

export interface CreatedDispatch {
  dispatchId: string;
  spec: string;
  skills: PinnedSkill[];
  memoryIds: string[];
}

/**
 * Build the task spec for a soul: persona (always), top-k relevant memories, and its absorbed
 * skills. Records `dispatch.created` and `memory.injected`.
 */
export async function createDispatch(
  ctx: LabCtx,
  o: { warbandId: string; soulId: string; brief: TaskBrief; k?: number; taskRef?: string },
): Promise<CreatedDispatch> {
  const query = Object.values(o.brief).join("\n");
  const memories = retrieveMemories(ctx.db, { soulId: o.soulId, query, k: o.k ?? 5 });
  const skills = (
    ctx.db
      .prepare("SELECT name, digest FROM soul_skills WHERE soul_id = ? ORDER BY name")
      .all(o.soulId) as PinnedSkill[]
  ).map((s) => ({ name: s.name, digest: s.digest }));
  const skillBlock = await ctx.lab.renderForTask(skills);
  const spec = composeSpec({
    brief: o.brief,
    persona: personaFor(ctx.db, o.soulId),
    memories,
    skillBlock,
  });

  const dispatchId = `disp_${ulid()}`;
  const memoryIds = memories.map((m) => m.memory.memoryId);
  const correlation = { warbandId: o.warbandId, soulId: o.soulId, dispatchId };
  const events: NewEvent[] = [
    {
      type: "dispatch.created",
      payload: {
        dispatchId,
        warbandId: o.warbandId,
        soulId: o.soulId,
        specHash: createHash("sha256").update(spec).digest("hex"),
        memoryIds,
        skills,
        taskRef: o.taskRef,
      },
      actor: { kind: "foreman" },
      correlation,
    },
  ];
  if (memories.length)
    events.push({
      type: "memory.injected",
      payload: {
        dispatchId,
        soulId: o.soulId,
        items: memories.map((m) => ({ memoryId: m.memory.memoryId, score: m.score })),
      },
      actor: { kind: "daemon" },
      correlation,
    });
  ctx.log.append(events);
  return { dispatchId, spec, skills, memoryIds };
}

/**
 * Settle a dispatch exactly once: outcome, skill usage (evidence "injected"), episodic memory
 * and XP — all in one transaction. Returns false if it was already settled (idempotent).
 */
export function settleDispatch(
  ctx: Ctx,
  o: {
    dispatchId: string;
    outcome: "succeeded" | "failed" | "abandoned";
    summary?: string;
    causedBy?: string;
  },
): boolean {
  return ctx.log.transaction(() => {
    const d = getDispatch(ctx.db, o.dispatchId);
    if (!d) throw new Error(`unknown dispatch: ${o.dispatchId}`);
    if (d.state === "settled") return false;
    const correlation = { warbandId: d.warbandId, soulId: d.soulId, dispatchId: d.dispatchId };
    const usageOutcome = o.outcome === "abandoned" ? "unknown" : o.outcome;
    const events: NewEvent[] = [
      {
        type: "dispatch.settled",
        payload: { dispatchId: d.dispatchId, outcome: o.outcome, summary: o.summary },
        actor: { kind: "daemon" },
        correlation,
        causedBy: o.causedBy,
      },
      ...d.skills.map(
        (skill): NewEvent => ({
          type: "skill.used",
          payload: {
            soulId: d.soulId,
            skill,
            dispatchId: d.dispatchId,
            outcome: usageOutcome,
            evidence: "injected",
          },
          actor: { kind: "daemon" },
          correlation,
        }),
      ),
      episodicEvent({
        soulId: d.soulId,
        dispatchId: d.dispatchId,
        text: `Task ${o.outcome}${o.summary ? `: ${o.summary}` : "."}`,
        tags: [o.outcome, ...d.skills.map((s) => s.name)],
      }),
    ];
    ctx.log.append(events);

    const xp = ctx.rules.xp;
    if (o.outcome !== "abandoned") {
      grantXp(ctx, {
        soulId: d.soulId,
        amount: o.outcome === "succeeded" ? xp.taskSuccess : xp.taskFailure,
        reason: "task",
        dispatchId: d.dispatchId,
        warbandId: d.warbandId,
      });
    }
    if (o.outcome === "succeeded") awardForemanBonus(ctx, d.warbandId, d.soulId, d.dispatchId);
    return true;
  });
}

/**
 * The foreman Soul earns a small separate bonus per member success, capped per warband, so it
 * is not credited with the members' work (nor with decisions the daemon made). Not paid for its own tasks.
 */
function awardForemanBonus(
  ctx: Ctx,
  warbandId: string,
  workerSoulId: string,
  dispatchId: string,
): void {
  const wb = ctx.db
    .prepare("SELECT foreman_soul_id AS f FROM warbands WHERE warband_id = ?")
    .get(warbandId) as { f: string } | undefined;
  if (!wb || wb.f === workerSoulId) return;
  const given = (
    ctx.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM xp_ledger WHERE warband_id = ? AND reason = 'foreman_bonus'",
      )
      .get(warbandId) as { s: number }
  ).s;
  const amount = Math.min(
    ctx.rules.xp.foremanPerSuccess,
    ctx.rules.xp.foremanCapPerWarband - given,
  );
  if (amount > 0)
    grantXp(ctx, { soulId: wb.f, amount, reason: "foreman_bonus", dispatchId, warbandId });
}
