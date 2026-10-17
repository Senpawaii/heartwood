import type { Actor, HeartwoodEvent, NewEvent, Species } from "@heartwood/protocol";
import { ulid } from "ulid";
import type { Ctx } from "./context.js";
import { getSoul } from "./queries.js";
import { levelForXp, rankForLevel } from "./rules.js";

/** Name an agent: creates its character and records the (display-only) budget it cost. */
export function nameSoul(
  ctx: Ctx,
  o: {
    name: string;
    species: Species;
    ministryId: string;
    persona: string;
    magiculesSpent?: number;
    soulId?: string;
  },
): string {
  const soulId = o.soulId ?? `soul_${ulid()}`;
  ctx.log.append([
    {
      type: "soul.named",
      payload: {
        soulId,
        name: o.name,
        species: o.species,
        ministryId: o.ministryId,
        persona: o.persona,
        magiculesSpent: o.magiculesSpent ?? 0,
      },
      actor: { kind: "sovereign" },
      correlation: { soulId },
    },
  ]);
  return soulId;
}

/** Grant XP and emit the derived `leveled` / `ranked` notifications when thresholds are crossed. */
export function grantXp(
  ctx: Ctx,
  o: {
    soulId: string;
    amount: number;
    reason: "task" | "foreman_bonus" | "mentoring" | "other";
    dispatchId?: string;
    warbandId?: string;
  },
): HeartwoodEvent[] {
  if (o.amount <= 0) return [];
  return ctx.log.transaction(() => {
    const soul = getSoul(ctx.db, o.soulId, ctx.rules);
    if (!soul) throw new Error(`unknown soul: ${o.soulId}`);
    const actor: Actor = { kind: "daemon" };
    const correlation = {
      soulId: o.soulId,
      ...(o.warbandId ? { warbandId: o.warbandId } : {}),
      ...(o.dispatchId ? { dispatchId: o.dispatchId } : {}),
    };
    const events: NewEvent[] = [
      {
        type: "soul.xp_gained",
        payload: { soulId: o.soulId, amount: o.amount, reason: o.reason, dispatchId: o.dispatchId },
        actor,
        correlation,
      },
    ];
    const xp = soul.xp + o.amount;
    const toLevel = levelForXp(xp, ctx.rules);
    if (toLevel > soul.level) {
      events.push({
        type: "soul.leveled",
        payload: { soulId: o.soulId, fromLevel: soul.level, toLevel, xp },
        actor,
        correlation,
      });
      const rank = rankForLevel(toLevel, ctx.rules);
      if (rank !== soul.rank) {
        events.push({
          type: "soul.ranked",
          payload: { soulId: o.soulId, previousRank: soul.rank, rank },
          actor,
          correlation,
        });
      }
    }
    return ctx.log.append(events);
  });
}

/** Species evolution: unlocked by level, changes the soul's form. */
export function evolveSoul(ctx: Ctx, soulId: string): HeartwoodEvent[] {
  const soul = getSoul(ctx.db, soulId, ctx.rules);
  if (!soul) throw new Error(`unknown soul: ${soulId}`);
  if (soul.level < ctx.rules.evolution.minLevel)
    throw new Error(
      `${soul.name} needs level ${ctx.rules.evolution.minLevel} to evolve (is ${soul.level})`,
    );
  const toForm = ctx.rules.evolution.forms[soul.species];
  if (soul.form === toForm) throw new Error(`${soul.name} already evolved`);
  return ctx.log.append([
    {
      type: "soul.evolved",
      payload: { soulId, fromForm: soul.form, toForm },
      actor: { kind: "daemon" },
      correlation: { soulId },
    },
  ]);
}

/**
 * Awakening is rare and needs proof: `proof.ref` must be the id of an existing event that
 * actually proves it (a `skill.analyzed` benchmark, or a successfully settled dispatch).
 */
export function awakenSoul(
  ctx: Ctx,
  o: { soulId: string; title: string; proof: { kind: "benchmark" | "project"; ref: string } },
): HeartwoodEvent[] {
  if (!getSoul(ctx.db, o.soulId, ctx.rules)) throw new Error(`unknown soul: ${o.soulId}`);
  const row = ctx.db.prepare("SELECT type, payload FROM events WHERE id = ?").get(o.proof.ref) as
    | { type: string; payload: string }
    | undefined;
  if (!row) throw new Error(`awakening proof not found: ${o.proof.ref}`);
  const payload = JSON.parse(row.payload);
  const ok =
    o.proof.kind === "benchmark"
      ? row.type === "skill.analyzed"
      : row.type === "dispatch.settled" && payload.outcome === "succeeded";
  if (!ok) throw new Error(`event ${o.proof.ref} (${row.type}) is not valid ${o.proof.kind} proof`);
  return ctx.log.append([
    {
      type: "soul.awakened",
      payload: { soulId: o.soulId, title: o.title, proof: o.proof },
      actor: { kind: "sovereign" },
      correlation: { soulId: o.soulId },
    },
  ]);
}
